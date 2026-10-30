// 図鑑に入れるときの、写真の切り抜き（画面に頼らない計算。tests/crop.test.ts）
// 四つ葉の枠のまわりに余白をつけて、正方形に近く切り抜く（図鑑の一覧・詳細・ホームの大きな画像は、どれも正方形に近い枠に
// object-fit: cover で出すので、正方形なら、端が切れずに、そのまま出る）
// 画像に描くのは src/lib/crop-image.ts
import type { Detection } from './detector';

type Box = Detection['bbox'];

export const CROP_MARGIN_RATIO = 0.25; // 余白: 枠の長いほうの辺の 25%（各辺に）
export const CROP_MIN_MARGIN = 16;     // 余白の最小（画像の px）
export const CROP_MIN_SIDE = 256;      // 切り抜きの一辺の最小（画像の px。小さい四つ葉でも、ぼやけすぎないように。画像より大きくはしない）

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
  srcW: number; // 元の画像の大きさ（あとで枠の座標を直すため、記録に残す）
  srcH: number;
}

// 枠を画像の中に収める（はみ出した分を切る）。画像の外にしかない枠は null
export function clipBox(b: Box, imgW: number, imgH: number): Box | null {
  const x1 = Math.max(0, b.x), y1 = Math.max(0, b.y);
  const x2 = Math.min(imgW, b.x + b.w), y2 = Math.min(imgH, b.y + b.h);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

// 枠（いくつでも）を囲む、切り抜きの範囲。使える枠が無ければ null（切り抜かずに、全体を保存する）
export function cropAround(boxes: readonly Box[], imgW: number, imgH: number, opts: { ratio?: number; minMargin?: number; minSide?: number } = {}): Crop | null {
  if (!(imgW > 0 && imgH > 0)) return null;
  const inside = boxes.map(b => clipBox(b, imgW, imgH)).filter((b): b is Box => b !== null);
  if (inside.length === 0) return null;
  const x1 = Math.min(...inside.map(b => b.x)), y1 = Math.min(...inside.map(b => b.y));
  const x2 = Math.max(...inside.map(b => b.x + b.w)), y2 = Math.max(...inside.map(b => b.y + b.h));
  const w = x2 - x1, h = y2 - y1;
  const margin = Math.max(opts.minMargin ?? CROP_MIN_MARGIN, Math.max(w, h) * (opts.ratio ?? CROP_MARGIN_RATIO));
  // 正方形にしたい一辺: 長いほうの辺 ＋ 両側の余白（小さすぎるときは最小の一辺）
  const side = Math.max(Math.max(w, h) + 2 * margin, opts.minSide ?? CROP_MIN_SIDE);
  // 画像より大きくはできないので、その向きだけ画像の幅（高さ）まで。枠はかならず入る（枠は画像の中に収めてあるため）
  const cw = Math.min(imgW, side), ch = Math.min(imgH, side);
  // 枠のまん中に置き、画像の外に出る分は、内側にずらす
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  let x = Math.min(Math.max(0, cx - cw / 2), imgW - cw);
  let y = Math.min(Math.max(0, cy - ch / 2), imgH - ch);
  // 整数の画素にそろえる（はみ出さないように、内側に丸める）
  const ix = Math.max(0, Math.floor(x)), iy = Math.max(0, Math.floor(y));
  const iw = Math.min(imgW - ix, Math.round(cw)), ih = Math.min(imgH - iy, Math.round(ch));
  x = ix; y = iy;
  return { x, y, w: iw, h: ih, srcW: imgW, srcH: imgH };
}

// 枠の座標を、切り抜いた画像の座標に直す。切り抜きの外に出る分は切り、外にしかない枠は外す
export function detectionsInCrop<T extends { bbox: Box }>(detections: readonly T[], crop: Crop): T[] {
  const out: T[] = [];
  for (const d of detections) {
    const b = clipBox({ x: d.bbox.x - crop.x, y: d.bbox.y - crop.y, w: d.bbox.w, h: d.bbox.h }, crop.w, crop.h);
    if (b) out.push({ ...d, bbox: b });
  }
  return out;
}
