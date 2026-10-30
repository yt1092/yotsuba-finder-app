// 写真の四つ葉の枠をタップしたら、その場所を大きくして見せる（写真から探すの結果・図鑑の詳細で使う）
// 確認ステップ（verify）が有効なら、「確かめる」ボタンで、大きさを 3 通りに変えて判定し直す
import type { Detection, Detector } from '../lib/detector';
import { createDetector } from '../lib/create-detector';
import { verifyLeaf, warmUp } from '../lib/verify-run';
import type { VerifyVerdict } from '../lib/verify-crops';
import { LeafPhoto } from './leaf-photo';
import { LeafSheet, type SheetButton } from './leaf-sheet';
import { openPhotoStage } from './photo-stage';

export interface LeafInspectOptions {
  img: HTMLImageElement;
  detections: Detection[];
  verify: boolean; // 「確かめる」を出すか
  verifyNeeded?: number; // 何回四つ葉が出たら通すか（省略時は 3 回中 2 回）
  // あとから足すボタン（まちがいの報告など）
  extraButtons?: (detection: Detection, index: number) => SheetButton[];
  // 「確かめる」の答えが出たあとに、画面ごとにすること（候補が通ったら保存する、など）。返した文を、答えのあとに出す
  onVerdict?: (detection: Detection, index: number, verdict: VerifyVerdict) => Promise<string | void>;
}

let detector: Detector | null = null; // 枠をタップしてシートを開いたときに作る（モデルの読み込みを、そこから始めておく）
let photo: ImageBitmap | null = null;  // 判定に使う写真（向きを直したもの。枠の座標と同じ向き）

export function setupLeafInspect(opts: LeafInspectOptions): LeafPhoto {
  const parent = opts.img.parentElement!;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  // 四つ葉の枠があるときは、写真の全体を見せる（端が切れていると、枠が見えなくなるため）
  if (opts.detections.some(d => d.label === '四つ葉')) {
    opts.img.style.objectFit = 'contain';
    parent.style.background = '#22352A';
  }

  // 写真（四つ葉の枠より外）をタップしたら、全画面で見る（ピンチで拡大・ドラッグで移動）
  // 全画面でも、四つ葉の枠をタップすると、同じシートが開く（枠が密集した写真で、拡大してから選べるように）
  opts.img.style.cursor = 'zoom-in';
  opts.img.addEventListener('click', async () => {
    photo ??= await createImageBitmap(opts.img, { imageOrientation: 'from-image' });
    openPhotoStage({
      photo, detections: view.detections, getDetections: () => view.detections, mode: 'view',
      onPickFound: index => openSheet(view.detections[index], index),
    });
  });

  // 四つ葉の枠のシート（大きくして見る・確かめる・まちがいの報告）
  const openSheet = async (det: Detection, index: number) => {
    // 「確かめる」を押すまでの間に、モデルの読み込みを始めておく（待ち時間を短くするため）
    if (opts.verify && !detector) {
      detector = createDetector('photo');
      // 読み込みが終わったら、1 回だけ空で判定しておく（最初の判定の準備の時間を、先に済ませる）
      warmUp(detector).catch(() => { /* ここでの失敗は気にしない（押したときの判定で、うまくいかなかったことを知らせる） */ });
    }
    photo ??= await createImageBitmap(opts.img, { imageOrientation: 'from-image' });
    const image = photo;
    const buttons: SheetButton[] = [];
    if (opts.verify) {
      buttons.push({
        label: '確かめる',
        kind: 'primary',
        onClick: async sheet => {
          sheet.say('確かめています…');
          try {
            detector ??= createDetector('photo');
            const verdict = await verifyLeaf(detector, image, det.bbox, undefined, opts.verifyNeeded);
            const more = (await opts.onVerdict?.(det, index, verdict)) ?? '';
            if (verdict === 'four') sheet.say(`四つ葉のようです${more ? '。' + more : ''}`, 'good');
            else sheet.say(`よく見て、確かめてください${more ? '。' + more : ''}`, 'caution');
          } catch (e) {
            console.error(e);
            sheet.say('うまく 確かめられませんでした。もう一度 おしてください', 'caution');
          }
        },
      });
    }
    buttons.push(...(opts.extraButtons?.(det, index) ?? []));
    new LeafSheet({
      image,
      box: det.bbox,
      title: '大きくして見る',
      hint: '葉っぱが なんまい あるか、かぞえてみよう',
      buttons,
    });
  };

  const view = new LeafPhoto({ img: opts.img, detections: opts.detections, onTap: openSheet });
  return view;
}
