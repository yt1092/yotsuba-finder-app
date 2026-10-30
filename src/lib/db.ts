// IndexedDB を使って発見記録を永続化する
// 旧アプリ名のままにしている（変えると既存の図鑑データが読めなくなる）
const DB_NAME = 'yotsuba-hunter';
const STORE = 'records';
// 版 2: まちがいの報告（feedback）と、最後に調べた写真（lastPhoto）の入れ物を足した
// 版 3: 「メモ」を「ひとこと」に 1 つにまとめた（今あるメモは、ひとことに引き継ぐ）
// 版 4: レベル・経験値・バッジの入れ物（progress）を足した。記録に手書き（ink）を持てるようにした（今ある記録はそのまま）
// 版 5: 「今日のよつば」の入れ物（gacha）を足し、図鑑の入れ物にあった今日のよつばを、そこへ移した（移す前の元の値は progress に残す）
const VER = 5;
export const FEEDBACK_STORE = 'feedback';   // まちがいの報告（src/lib/feedback-db.ts）。key は写真ごとの名前
const LAST_PHOTO_STORE = 'lastPhoto';       // 写真から探すで、最後に調べた写真（四つ葉が無かった画面でも、写真を出すため）
export const PROGRESS_STORE = 'progress';   // レベル・経験値・バッジ（src/lib/progress-db.ts）。1 件だけ（id: 'me'）
export const GACHA_STORE = 'gacha';         // 今日のよつばの一覧（src/lib/gacha-list.ts）。ID は図鑑の記録と同じ番号の並びから取る（reserveId）

import type { Detection } from './detector';
import type { LeafCounts } from './leaf-count';
import { mergeNote } from './diary-text';
import type { Ink } from './ink';
import type { Crop } from './crop';
import { requestPersist } from './persist';
import { moveGacha } from './gacha-move';
import { recordStoreOf } from './gacha-list';

// 保存する記録の型
// detections・counts は、あとから足した項目（それより前の記録には無い）
export interface CloverRecord {
  id?: number;
  date: number;         // Unix タイムスタンプ（ms）
  imageDataUrl: string; // Base64 エンコードされた画像
  label: '四つ葉' | '三つ葉';
  source: 'camera' | 'photo' | 'gacha'; // gacha = 「今日のよつば」（見つけた四つ葉ではない。src/pages/gacha.ts）
  detections?: Detection[]; // そのときの検出結果（しきい値と重なりの整理が済んだ枠。写真の座標）
  counts?: LeafCounts;      // 写真から探したときの、三つ葉と四つ葉の本数
  note?: string;            // ひとこと（使う人が入力。80 文字まで。日記カードにも書く。版 3 より前の「メモ」もここに入っている）
  ink?: Ink;                // 日記カードの手書き（線とシール。カードの中の位置を 0〜1 にしたもの。src/lib/ink.ts）
  diaryTheme?: 'cream' | 'green'; // 手書きを書いたときの、日記カードの色（図鑑の詳細の見本に使う）
  gachaDay?: string;    // 「今日のよつば」の日付（日本時間。'2026-10-27'）。同じ日の形を 2 回入れないため
  gachaKind?: 'dit' | 'preset'; // 「今日のよつば」の形の出どころ（dit = 端末の中の小さなモデル・preset = あらかじめ作った形。無いのは試作のころの記録 = preset）
  shape64?: string;     // 「今日のよつば」の一覧に出す形（64×64 の PNG。src/lib/gacha-thumb.ts。版 5 より前の記録は、一覧を開いたときに作る）
  crop?: Crop;             // 四つ葉のまわりで切り抜いた範囲（元の写真の座標。2026-10-30 から。それより前の記録は、全体の写真のまま。src/lib/crop.ts）
  photoMissing?: boolean; // 写真なしで書き出したファイルから読み込んだ記録（写真の代わりの絵が入っている。src/lib/backup.ts）
}

// 最後に調べた写真（1 件だけ。新しく調べるたびに置きかえる）
export interface LastPhoto {
  id: 'last';
  date: number;
  imageDataUrl: string;
  detections: Detection[];
  counts: LeafCounts;
  recordId?: number; // 四つ葉が見つかって図鑑に保存したときの記録の ID
  verifyNeeded?: number; // 「確かめる」で、何回四つ葉が出たら通すか（候補が多すぎる写真は 3）
  photoHash?: string;    // 写真の目印（あとから四つ葉を保存したときに、写真ごとの経験値の上限に使う。src/lib/save-four.ts）
  pendingReview?: boolean; // 確認のポップアップで、まだ決めていない（「確認してから入れる」のとき。src/components/four-confirm.ts）
  reviewed?: boolean;      // 確認のポップアップで決めた
  closedEarly?: boolean;   // 確認のポップアップを × で閉じた（決めていない候補が残った）
  fourDetected?: number;   // 見つけた四つ葉の候補の数（確認の前。結果の画面の文に使う。src/lib/result-text.ts）
  repeated?: boolean;      // 前にも調べた写真（経験値が増えない）
}

// DB を開く（初回や、版が上がったときは、足りない入れ物を作る。今ある記録はそのまま）
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VER);
    req.onupgradeneeded = event => {
      const db = req.result;
      // 版 3 より前の記録: 「メモ」（memo）を「ひとこと」（note）に引き継ぐ。両方に文字があれば、つなげる。消さない
      if (event.oldVersion >= 1 && event.oldVersion < 3 && db.objectStoreNames.contains(STORE)) {
        const cursorReq = req.transaction!.objectStore(STORE).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const rec = cursor.value as CloverRecord & { memo?: string };
          if ('memo' in rec) {
            const { memo, ...rest } = rec;
            cursor.update({ ...rest, note: mergeNote(rec.note, memo) });
          }
          cursor.continue();
        };
      }
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains(FEEDBACK_STORE)) db.createObjectStore(FEEDBACK_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(LAST_PHOTO_STORE)) db.createObjectStore(LAST_PHOTO_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) db.createObjectStore(PROGRESS_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(GACHA_STORE)) db.createObjectStore(GACHA_STORE, { keyPath: 'id' }).createIndex('date', 'date');
      if (event.oldVersion >= 1 && event.oldVersion < 5) moveGachaRecords(req.transaction!, event.oldVersion);
    };
    req.onsuccess = () => {
      // 別のタブが新しい版で開こうとしたら、こちらを閉じる（版の上げを止めないように）
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

// 版 5 へ上げるとき: 図鑑の入れ物にある今日のよつばを、今日のよつばの入れ物へ移す（ID・ひとこと・日記の手書きも、そのまま）
// 手順と決まりは src/lib/gacha-move.ts。元の値と結果は progress（id: 'gachaMove'）に残す
// 失敗しても、DB を開くこと自体は止めない（どの書き込みの失敗も preventDefault して、版の上げ全体に広げない）
function moveGachaRecords(tx: IDBTransaction, fromVersion: number): void {
  const recs = tx.objectStore(STORE), gacha = tx.objectStore(GACHA_STORE), prog = tx.objectStore(PROGRESS_STORE);
  // 書き込みをはじめられない（すぐに例外が出る）ときも、失敗として扱う
  const handle = (start: () => IDBRequest, ok: (req: IDBRequest) => void, fail: (reason: string) => void) => {
    let req: IDBRequest;
    try { req = start(); } catch (e) { fail((e as Error)?.name ?? 'unknown'); return; }
    req.onsuccess = () => ok(req);
    req.onerror = e => { e.preventDefault(); e.stopPropagation(); fail(req.error?.name ?? 'unknown'); };
  };
  moveGacha({
    getAll: (ok, fail) => handle(() => recs.getAll(), req => ok(req.result as CloverRecord[]), fail),
    keep: (summary, ok, fail) => handle(() => prog.put(summary), ok, fail),
    add: (rec, ok, fail) => handle(() => gacha.add(rec), ok, fail),
    remove: id => { try { recs.delete(id); } catch { /* 消せなければ、両方に残る（一覧では混ぜない） */ } },
    warn: (m, r) => console.warn(m, r),
  }, fromVersion, Date.now());
}

// 図鑑の記録と同じ番号の並びから、ID を 1 つ取る（今日のよつばの ID が、図鑑の記録の ID と重ならないように）
// 図鑑の入れ物に、仮の 1 件を足してすぐ消す（同じトランザクションの中なので、残らない）
export function reserveId(tx: IDBTransaction, use: (id: number) => void): void {
  const recs = tx.objectStore(STORE);
  const req = recs.add({ date: 0, reserved: true });
  req.onsuccess = () => {
    const id = req.result as number;
    recs.delete(id);
    use(id);
  };
}

// 今日のよつばを 1 件足し、ID を返す
export async function addGacha(rec: Omit<CloverRecord, 'id'>): Promise<number> {
  const db = await openDb();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction([STORE, GACHA_STORE], 'readwrite');
    let id = 0;
    reserveId(tx, n => { id = n; tx.objectStore(GACHA_STORE).add({ ...rec, id }); });
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('取り消しました'));
  });
}

// 今日のよつばの一覧（入れた日の新しい順）
export async function getAllGacha(): Promise<CloverRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(GACHA_STORE, 'readonly').objectStore(GACHA_STORE).index('date').getAll();
    req.onsuccess = () => resolve((req.result as CloverRecord[]).reverse());
    req.onerror = () => reject(req.error);
  });
}

// その ID の記録がある入れ物（図鑑の写真か、今日のよつば。ID は重ならない）
async function storeOf(db: IDBDatabase, id: number): Promise<{ store: string; rec: CloverRecord } | undefined> {
  for (const store of [STORE, GACHA_STORE]) {
    const rec = await new Promise<CloverRecord | undefined>((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result as CloverRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    if (rec) return { store, rec };
  }
  return undefined;
}

// 記録を1件追加し、付与された ID を返す
// 図鑑に初めて入れたときに、記録が勝手に消されにくくするように頼む（1 回だけ。結果は src/lib/persist.ts が残す）
// 今日のよつばは、図鑑の入れ物には入れず、今日のよつばの入れ物へ（src/lib/gacha-list.ts の recordStoreOf）
export async function addRecord(rec: Omit<CloverRecord, 'id'>): Promise<number> {
  if (recordStoreOf(rec) === GACHA_STORE) return addGacha(rec);
  const db = await openDb();
  const id = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add(rec);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
  void requestPersist({ once: true });
  return id;
}

// 全記録を日付降順で取得する
export async function getAllRecords(): Promise<CloverRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('date').getAll();
    req.onsuccess = () => resolve((req.result as CloverRecord[]).reverse());
    req.onerror = () => reject(req.error);
  });
}

// ID で1件取得する（図鑑の写真か、今日のよつば）
export async function getRecord(id: number): Promise<CloverRecord | undefined> {
  return (await storeOf(await openDb(), id))?.rec;
}

// ID で1件削除する（図鑑の写真か、今日のよつば）
export async function deleteRecord(id: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, GACHA_STORE], 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.objectStore(GACHA_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 記録の総数を返す
export async function countRecords(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 最後に調べた写真を保存する・読む
export async function setLastPhoto(photo: Omit<LastPhoto, 'id'>): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(LAST_PHOTO_STORE, 'readwrite').objectStore(LAST_PHOTO_STORE).put({ ...photo, id: 'last' });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getLastPhoto(): Promise<LastPhoto | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(LAST_PHOTO_STORE, 'readonly').objectStore(LAST_PHOTO_STORE).get('last');
    req.onsuccess = () => resolve(req.result as LastPhoto | undefined);
    req.onerror = () => reject(req.error);
  });
}

// 記録の一部を書きかえる（候補を確かめて通ったときの、枠と本数など。今日のよつばの記録も）
export async function updateRecord(id: number, patch: Partial<Omit<CloverRecord, 'id'>>): Promise<void> {
  const db = await openDb();
  const found = await storeOf(db, id);
  if (!found) return;
  return new Promise((resolve, reject) => {
    const req = db.transaction(found.store, 'readwrite').objectStore(found.store).put({ ...found.rec, ...patch });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ひとことを更新する（今日のよつばの記録も）
export async function updateNote(id: number, note: string): Promise<void> {
  const db = await openDb();
  const found = await storeOf(db, id);
  if (!found) return;
  const rec = { ...found.rec, note };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(found.store, 'readwrite');
    const req = tx.objectStore(found.store).put(rec);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

