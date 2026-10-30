// 図鑑に入れる写真を、四つ葉の枠のまわりで切り抜く（範囲の計算は src/lib/crop.ts）
// カメラ（src/pages/scan.ts）と、写真から探す（src/pages/photo-pick.ts・src/pages/photo-found.ts）で使う
// 切り抜けないとき（使える枠が無い・画像が読めない）は、全体のまま保存する
import { cropAround, detectionsInCrop, type Crop } from './crop';
import { dataUrlToBlob } from './data-url';
import type { Detection } from './detector';

type Box = Detection['bbox'];

export interface CroppedPhoto {
  imageDataUrl: string;
  detections?: Detection[]; // 切り抜いた画像の座標に直した枠（渡したときだけ）
  crop?: Crop;              // 切り抜いた範囲（全体のままなら無し）
}

const JPEG_QUALITY = 0.85;

function draw(photo: CanvasImageSource, crop: Crop): string {
  const c = document.createElement('canvas');
  c.width = crop.w;
  c.height = crop.h;
  c.getContext('2d')!.drawImage(photo, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  return c.toDataURL('image/jpeg', JPEG_QUALITY);
}

// photo: 検出に使った画像（カメラのフレーム）か、写真の data URL。boxes: 囲む四つ葉の枠（photo の座標）
export async function cropForRecord(photo: ImageBitmap | string, fallbackDataUrl: string, boxes: readonly Box[], detections?: Detection[]): Promise<CroppedPhoto> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = typeof photo === 'string' ? await createImageBitmap(dataUrlToBlob(photo), { imageOrientation: 'from-image' }) : photo;
    const crop = cropAround(boxes, bitmap.width, bitmap.height);
    if (!crop) return { imageDataUrl: fallbackDataUrl, detections };
    return { imageDataUrl: draw(bitmap, crop), detections: detections && detectionsInCrop(detections, crop), crop };
  } catch (e) {
    console.warn('写真を切り抜けませんでした（全体を保存します）', e);
    return { imageDataUrl: fallbackDataUrl, detections };
  } finally {
    if (typeof photo === 'string') bitmap?.close();
  }
}

// 写真から探す: 四つ葉の枠（確かめる前の候補は入れない）のまわりで切り抜き、枠の座標も直す
export function cropPhotoRecord(imageDataUrl: string, detections: Detection[]): Promise<CroppedPhoto> {
  const fours = detections.filter(d => d.label === '四つ葉' && !d.candidate).map(d => d.bbox);
  return cropForRecord(imageDataUrl, imageDataUrl, fours, detections);
}
