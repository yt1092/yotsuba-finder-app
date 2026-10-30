// ホームの大きな画像（ヒーロー）に並べるスライドの一覧を作る
// 画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/hero-slides.test.ts）
import type { CloverRecord } from './db';

// 写真は新しい順に、最大でこの枚数まで
export const HERO_MAX_PHOTOS = 8;

export type HeroSlide =
  | { kind: 'illustration' }
  | { kind: 'photo'; id: number; imageDataUrl: string; date: number };

// 「最初のイラスト」＋「見つけた四つ葉の写真（新しい順、最大 HERO_MAX_PHOTOS 枚）」
// 写真が 0 枚なら、イラストだけ
export function buildHeroSlides(records: readonly CloverRecord[], max = HERO_MAX_PHOTOS): HeroSlide[] {
  const photos = records
    .filter(r => r.label === '四つ葉' && r.id != null && r.imageDataUrl && !r.photoMissing) // 写真なしで読み込んだ記録（代わりの絵）は出さない
    .slice()
    .sort((a, b) => b.date - a.date)
    .slice(0, max)
    .map((r): HeroSlide => ({ kind: 'photo', id: r.id!, imageDataUrl: r.imageDataUrl, date: r.date }));
  return [{ kind: 'illustration' }, ...photos];
}
