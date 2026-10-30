// 「今日のよつば」: 日本時間の日付と、画面の文（テスト: tests/gacha.test.ts）
// 形は、この端末の中で、小さなモデル（DiT）が作る（src/lib/gacha-maker.ts）。作れなかったときは、
// あらかじめ数式で作った 60 個（public/gacha/。training/gacha_export.py）から、種で 1 つ選ぶ（src/lib/gacha-seed.ts）
// 種は、日付と端末ごとの値から決まる（同じ端末の同じ日は同じ形）

export const GACHA_COUNT = 60;

// 今日のよつばの画面の説明の 1 行（DiT の形のときだけ出す。60 枚から出したときは、出さない。作者の決定 2026-10-28）
// 「本物の四つ葉から学んだ」とは、どこにも書かない
export const GACHA_DIT_NOTE = 'この端末の中で、小さなモデル（DiT）が作った形です';

// 図鑑の詳細に、かならず出す形の出どころ
export function gachaSource(kind: 'dit' | 'preset'): string {
  return kind === 'dit' ? '端末の中のモデルが作った形' : 'あらかじめ作った形';
}
// 図鑑の詳細に、小さく書く（DiT の形のときだけ）
export const GACHA_MODEL_NOTE = '数式で作った形で学習したモデルです';

export function gachaAlt(kind: 'dit' | 'preset'): string {
  return kind === 'dit' ? '小さなモデルが作った四つ葉の形' : 'あらかじめ作った四つ葉の形';
}

// 日本時間の日付（'2026-10-27'）。端末の時間帯の設定に関係なく、日本時間で決める
export function tokyoDayKey(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// 日付（'2026-10-27'）を、1970-01-01 からの日数にする
export function dayNumber(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function gachaImageUrl(n: number): string {
  return `/gacha/yotsuba-${String(n).padStart(2, '0')}.webp`;
}

// Service Worker で、先にキャッシュしておく絵（vite.config.ts）
export function gachaImageUrls(count = GACHA_COUNT): string[] {
  return Array.from({ length: count }, (_, i) => gachaImageUrl(i + 1));
}
