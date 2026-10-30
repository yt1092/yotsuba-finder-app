// 「今日のよつば」の一覧に出す形（64×64 の PNG）を作る（一覧と、決まりは src/lib/gacha-list.ts）
// 今日のよつばの画面で入れるとき（src/pages/gacha.ts）と、版 5 より前に入れた記録を一覧で初めて出すとき（src/pages/collection.ts）
import { GACHA_SHAPE_SIZE } from './gacha-list.ts'; // node のテストでそのまま読めるように、.ts を付ける
import { dataUrlToBlob } from './data-url.ts';

// 絵の全体を、64×64 に収める（正方形でなければ、まん中に置く）
export function shapeThumb(src: CanvasImageSource, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = c.height = GACHA_SHAPE_SIZE;
  const g = c.getContext('2d')!;
  const s = GACHA_SHAPE_SIZE / Math.max(w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, (GACHA_SHAPE_SIZE - w * s) / 2, (GACHA_SHAPE_SIZE - h * s) / 2, w * s, h * s);
  return c.toDataURL('image/png');
}

// 記録の絵（data URL）から作る。作れなければ null（一覧では、記録の絵をそのまま小さく出す）
export async function shapeThumbFromDataUrl(dataUrl: string): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
    try {
      return shapeThumb(bmp, bmp.width, bmp.height);
    } finally {
      bmp.close();
    }
  } catch {
    return null;
  }
}
