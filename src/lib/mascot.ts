// キャラクターの表情（public/images/mascot/。scripts/make_mascots.py で作る）
// 飾りなので、読み上げない（alt は空・aria-hidden）。押せるところには重ねない。動かさない
//   thinking … 写真を調べているとき
//   surprised … 四つ葉が見つかった（確認のポップアップ）
//   happy … 図鑑に入れた・レベルアップ
//   smile … 初めて「入れない」を選んだときのお礼・四つ葉がなかったとき
export type MascotKind = 'happy' | 'thinking' | 'smile' | 'surprised';

// 画像の大きさ（幅・高さ px。体の高さは 4 枚でそろえてある）
const SIZE: Record<MascotKind, [number, number]> = {
  surprised: [350, 306], smile: [384, 301], thinking: [287, 302], happy: [291, 302],
};

export const mascotSrc = (kind: MascotKind): string => `/images/mascot/${kind}.webp`;

// 高さ height px の <img>（56〜72px で使う）
export function mascotHtml(kind: MascotKind, height = 64, className = ''): string {
  const [w, h] = SIZE[kind];
  return `<img class="mascot ${className}" src="${mascotSrc(kind)}" alt="" aria-hidden="true" width="${Math.round(height * w / h)}" height="${height}" decoding="async">`;
}

// すでにある <img class="mascot"> の表情を変える（無しなら隠す）
export function setMascot(img: HTMLImageElement, kind: MascotKind | null, height = 64): void {
  img.hidden = kind == null;
  if (kind == null) return;
  const [w, h] = SIZE[kind];
  img.src = mascotSrc(kind);
  img.height = height;
  img.width = Math.round(height * w / h);
}
