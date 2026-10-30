// 枠（検出結果）を比べたり、まとめたりする計算
// モデルや画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/box-utils.test.ts）
import type { Detection } from './detector';

type Box = Detection['bbox'];

// 2 つの枠が重なっている部分の面積
export function intersectionArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// IoU: 重なった面積 ÷ 2 つを合わせた面積（0〜1。同じ枠なら 1）
export function iou(a: Box, b: Box): number {
  const inter = intersectionArea(a, b);
  return inter > 0 ? inter / (a.w * a.h + b.w * b.h - inter) : 0;
}

// 小さいほうの枠に対する重なりの割合: 重なった面積 ÷ 小さいほうの枠の面積（0〜1）
// 小さい枠が大きい枠にすっぽり入っていれば 1 になる。
// タイルの境目で、同じ葉の「全体の枠」と「切れた一部の枠」ができたとき、IoU は小さくてもこちらは大きくなる
export function overlapOfSmaller(a: Box, b: Box): number {
  const inter = intersectionArea(a, b);
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return inter > 0 && smaller > 0 ? inter / smaller : 0;
}

// 重なった枠をまとめるときの基準
export interface MergeOptions {
  iou: number;            // IoU がこの値を超えたら、同じ物とみなす
  smallerOverlap: number; // 小さいほうの枠に対する重なりが、この値以上なら、同じ物とみなす
  maxCount: number;       // 返す枠の最大数
}

// 2 つの枠が「同じ物」かどうか（どちらかの基準に当てはまれば同じ物）
export function isSameObject(a: Box, b: Box, opts: MergeOptions): boolean {
  return iou(a, b) > opts.iou || overlapOfSmaller(a, b) >= opts.smallerOverlap;
}

// NMS: スコアの高い順に枠を残し、それと同じ物とみなした枠を消す
// クラスが違っても、同じ物とみなした枠は 1 つにまとめる（スコアの高いほうを残す）
// （タイルの端で四つ葉が切れると葉が 3 枚に見え、三つ葉として重なって出ることがあるため）
export function mergeOverlapping(detections: Detection[], opts: MergeOptions): Detection[] {
  const sorted = [...detections].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const kept: Detection[] = [];
  for (const d of sorted) {
    if (kept.every(k => !isSameObject(k.bbox, d.bbox, opts))) kept.push(d);
    if (kept.length >= opts.maxCount) break;
  }
  return kept;
}
