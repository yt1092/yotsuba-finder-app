// データの書き出しと読み込みの、IndexedDB との読み書き（形の確かめと、何を書くかは src/lib/backup.ts）
// 読み込みは 1 つのトランザクションで書く。途中で失敗したら、ブラウザが全部を元に戻す（何も書きかわらない）
import { FEEDBACK_STORE, GACHA_STORE, PROGRESS_STORE, getAllGacha, getAllRecords, openDb, reserveId, type CloverRecord } from './db';
import { idToSkipPast } from './gacha-list';
import { allFeedback } from './feedback-db';
import { getSaveMode, setSaveMode } from './save-mode';
import { base64ToBuffer, buildBackup, planImport, remapFeedbackKey, type BackupData, type ImportMode, type ImportPlan } from './backup';
import type { Progress } from './progress';
import type { TuningState } from './tuning-db';

const RECORDS = 'records';
const LAST_PHOTO = 'lastPhoto'; // 最後に調べた写真（上書きのときは消す。前の図鑑の記録を指しているため）

function getProgressItem<T>(id: string): Promise<T | null> {
  return openDb().then(db => new Promise<T | null>((resolve, reject) => {
    const req = db.transaction(PROGRESS_STORE, 'readonly').objectStore(PROGRESS_STORE).get(id);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
  }));
}

// 書き出す中身を作る（写真を入れるかは withPhotos）
export async function collectBackup(withPhotos: boolean): Promise<BackupData> {
  const [records, gacha, feedback, progress, tuning] = await Promise.all([
    getAllRecords(), getAllGacha(), allFeedback(), getProgressItem<Progress>('me'), getProgressItem<TuningState>('tuning'),
  ]);
  return buildBackup({ records, gacha, feedback, progress, tuning, settings: { saveMode: getSaveMode() } },
    { withPhotos, now: Date.now(), appVersion: __APP_VERSION__ });
}

// 写真の代わりの絵（写真なしで書き出したファイルから読み込んだ記録に入れる。四つ葉の形と、うすい緑）
let missingImage = '';
export function missingPhotoImage(): string {
  if (missingImage) return missingImage;
  const size = 480;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#DCEBCF';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#9CC28A';
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    g.beginPath();
    g.arc(size / 2 + Math.cos(a) * 58, size / 2 + Math.sin(a) * 58, 62, 0, Math.PI * 2);
    g.fill();
  }
  missingImage = canvas.toDataURL('image/png');
  return missingImage;
}

// 足すときに、同じ記録かを見るための、今の記録とまちがいの記録の名前
async function currentKeys(): Promise<{ records: CloverRecord[]; feedbackKeys: string[] }> {
  const [photos, gacha, feedback] = await Promise.all([getAllRecords(), getAllGacha(), allFeedback()]);
  return { records: [...photos, ...gacha], feedbackKeys: feedback.map(f => f.key) };
}

export async function makeImportPlan(data: BackupData, mode: ImportMode): Promise<ImportPlan> {
  const cur = await currentKeys();
  return planImport(data, mode, cur.records, cur.feedbackKeys);
}

// 書く。全部を 1 つのトランザクションで書き、どこかで失敗したら、全部を取り消す（abort）
export async function applyImport(plan: ImportPlan): Promise<{ added: number }> {
  const db = await openDb();
  const placeholder = plan.records.some(r => r.record.photoMissing) ? missingPhotoImage() : '';
  const stores = [RECORDS, GACHA_STORE, FEEDBACK_STORE, PROGRESS_STORE, ...(db.objectStoreNames.contains(LAST_PHOTO) ? [LAST_PHOTO] : [])];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('書けませんでした'));
    tx.onabort = () => reject(tx.error ?? new Error('取り消しました'));
    const fail = (e: unknown) => { try { tx.abort(); } catch { /* すでに終わっている */ } reject(e); };
    try {
      const recStore = tx.objectStore(RECORDS);
      const fbStore = tx.objectStore(FEEDBACK_STORE);
      const progStore = tx.objectStore(PROGRESS_STORE);
      const gachaStore = tx.objectStore(GACHA_STORE);
      if (plan.mode === 'replace') {
        recStore.clear();
        gachaStore.clear();
        fbStore.clear();
        progStore.delete('me');
        progStore.delete('tuning');
        if (stores.includes(LAST_PHOTO)) tx.objectStore(LAST_PHOTO).clear();
      }
      if (plan.progress !== 'keep' && plan.progress) progStore.put(plan.progress);
      if (plan.tuning !== 'keep' && plan.tuning) progStore.put(plan.tuning);

      // 記録を書き、足したあとの id が分かってから、まちがいの記録を書く（名前の record:<id> を直すため）
      const ids = new Map<number, number>();
      const writeFeedback = () => {
        try {
          for (const f of plan.feedback) {
            const key = remapFeedbackKey(f.key, ids, plan.mode);
            if (key === null) continue;
            fbStore.put({ ...f, key, photo: base64ToBuffer(f.photo) });
          }
        } catch (e) { fail(e); }
      };
      // 今日のよつば: 上書きは id のまま書き、図鑑の番号をその先へ進める（あとで足す写真と id が重ならないように）。
      // 足すは、図鑑と同じ番号の並びから id を取る（src/lib/db.ts の reserveId）
      if (plan.mode === 'replace') {
        for (const { record } of plan.gacha) gachaStore.put(record);
        const skip = idToSkipPast(plan.records.map(r => r.record.id).filter((id): id is number => id !== undefined),
          plan.gacha.map(g => g.record.id).filter((id): id is number => id !== undefined));
        if (skip !== null) { recStore.put({ id: skip, date: 0, reserved: true }); recStore.delete(skip); }
      } else {
        for (const { record } of plan.gacha) reserveId(tx, id => gachaStore.add({ ...record, id }));
      }

      let left = plan.records.length;
      if (left === 0) writeFeedback();
      for (const { oldId, record } of plan.records) {
        const rec = record.photoMissing ? { ...record, imageDataUrl: placeholder } : record;
        const req = plan.mode === 'replace' ? recStore.put(rec) : recStore.add(rec);
        req.onsuccess = () => {
          if (oldId !== undefined) ids.set(oldId, req.result as number);
          if (--left === 0) writeFeedback();
        };
      }
    } catch (e) {
      fail(e);
    }
  });
  // 設定は、トランザクションが終わってから（localStorage）
  if (plan.settings !== 'keep') setSaveMode(plan.settings.saveMode);
  return { added: plan.records.length + plan.gacha.length };
}

// ── 最後に書き出した日（設定に、静かに出す。催促はしない）──

const LAST_EXPORT_KEY = 'yotsuba-last-export';

export function lastExportAt(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_EXPORT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function markExported(at = Date.now()): void {
  try {
    localStorage.setItem(LAST_EXPORT_KEY, String(at));
  } catch { /* 残せなくても、書き出しは済んでいる */ }
}
