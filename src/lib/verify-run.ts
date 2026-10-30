// 確認ステップを、ブラウザで実際に行う（切り抜きを作り、検出器で 3 回判定する）
// 計算の決まりは verify-crops.ts（テストあり）
import type { Detection, Detector } from './detector';
import { PAD_VALUE } from './detector-config';
import { verifyCrops, boxInCrop, fourLeafAt, verifyVerdict, decidedVerdict, VERIFY_NEEDED, type CropRegion, type VerifyVerdict } from './verify-crops';

type Box = Detection['bbox'];

// 切り抜きの、いちばん大きい辺（大きすぎる切り抜きは縮める。検出器は 960px にそろえて調べる）
const MAX_CROP_PX = 1280;

// 正方形の切り抜きを描く。画像の外にはみ出した所は灰色（モデルの学習時と同じ余白の色）で埋める
export function drawCrop(source: CanvasImageSource & { width: number; height: number }, crop: CropRegion, outSize: number, fill = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`): { canvas: HTMLCanvasElement; scale: number } {
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;
  const g = canvas.getContext('2d')!;
  g.fillStyle = fill;
  g.fillRect(0, 0, outSize, outSize);
  const k = outSize / crop.size;
  g.drawImage(source, 0, 0, source.width, source.height, -crop.x * k, -crop.y * k, source.width * k, source.height * k);
  return { canvas, scale: k };
}

// モデルの読み込みのあと、空の小さな画像で 1 回だけ判定しておく（いちばん最初の判定は、準備のために 1〜3 秒かかるため。
// 「確かめる」を押す前に済ませておけば、押したあとの待ち時間が短くなる）
export async function warmUp(detector: Detector): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
  const bitmap = await createImageBitmap(canvas);
  try {
    await detector.detect(bitmap, { mode: 'photo', tiles: false });
  } finally {
    bitmap.close();
  }
}

// 同じ葉を、大きさを 3 通りに変えて判定する。3 回中 2 回以上、その場所で四つ葉が出たら 'four'
// 途中で答えが決まったら、残りは判定しない（2 回で決まることが多い。答えは 3 回やったときと同じ）
// runs には、実際に判定した回数を入れる（待ち時間の測定用）
// needed: 何回四つ葉が出たら通すか（ふつうは 2。候補が多すぎる写真では 3）
export async function verifyLeaf(detector: Detector, image: ImageBitmap, box: Box, stats?: { runs: number }, needed: number = VERIFY_NEEDED): Promise<VerifyVerdict> {
  const hits: boolean[] = [];
  const crops = verifyCrops(box);
  for (const crop of crops) {
    if (decidedVerdict(hits, crops.length, needed) !== null) break;
    if (stats) stats.runs++;
    const { canvas, scale } = drawCrop(image, crop, Math.min(Math.round(crop.size), MAX_CROP_PX));
    const bitmap = await createImageBitmap(canvas);
    const detections = await detector.detect(bitmap, { mode: 'photo', tiles: false });
    bitmap.close();
    hits.push(fourLeafAt(detections, boxInCrop(box, crop, scale)));
  }
  return verifyVerdict(hits, needed);
}
