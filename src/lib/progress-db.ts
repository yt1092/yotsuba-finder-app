// レベル・経験値・バッジを、IndexedDB の入れ物「progress」に保存する（計算は src/lib/progress.ts）
// 開発用の ?detector=dummy のときは、記録しない（本物の検出ではないため）
import { openDb, PROGRESS_STORE } from './db';
import { DETECTOR_KIND } from './detector-config';
import { applyEvent, emptyProgress, BADGES, type Progress, type ProgressEvent, type ProgressResult, type LevelInfo } from './progress';

// ダミーの検出器を使っているか（開発中の ?detector=dummy も含む）
export function usingDummyDetector(): boolean {
  if (DETECTOR_KIND === 'dummy') return true;
  return import.meta.env.DEV && new URLSearchParams(location.search).get('detector') === 'dummy';
}

export async function getProgress(): Promise<Progress> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(PROGRESS_STORE, 'readonly').objectStore(PROGRESS_STORE).get('me');
    req.onsuccess = () => resolve({ ...emptyProgress(), ...(req.result as Progress | undefined) });
    req.onerror = () => reject(req.error);
  });
}

// できごとを 1 つ記録する（読む・書くを 1 つのトランザクションで行う）。ダミーの検出器のときは、何もしない
export async function recordProgress(ev: ProgressEvent): Promise<ProgressResult | null> {
  if (usingDummyDetector() && (ev.kind === 'photo' || ev.kind === 'four')) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROGRESS_STORE, 'readwrite');
    const store = tx.objectStore(PROGRESS_STORE);
    let result: ProgressResult;
    const req = store.get('me');
    req.onsuccess = () => {
      const before = { ...emptyProgress(), ...(req.result as Progress | undefined) };
      result = applyEvent(before, ev, Date.now());
      store.put(result.progress);
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

// きろくを消す（図鑑の記録は消さない）
export async function resetProgress(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(PROGRESS_STORE, 'readwrite').objectStore(PROGRESS_STORE).delete('me');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── 次の画面で知らせるために、結果を一時的に預ける（写真から探す → 結果の画面、カメラ → Found 画面）──

export interface ProgressNotice {
  gained: number;
  repeated: boolean;
  levelUp?: LevelInfo;
  badgeIds: string[];
}

const NOTICE_KEY = 'yotsuba-progress-notice';

export function stashNotice(r: ProgressResult | null): void {
  try {
    if (!r) { sessionStorage.removeItem(NOTICE_KEY); return; }
    sessionStorage.setItem(NOTICE_KEY, JSON.stringify(noticeOf(r)));
  } catch { /* 預けられなくても、記録は済んでいる */ }
}

export const noticeOf = (r: ProgressResult): ProgressNotice =>
  ({ gained: r.gained, repeated: r.repeated, levelUp: r.levelUp, badgeIds: r.newBadges.map(b => b.id) });

// 2 つの知らせを 1 つにまとめる（写真から探す: 葉の分 → あとで図鑑に入れた四つ葉の分）
export function combineNotices(a: ProgressNotice | null, b: ProgressNotice | null): ProgressNotice | null {
  if (!a) return b;
  if (!b) return a;
  return { gained: a.gained + b.gained, repeated: a.repeated, levelUp: b.levelUp ?? a.levelUp, badgeIds: [...a.badgeIds, ...b.badgeIds] };
}

export function takeNotice(): ProgressNotice | null {
  try {
    const raw = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return raw ? JSON.parse(raw) as ProgressNotice : null;
  } catch {
    return null;
  }
}

export const badgeName = (id: string): string => BADGES.find(b => b.id === id)?.name ?? '';
