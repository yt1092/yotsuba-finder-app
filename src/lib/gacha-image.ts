// 「今日のよつば」の絵を、図鑑の中で、切り抜かずに見せる（図鑑の詳細・図鑑の一覧）
// 写真は枠いっぱいに切り抜く（object-fit: cover）が、今日のよつばの絵は、形の全体が見えるように contain にする。
// あまった所は、絵の背景の色で埋める（見た目ごとに色がちがうので、絵の右上の角の色を読む。切り絵は濃い緑・押し花は和紙・ドット絵は薄い緑）
// 写真の表示は変えない

// 絵の右上の角の色（読めなければ null）。押し花のテープ（左上）や日付（右下）にかからない所
export function edgeColor(img: HTMLImageElement): string | null {
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const w = img.naturalWidth, h = img.naturalHeight;
    g.drawImage(img, w - Math.max(2, w * 0.01) - 1, Math.max(2, h * 0.01), 1, 1, 0, 0, 1, 1);
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${gr}, ${b})`;
  } catch {
    return null;
  }
}

// 画像を contain にして、あまりを絵の背景の色で埋める。also の要素（画像を入れている枠など）も同じ色にする
export function fitGachaImage(img: HTMLImageElement, ...also: HTMLElement[]): void {
  img.style.objectFit = 'contain';
  const paint = () => {
    const color = edgeColor(img);
    if (!color) return;
    img.style.backgroundColor = color;
    for (const el of also) el.style.backgroundColor = color;
  };
  if (img.complete && img.naturalWidth > 0) paint();
  else img.addEventListener('load', paint, { once: true });
}
