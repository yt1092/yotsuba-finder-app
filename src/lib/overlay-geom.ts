// 枠を画面に重ねるときの位置の計算（画面に頼らない計算だけ。tests/overlay-geom.test.ts）

// 映像（vw×vh）を、画面（cw×ch）に cover で出したときの、映像の点 → 画面の点（画面 = 映像 × s + o）
export function coverMap(vw: number, vh: number, cw: number, ch: number): { s: number; ox: number; oy: number } {
  const s = Math.max(cw / vw, ch / vh);
  return { s, ox: (cw - vw * s) / 2, oy: (ch - vh * s) / 2 };
}

export interface Rect { x: number; y: number; w: number; h: number }

// 2 つの四角が重なるか（すき間 gap 未満も重なりとみなす）
export const overlaps = (a: Rect, b: Rect, gap = 2): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// ラベル（チップ）の位置: 枠の上に置く。上に場所がなければ、枠の中の上。左右と上下は、使ってよい範囲（top〜bottom）に収める
// 収まらないときは null（出さない。ボタンや見出しに重ねないため）
export function labelPos(box: Rect, chipW: number, chipH: number, area: { left: number; right: number; top: number; bottom: number }, gap = 4): { x: number; y: number } | null {
  let y = box.y - chipH - gap;
  if (y < area.top) y = box.y + gap;
  if (y < area.top) y = area.top;
  if (y + chipH > area.bottom) return null;
  const x = Math.min(Math.max(box.x, area.left), area.right - chipW);
  if (x < area.left) return null;
  return { x, y };
}
