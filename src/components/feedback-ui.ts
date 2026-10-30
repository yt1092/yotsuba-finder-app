// まちがいの報告の画面の部品
// - 枠のシートに出す「合っている」「これは四つ葉じゃない」（目立たない文字のボタン）
// - 「四つ葉を見逃している」: 押したあと、写真の見逃した場所をタップすると、仮の枠を付けて保存する
// 記録は、この端末の中（IndexedDB）にだけ保存する（src/lib/feedback-db.ts）
import type { Detection } from '../lib/detector';
import { saveAnswer } from '../lib/feedback-db';
import type { LeafPhoto } from './leaf-photo';
import type { SheetButton } from './leaf-sheet';
import { openPhotoStage } from './photo-stage';

const THANKS = 'おしえてくれて、ありがとう';

export interface FeedbackContext {
  key: string;                       // 写真ごとの名前（record:<id> など）
  detections: Detection[];           // そのときの検出結果（写真の座標）
  photo: () => Promise<ImageBitmap>; // 写真（向きを直したもの）
}

// 枠のシートに足すボタン
export function feedbackButtons(ctx: FeedbackContext, det: Detection, index: number): SheetButton[] {
  const answer = (kind: 'correct' | 'not-four'): SheetButton['onClick'] => async sheet => {
    try {
      await saveAnswer(ctx.key, await ctx.photo(), ctx.detections, { kind, index, bbox: det.bbox });
      sheet.say(THANKS, 'good');
    } catch (e) {
      console.error(e);
      sheet.say('うまく ほぞんできませんでした', 'caution');
    }
  };
  return [
    { label: '合っている', kind: 'text', onClick: answer('correct') },
    { label: 'これは四つ葉じゃない', kind: 'text', onClick: answer('not-four') },
  ];
}

// 「四つ葉を見逃している」の流れを用意し、始めるための関数を返す
// （写真の画面では写真の下のボタンから、図鑑の詳細では「…」のメニューから始める）
// 押すと写真が全画面になり、見逃した場所をタップして枠をつける（src/components/photo-stage.ts）。
// 「決定」で、仮の枠として保存し、画面の写真にも「仮の枠」の印をつけたままにする（あとで、正しい枠に直すため）
export function setupMissedMode(view: LeafPhoto, ctx: FeedbackContext): () => void {
  return async () => {
    const photo = await ctx.photo();
    openPhotoStage({
      photo,
      detections: ctx.detections,
      mode: 'mark',
      onDecide: async box => {
        view.addMarker(box, '仮の枠');
        try {
          await saveAnswer(ctx.key, photo, ctx.detections, { kind: 'missed', bbox: box, provisional: true, at: Date.now() });
          toast(THANKS);
        } catch (err) {
          console.error(err);
          toast('うまく ほぞんできませんでした');
        }
      },
    });
  };
}

// 短いお知らせ（画面の上に、少しのあいだ出す）
function toast(text: string) {
  const el = document.createElement('p');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  window.setTimeout(() => el.remove(), 2600);
}

// 写真（向きを直したもの）を、初めて使うときに 1 回だけ作る
export function photoOnce(img: HTMLImageElement): () => Promise<ImageBitmap> {
  let photo: Promise<ImageBitmap> | null = null;
  return () => (photo ??= createImageBitmap(img, { imageOrientation: 'from-image' }));
}
