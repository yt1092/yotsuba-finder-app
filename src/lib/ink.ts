// 日記カードの「手書き」: 線とシールのデータ・座標の変換・「もどす」・描画
// 座標は、カードの中の位置を 0〜1 に直したもの（カードの大きさが変わっても、同じ見た目で描けるように）
// データの変換と「もどす」は、画面に頼らない（Node.js でそのままテストできるように: tests/ink.test.ts）。描画は canvas

export type InkColor = 'black' | 'blue' | 'red' | 'green' | 'pink' | 'brown';

export const INK_COLORS: { id: InkColor; name: string; hex: string }[] = [
  { id: 'black', name: 'くろ', hex: '#2B2B2B' },
  { id: 'blue', name: 'あお', hex: '#2F6FD0' },
  { id: 'red', name: 'あか', hex: '#D9372B' },
  { id: 'green', name: 'みどり', hex: '#2E8B3E' },
  { id: 'pink', name: 'ピンク', hex: '#F06C9B' },
  { id: 'brown', name: 'ちゃいろ', hex: '#8A5A2B' },
];

// 線の太さ（カードの幅に対する割合。1080px のカードで 約 7・12・20px）
export const INK_SIZES = [0.0065, 0.011, 0.0185];
// けしゴムの太さ（ペンの太さの倍）
export const ERASER_SCALE = 2.6;

export type StickerKind = 'clover' | 'star' | 'heart' | 'hanamaru';
export const STICKER_KINDS: { id: StickerKind; name: string }[] = [
  { id: 'clover', name: '四つ葉' },
  { id: 'star', name: 'ほし' },
  { id: 'heart', name: 'ハート' },
  { id: 'hanamaru', name: 'はなまる' },
];
// シールの大きさ（カードの幅に対する割合）
export const STICKER_SIZES = [0.09, 0.14, 0.2];

export type InkPoint = [x: number, y: number, pressure: number];

export interface InkStroke {
  kind: 'line';
  color: InkColor;
  size: number;      // 太さ（カードの幅に対する割合）
  erase?: boolean;   // けしゴム（手書きの線だけを消す。カードの絵や写真は消えない）
  points: InkPoint[];
}

export interface InkSticker {
  kind: 'sticker';
  type: StickerKind;
  x: number;
  y: number;
  size: number;      // 大きさ（カードの幅に対する割合）
}

export type InkItem = InkStroke | InkSticker;

export interface Ink {
  v: 1;
  items: InkItem[];
}

export const emptyInk = (): Ink => ({ v: 1, items: [] });
export const hasInk = (ink: Ink | undefined | null): boolean => !!ink && ink.items.some(i => i.kind === 'sticker' || !i.erase);

// ── 座標の変換 ──

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// 画面の位置（clientX・clientY）を、カードの中の位置（0〜1）にする。rect は、画面に出ているカードの範囲
export function toCard(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): [number, number] {
  return [round4(clamp01((clientX - rect.left) / rect.width)), round4(clamp01((clientY - rect.top) / rect.height))];
}

// カードの中の位置（0〜1）を、width × height の画像の上の位置（px）にする
export function fromCard(x: number, y: number, width: number, height: number): [number, number] {
  return [x * width, y * height];
}

// 筆圧（0〜1）を、保存する値にする（ペン以外は 0.5）
export const pressureOf = (pointerType: string, pressure: number): number =>
  pointerType === 'pen' && pressure > 0 ? round4(clamp01(pressure)) : 0.5;

// ── 保存したデータを読む（壊れたところは捨てる）──

const COLOR_IDS = new Set(INK_COLORS.map(c => c.id));
const STICKER_IDS = new Set(STICKER_KINDS.map(s => s.id));
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseInk(raw: unknown): Ink {
  const items: InkItem[] = [];
  const list = (raw as { items?: unknown })?.items;
  if (!Array.isArray(list)) return emptyInk();
  for (const it of list as Record<string, unknown>[]) {
    if (it?.kind === 'line' && COLOR_IDS.has(it.color as InkColor) && num(it.size) && Array.isArray(it.points)) {
      const points = (it.points as unknown[]).filter((p): p is InkPoint => Array.isArray(p) && p.length === 3 && p.every(num))
        .map(([x, y, p]) => [clamp01(x), clamp01(y), clamp01(p)] as InkPoint);
      if (points.length) items.push({ kind: 'line', color: it.color as InkColor, size: it.size, ...(it.erase ? { erase: true } : {}), points });
    } else if (it?.kind === 'sticker' && STICKER_IDS.has(it.type as StickerKind) && num(it.x) && num(it.y) && num(it.size)) {
      items.push({ kind: 'sticker', type: it.type as StickerKind, x: clamp01(it.x), y: clamp01(it.y), size: it.size });
    }
  }
  return { v: 1, items };
}

// ── 「もどす」（50 回前まで）──

export const UNDO_LIMIT = 50;

export class InkHistory {
  private past: InkItem[][] = [];
  private items: InkItem[];
  constructor(items: InkItem[] = []) {
    this.items = items;
  }

  get ink(): Ink { return { v: 1, items: this.items }; }
  get canUndo(): boolean { return this.past.length > 0; }

  private save() {
    this.past.push(this.items);
    if (this.past.length > UNDO_LIMIT) this.past.shift();
  }

  add(item: InkItem) {
    this.save();
    this.items = [...this.items, item];
  }

  clear() {
    if (this.items.length === 0) return;
    this.save();
    this.items = [];
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.items = prev;
    return true;
  }
}

// ── シールの形（SVG のパス。-50〜50 の四角の中。画面のボタンにも、カードの描画にも同じ形を使う）──

const leaf = 'M0 0 C-27 -6 -33 -40 -8 -42 C-3 -42 0 -38 0 -34 C0 -38 3 -42 8 -42 C33 -40 27 -6 0 0Z';
function starPath(): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const r = i % 2 === 0 ? 46 : 19;
    pts.push(`${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r + 3).toFixed(1)}`);
  }
  return `M${pts.join(' L')}Z`;
}
function flowerOutline(): string {
  // はなまるの外側: 円のまわりに、半円のふくらみを 10 こ並べた、なみなみの丸（1 本の線）
  const n = 10, R = 34;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const t = (i * 2 * Math.PI) / n - Math.PI / 2;
    return [Math.cos(t) * R, Math.sin(t) * R];
  });
  const half = (2 * R * Math.sin(Math.PI / n)) / 2;
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i <= n; i++) d += ` A${half.toFixed(1)} ${half.toFixed(1)} 0 0 1 ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
  return d + 'Z';
}
const SPIRAL = 'M3 -1 C3 -7 -6 -8 -8 -1 C-10 7 -1 13 7 10 C16 6 17 -8 9 -15 C1 -21 -14 -19 -19 -9 C-23 0 -20 12 -12 18';

export interface StickerPart { d: string; fill?: string; stroke?: string; width?: number; rotate?: number }

export const STICKER_SHAPES: Record<StickerKind, StickerPart[]> = {
  clover: [
    { d: 'M2 6 Q8 26 4 44', stroke: '#3E8E47', width: 6 },
    ...[45, 135, 225, 315].map(rotate => ({ d: leaf, fill: '#4FA858', stroke: '#2E7D3A', width: 2, rotate })),
  ],
  star: [{ d: starPath(), fill: '#F7C33C', stroke: '#C98A12', width: 3 }],
  heart: [{ d: 'M0 38 C-46 8 -44 -32 -16 -34 C-6 -35 0 -27 0 -21 C0 -27 6 -35 16 -34 C44 -32 46 8 0 38Z', fill: '#F25C7A', stroke: '#C23A57', width: 3 }],
  hanamaru: [
    { d: flowerOutline(), stroke: '#E0352B', width: 5 },
    { d: SPIRAL, stroke: '#E0352B', width: 5 },
  ],
};

// シールの SVG（画面のボタン用）
export function stickerSvg(type: StickerKind, px: number): string {
  const parts = STICKER_SHAPES[type].map(p =>
    `<path d="${p.d}" fill="${p.fill ?? 'none'}" stroke="${p.stroke ?? 'none'}" stroke-width="${p.width ?? 0}" stroke-linecap="round" stroke-linejoin="round"${p.rotate ? ` transform="rotate(${p.rotate})"` : ''}/>`).join('');
  return `<svg width="${px}" height="${px}" viewBox="-54 -54 108 108" aria-hidden="true">${parts}</svg>`;
}

// ── 描画（カードにも、書いている画面にも、同じ関数で描く）──

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// 手書きの層を、g の上に描く（width × height はカードの大きさ）。順番は、線 → シール
export function drawInk(g: Ctx, ink: Ink, width: number, height: number, makeLayer: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas): void {
  const lines = ink.items.filter((i): i is InkStroke => i.kind === 'line');
  if (lines.length) {
    // 線は別の層に描く（けしゴムが、手書きの線だけを消すように）
    const layer = makeLayer(width, height);
    const lg = layer.getContext('2d') as Ctx;
    for (const s of lines) drawStroke(lg, s, width, height);
    g.drawImage(layer, 0, 0);
  }
  for (const st of ink.items) if (st.kind === 'sticker') drawSticker(g, st, width, height);
}

// 線: 点と点のあいだを、2 次曲線でなめらかにつなぐ（中点を通り、点を制御点にする）。太さは筆圧で変える
export function drawStroke(g: Ctx, s: InkStroke, width: number, height: number): void {
  const base = s.size * width * (s.erase ? ERASER_SCALE : 1);
  const pts = s.points.map(([x, y, p]) => [x * width, y * height, p] as const);
  g.save();
  g.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  g.strokeStyle = g.fillStyle = s.erase ? '#000' : (INK_COLORS.find(c => c.id === s.color)?.hex ?? '#2B2B2B');
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const w = (p: number) => base * (0.5 + p); // 筆圧 0.5（ペン以外）でちょうど base
  if (pts.length === 1) {
    g.beginPath();
    g.arc(pts[0][0], pts[0][1], w(pts[0][2]) / 2, 0, Math.PI * 2);
    g.fill();
  } else {
    let [px, py] = [pts[0][0], pts[0][1]];
    for (let i = 1; i < pts.length; i++) {
      const [cx, cy, cp] = pts[i - 1];
      const [nx, ny, np] = pts[i];
      const mx = (cx + nx) / 2, my = (cy + ny) / 2;
      g.beginPath();
      g.lineWidth = w((cp + np) / 2);
      g.moveTo(px, py);
      if (i === 1) g.lineTo(mx, my);
      else g.quadraticCurveTo(cx, cy, mx, my);
      g.stroke();
      [px, py] = [mx, my];
    }
    const [lx, ly, lp] = pts[pts.length - 1];
    g.beginPath();
    g.lineWidth = w(lp);
    g.moveTo(px, py);
    g.lineTo(lx, ly);
    g.stroke();
  }
  g.restore();
}

// シール: 白いふちどり（シールらしく）→ 形
export function drawSticker(g: Ctx, st: InkSticker, width: number, height: number): void {
  const [x, y] = fromCard(st.x, st.y, width, height);
  const k = (st.size * width) / 108;
  g.save();
  g.translate(x, y);
  g.scale(k, k);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const pass of ['edge', 'shape'] as const) {
    for (const part of STICKER_SHAPES[st.type]) {
      g.save();
      if (part.rotate) g.rotate((part.rotate * Math.PI) / 180);
      const path = new Path2D(part.d);
      if (pass === 'edge') {
        g.strokeStyle = '#FFFFFF';
        g.lineWidth = (part.width ?? 0) + 12;
        g.stroke(path);
        if (part.fill) { g.fillStyle = '#FFFFFF'; g.fill(path); }
      } else {
        if (part.fill) { g.fillStyle = part.fill; g.fill(path); }
        if (part.stroke) { g.strokeStyle = part.stroke; g.lineWidth = part.width ?? 1; g.stroke(path); }
      }
      g.restore();
    }
  }
  g.restore();
}
