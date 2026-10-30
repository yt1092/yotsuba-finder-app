// 「今日のよつば」: 形（64×64）を、3 つの見た目（切り絵・押し花・ドット絵）で、キャンバスに描く
// 見た目は、デザインのキャンバス「今日のよつば イメージ」の 3 枚目と「3つの見た目」に合わせた
// - 切り絵・押し花: 輪郭をなめらかにした線（src/lib/gacha-outline.ts）と、葉脈
// - ドット絵: 64×64 の形を、そのまま 1 画素 = 1 つぶで描く
// 画面に見せる絵も、図鑑に入れる絵（512×512）も、同じ関数で描く
import { mulberry32 } from './gacha-gen.ts';
import { SIZE, type Mask } from './gacha-shape.ts';
import type { Outline } from './gacha-outline.ts';

export type GachaStyle = 'cut' | 'press' | 'pixel';
export const GACHA_STYLES: { key: GachaStyle; label: string }[] = [
  { key: 'cut', label: '切り絵' },
  { key: 'press', label: '押し花' },
  { key: 'pixel', label: 'ドット絵' },
];

const VIEW = SIZE + 8; // 形のまわりに 4 画素ずつの余白

const CUT_LEAVES = ['#6CC17A', '#5BB46C', '#7ACB87', '#63BA73'];

// 形の座標で描けるように、キャンバスの座標を合わせる（size × size のキャンバスに、余白つきで）
function frame(g: CanvasRenderingContext2D, size: number) {
  const k = size / VIEW;
  g.setTransform(k, 0, 0, k, 4 * k, 4 * k);
  return k;
}

function drawCut(g: CanvasRenderingContext2D, size: number, o: Outline) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#1F4D3A';
  g.fillRect(0, 0, size, size);
  frame(g, size);
  const shape = new Path2D(o.d);
  // 影（少しずらして、暗い色で）
  g.save();
  g.translate(0.9, 1.3);
  g.globalAlpha = 0.5;
  g.fillStyle = '#0B2A1D';
  g.fill(shape, 'evenodd');
  g.restore();
  // 葉ごとに、少しちがう緑（葉が 4 枚と数えられないときは、1 色）
  if (o.wedges.length === 4) {
    o.wedges.forEach((w, k) => {
      g.save();
      g.clip(shape, 'evenodd');
      g.clip(new Path2D(w));
      g.fillStyle = CUT_LEAVES[k];
      g.fillRect(-8, -8, VIEW + 8, VIEW + 8);
      g.restore();
    });
  } else {
    g.fillStyle = CUT_LEAVES[3];
    g.fill(shape, 'evenodd');
  }
  strokeVeins(g, shape, o, '#2E7D47', 0.6, 1);
}

function drawPress(g: CanvasRenderingContext2D, size: number, o: Outline, dateText: string) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#F4ECD6';
  g.fillRect(0, 0, size, size);
  const k = frame(g, size);
  // 和紙のつぶ（決まった乱数で。毎回同じ）
  const rand = mulberry32(4);
  g.fillStyle = '#73603A';
  for (let i = 0; i < 900; i++) {
    g.globalAlpha = 0.05 + rand() * 0.1;
    g.fillRect(rand() * VIEW - 4, rand() * VIEW - 4, 0.35, 0.35);
  }
  g.globalAlpha = 1;
  const shape = new Path2D(o.d);
  // しみ（ぼかした影）
  g.save();
  g.translate(0.6, 0.9);
  g.shadowColor = 'rgba(200, 174, 114, 0.55)';
  g.shadowBlur = 2.2 * k;
  g.globalAlpha = 0.45;
  g.fillStyle = '#C8AE72';
  g.fill(shape, 'evenodd');
  g.restore();
  // 葉（まん中が明るい緑）
  const grad = g.createRadialGradient(o.cx, o.cy, 0, o.cx, o.cy, SIZE * 0.45);
  grad.addColorStop(0, '#C5DC8A');
  grad.addColorStop(1, '#5E8A3C');
  g.save();
  g.globalAlpha = 0.85;
  g.fillStyle = grad;
  g.fill(shape, 'evenodd');
  g.restore();
  g.lineWidth = 0.5;
  g.strokeStyle = '#4B6B30';
  g.stroke(shape);
  strokeVeins(g, shape, o, '#E6F2BF', 0.5, 0.8);
  // マスキングテープと日付
  g.save();
  g.translate(10, 4);
  g.rotate(-0.31);
  g.globalAlpha = 0.75;
  g.fillStyle = '#E7B7A5';
  g.fillRect(-9, -3, 18, 6.5);
  g.restore();
  g.fillStyle = '#6B5B3A';
  g.font = `700 4.6px Nunito, system-ui, sans-serif`;
  g.textAlign = 'right';
  g.fillText(dateText, SIZE + 1, SIZE + 2);
}

// ドット絵: 1 画素 = 1 つぶ。ふちは濃い緑、中は左上ほど明るい 4 段階（市松に少しずらす）
function drawPixel(g: CanvasRenderingContext2D, size: number, m: Mask) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#DDEFD2';
  g.fillRect(0, 0, size, size);
  const tones = ['#1F5A2E', '#2F7D3C', '#4C9F4A', '#8CCB6A', '#D6F0A8'];
  const dots = smallCanvas();
  const dg = dots.getContext('2d')!;
  const img = dg.createImageData(SIZE, SIZE);
  const rgb = tones.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && m[y * SIZE + x] === 1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!on(x, y)) continue;
      let t = 0;
      if (on(x - 1, y) && on(x + 1, y) && on(x, y - 1) && on(x, y + 1)) {
        const v = 1 - (x + y) / (2 * (SIZE - 1)) + ((x + y) % 2 ? 0.07 : -0.07);
        t = v > 0.72 ? 4 : v > 0.52 ? 3 : v > 0.34 ? 2 : 1;
      }
      img.data.set([...rgb[t], 255], (y * SIZE + x) * 4);
    }
  }
  dg.putImageData(img, 0, 0);
  const k = size / VIEW;
  g.imageSmoothingEnabled = false;
  g.drawImage(dots, 4 * k, 4 * k, SIZE * k, SIZE * k);
  g.imageSmoothingEnabled = true;
  g.lineWidth = Math.max(2, k * 0.8);
  g.strokeStyle = '#2F6B3A';
  g.strokeRect(k * 2.6, k * 2.6, size - k * 5.2, size - k * 5.2); // 角の丸みで切れないように、内側に
}

function strokeVeins(g: CanvasRenderingContext2D, shape: Path2D, o: Outline, color: string, width: number, alpha: number) {
  if (!o.veins) return;
  g.save();
  g.clip(shape, 'evenodd');
  g.globalAlpha = alpha;
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.stroke(new Path2D(o.veins));
  g.restore();
}

// 64×64 の下書き用のキャンバス（ふつうのキャンバス。古い Safari の OffscreenCanvas は 2D で描けないため）
function smallCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  return c;
}

// 形を、見た目 style で、size × size のキャンバスに描く
export function drawArt(canvas: HTMLCanvasElement, size: number, m: Mask, o: Outline, style: GachaStyle, dateText: string) {
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.save();
  if (style === 'cut') drawCut(g, size, o);
  else if (style === 'press') drawPress(g, size, o, dateText);
  else drawPixel(g, size, m);
  g.restore();
}

// 途中の形（0〜1。まだノイズが多い）を描く: 明るい背景に、値の大きい所ほど濃い緑。拡大は、なめらかに
export function drawStep(canvas: HTMLCanvasElement, size: number, x: Float32Array | null) {
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#EDE6D0';
  g.fillRect(0, 0, size, size);
  if (!x) return;
  const dots = smallCanvas();
  const dg = dots.getContext('2d')!;
  const img = dg.createImageData(SIZE, SIZE);
  const bg = [0xED, 0xE6, 0xD0], fg = [0x2F, 0x7D, 0x3C];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = Math.min(1, Math.max(0, x[i]));
    img.data.set([0, 1, 2].map(c => Math.round(bg[c] + (fg[c] - bg[c]) * v)).concat(255), i * 4);
  }
  dg.putImageData(img, 0, 0);
  const k = size / VIEW;
  g.imageSmoothingEnabled = true;
  g.drawImage(dots, 4 * k, 4 * k, SIZE * k, SIZE * k);
}
