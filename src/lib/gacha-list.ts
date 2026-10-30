// 「今日のよつば」の一覧（図鑑の写真とは別の入れ物 'gacha' に残す。2026-10-30 から）の、画面や DB に頼らない部分（tests/gacha-list.test.ts）
// - 図鑑の「すべて」「四つ葉」には、今日のよつばを混ぜない（前の版で図鑑に入っていたものは、DB を開いたときに移す。src/lib/db.ts）
// - 記録の ID は、図鑑の写真と同じ番号の並びから取る（日記カードの経験値は、記録の ID で 1 回だけ数えるため。ID が重ならないように）
// - 一覧の各項目は、日付と、形（64×64 で残した小さな絵。src/lib/gacha-thumb.ts）
import type { CloverRecord } from './db';

export const GACHA_SHAPE_SIZE = 64; // 一覧に出す形の大きさ（px）
export const GACHA_MOVE_KEY = 'gachaMove'; // 移す前の元の値と、移した結果（progress の入れ物。「すべてのデータを消す」で消える）

type Sourced = Pick<CloverRecord, 'source'>;

export const isGacha = (r: Sourced): boolean => r.source === 'gacha';

// 図鑑の写真と、今日のよつばに分ける（順番はそのまま）
export function splitGacha<T extends Sourced>(records: readonly T[]): { photos: T[]; gacha: T[] } {
  const photos: T[] = [], gacha: T[] = [];
  for (const r of records) (isGacha(r) ? gacha : photos).push(r);
  return { photos, gacha };
}

// 図鑑の一覧（「すべて」「四つ葉」）に出す記録。今日のよつばは、どちらにも入れない（移せずに残ったものがあっても混ぜない）
export function collectionItems<T extends Pick<CloverRecord, 'source' | 'label'>>(records: readonly T[], filter: 'all' | '四つ葉'): T[] {
  return records.filter(r => !isGacha(r) && (filter === 'all' || r.label === filter));
}

// 今日のよつばの一覧に出す順（新しい日が上。同じ日なら、あとに入れたものが上）
export function sortGacha<T extends Pick<CloverRecord, 'date' | 'gachaDay'>>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (b.gachaDay ?? '').localeCompare(a.gachaDay ?? '') || b.date - a.date);
}

// 一覧の日付（「2026年10月29日」。今日のよつばの日付が無い古い記録は、入れた日）
export function gachaDateLabel(e: Pick<CloverRecord, 'date' | 'gachaDay'>): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.gachaDay ?? '');
  if (m) return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
  const d = new Date(e.date);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// 移すもの: 図鑑の入れ物にある、今日のよつばの記録（ID のあるものだけ）。元の値は、そのまま残す
export function planGachaMove<T extends Sourced & { id?: number }>(records: readonly T[]): (T & { id: number })[] {
  return records.filter((r): r is T & { id: number } => isGacha(r) && typeof r.id === 'number');
}

// 今日のよつばを ID つきで書いたあと、図鑑の入れ物の番号を、その ID より先に進めるための ID（いらなければ null）
// IndexedDB の自動の番号は、入れ物ごとに別なので、図鑑の入れ物にこの ID を一度書いて消すと、次の番号がその先になる
export function idToSkipPast(recordIds: readonly number[], gachaIds: readonly number[]): number | null {
  if (gachaIds.length === 0) return null;
  const g = Math.max(...gachaIds);
  return recordIds.length > 0 && Math.max(...recordIds) >= g ? null : g;
}

// 記録を入れる入れ物（今日のよつばは、図鑑の入れ物には入れない。src/lib/db.ts の addRecord・addGacha）
export const recordStoreOf = (r: Sourced): 'gacha' | 'records' => (isGacha(r) ? 'gacha' : 'records');

// 今日のよつばの画面で入れる記録（絵・日付・出どころ・64×64 の形）
export function newGachaRecord(o: { now: number; image: string; day: string; kind: 'dit' | 'preset'; shape64?: string }): Omit<CloverRecord, 'id'> {
  return { date: o.now, imageDataUrl: o.image, label: '四つ葉', source: 'gacha', gachaDay: o.day, gachaKind: o.kind, ...(o.shape64 ? { shape64: o.shape64 } : {}) };
}

// 図鑑の「今日のよつば」に出す一覧: 今日のよつばの入れ物のものと、図鑑の入れ物に移せずに残ったもの（新しい日が上）
export function gachaListItems<T extends Pick<CloverRecord, 'source' | 'date' | 'gachaDay'>>(gachaStore: readonly T[], records: readonly T[]): T[] {
  return sortGacha([...gachaStore, ...splitGacha(records).gacha]);
}
