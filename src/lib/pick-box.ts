// 写真の上の枠のうち、タップした場所に合うものを選ぶ（枠が密集していて押しにくいとき用）
// 画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/pick-box.test.ts）

export interface Rect { x: number; y: number; w: number; h: number } // 画面の座標（px）

export type PickResult =
  | { kind: 'none' }                   // 近くに枠がない
  | { kind: 'one'; index: number }     // この枠に決まった
  | { kind: 'choose'; indices: number[] }; // 決められない（重なっている・同じくらい近い）→ 一覧から選んでもらう

export const PICK_RADIUS = 24; // タップした場所から、この距離（px）以内の枠を選ぶ
export const PICK_TIE = 8;     // いちばん近い枠と、次に近い枠の距離の差がこれ未満なら、決められないとみなす

// 点から枠までの距離（枠の中なら 0）
export function distanceToRect(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export function pickBox(px: number, py: number, rects: readonly Rect[], radius = PICK_RADIUS, tie = PICK_TIE): PickResult {
  const near = rects
    .map((r, index) => ({ index, d: distanceToRect(px, py, r) }))
    .filter(n => n.d <= radius)
    .sort((a, b) => a.d - b.d);
  if (near.length === 0) return { kind: 'none' };
  if (near.length === 1) return { kind: 'one', index: near[0].index };
  // 2 つ以上の枠の中にいる、または、いちばん近い枠と次の枠が同じくらい近い → 一覧から選んでもらう
  const close = near.filter(n => n.d - near[0].d < tie);
  if (close.length >= 2) return { kind: 'choose', indices: close.map(n => n.index) };
  return { kind: 'one', index: near[0].index };
}
