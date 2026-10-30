// 確認ステップ（大きさをそろえた、くり返しの判定）の計算
// モデルには「大きく写った葉ほど、四つ葉と答えやすい」癖があるので、枠の中を拡大して 1 回だけ判定することはしない。
// 代わりに、同じ葉を「切り抜きの中での大きさ」を 3 通りに変えて（まわりの景色も含めて）切り抜き、それぞれ判定する。
// 画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/verify-crops.test.ts）
import type { Detection } from './detector';
import { iou, overlapOfSmaller } from './box-utils.ts';

type Box = Detection['bbox'];

// 枠の長い辺が、切り抜きの幅のこの割合になるように切る
export const VERIFY_FRACTIONS = [0.2, 0.35, 0.5] as const;

// 切り抜きの中で「同じ場所」とみなす基準
const SAME_PLACE_IOU = 0.3;
const SAME_PLACE_SMALLER_OVERLAP = 0.6;

// 正方形の切り抜き（元画像の座標）。画像の外にはみ出すことがある（はみ出した所は灰色で埋める）
export interface CropRegion { x: number; y: number; size: number }

// 葉の枠から、3 通りの切り抜きを作る（枠の中心を、切り抜きの中心にする）
export function verifyCrops(box: Box, fractions: readonly number[] = VERIFY_FRACTIONS): CropRegion[] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const side = Math.max(box.w, box.h);
  return fractions.map(f => {
    const size = side / f;
    return { x: cx - size / 2, y: cy - size / 2, size };
  });
}

// 元画像の枠を、切り抜き（scale 倍に描いたもの）の中の座標に直す
export function boxInCrop(box: Box, crop: CropRegion, scale = 1): Box {
  return { x: (box.x - crop.x) * scale, y: (box.y - crop.y) * scale, w: box.w * scale, h: box.h * scale };
}

// 切り抜きの検出結果に、その場所（target）の四つ葉があるか
export function fourLeafAt(detections: readonly Detection[], target: Box): boolean {
  return detections.some(d => d.label === '四つ葉'
    && (iou(d.bbox, target) >= SAME_PLACE_IOU || overlapOfSmaller(d.bbox, target) >= SAME_PLACE_SMALLER_OVERLAP));
}

export type VerifyVerdict = 'four' | 'unsure';

// 3 回のうち 2 回以上、その場所で四つ葉が出たら「四つ葉のようです」。それより少なければ「よく見て、確かめてください」
// （3 回とも、の決まりより本物が多く残る。測定の数字は README の「確かめる」の節）
export const VERIFY_NEEDED = 2;

// 四つ葉の候補が多すぎる写真（三つ葉の誤検出が多い写真）では、3 回とも四つ葉のときだけ通す（src/lib/detector-config.ts）
export const VERIFY_NEEDED_STRICT = 3;

export function verifyVerdict(hits: readonly boolean[], needed: number = VERIFY_NEEDED): VerifyVerdict {
  return hits.filter(Boolean).length >= needed ? 'four' : 'unsure';
}

// 途中までの結果で、答えが決まっているか（決まっていれば、残りの判定はしなくてよい。待ち時間を短くするため）
// needed 回四つ葉が出たら 'four'、もう needed 回に届かないと決まったら 'unsure'。まだ決まらなければ null
export function decidedVerdict(hits: readonly boolean[], total: number = VERIFY_FRACTIONS.length, needed: number = VERIFY_NEEDED): VerifyVerdict | null {
  const yes = hits.filter(Boolean).length;
  const no = hits.length - yes;
  if (yes >= needed) return 'four';
  if (no > total - needed) return 'unsure';
  return null;
}
