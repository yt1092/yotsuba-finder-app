// 日記風のシェアカード（1080×1350）を、端末の中だけで canvas に描く
// 外部の画像は使わない（紙のざらつき・テープ・シール・星も、すべて canvas で描く）
// 画像には、位置情報などのメタデータは入らない（canvas から書き出した画像には付かない）
import type { Detection } from './detector';
import type { LeafCounts } from './leaf-count';
import { diaryDate, diaryCountLine, fitNote, splitAtSpace } from './diary-text';
import { HAND, STAMP, loadDiaryFonts } from './diary-fonts';
import { drawInk, type Ink } from './ink';

type Box = Detection['bbox'];

export const CARD_W = 1080;
export const CARD_H = 1350;

export type DiaryTheme = 'cream' | 'green';

export interface DiaryCardInput {
  photo: ImageBitmap;   // 写真（向きを直したもの）
  focus?: Box;          // 四つ葉の枠（写真の座標）。無ければ写真の真ん中を使う
  date: number;
  counts?: LeafCounts;
  source?: 'camera' | 'photo' | 'gacha'; // 記録の出どころ（今日のよつばは「今日のよつばが できた！」。src/lib/diary-text.ts）
  note: string;         // ひとこと（空でもよい）
  theme: DiaryTheme;
  ink?: Ink;            // 手書きの線とシール（src/lib/ink.ts）。紙 → 写真 → 文字 → 手書きの線 → シール の順に描く
}

const THEMES: Record<DiaryTheme, {
  paper: string; paperEdge: string; line: string; margin: string; ink: string; accent: string; stamp: string; tapes: [string, string];
  countInk: string; // 葉の数の文の色（濃い緑）
}> = {
  cream: {
    paper: '#FBF3E0', paperEdge: 'rgba(196,160,96,0.22)', line: 'rgba(110,135,180,0.30)', margin: 'rgba(214,110,98,0.35)',
    ink: '#46392E', accent: '#2E6B3C', stamp: '#C8553D', tapes: ['rgba(242,184,75,0.55)', 'rgba(118,190,168,0.55)'], countInk: '#1E4A2A',
  },
  green: {
    paper: '#EAF3E1', paperEdge: 'rgba(110,150,100,0.22)', line: 'rgba(86,140,98,0.28)', margin: 'rgba(86,150,108,0.38)',
    ink: '#2F3B2F', accent: '#2E6B3C', stamp: '#2E7D4F', tapes: ['rgba(255,166,166,0.55)', 'rgba(250,212,110,0.60)'], countInk: '#1B4426',
  },
};

// 罫線（上から LINE_TOP、LINE_GAP ごと）。文は罫線の少し上に書く
const LINE_TOP = 238;
const LINE_GAP = 64;
const lineY = (n: number) => LINE_TOP + LINE_GAP * n;
const LEFT = 96;
const RIGHT = CARD_W - 84;

// 写真（白いふちを含む正方形）
const PHOTO = 660;  // 写真の部分
const BORDER = 26;  // 白いふち
const PHOTO_CX = CARD_W / 2;
const PHOTO_CY = 598;
const PHOTO_TILT = -2 * Math.PI / 180;

export async function drawDiaryCard(input: DiaryCardInput): Promise<HTMLCanvasElement> {
  const t = THEMES[input.theme];
  const date = diaryDate(input.date);
  const countLine = diaryCountLine(input.counts, input.source);
  // 描く前に、このカードの文字のフォントの読み込みを待つ（先読みが終わっていなくても、必要な分だけをその場で読み込む）
  await loadDiaryFonts(date + countLine + input.note);

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const g = canvas.getContext('2d')!;
  const rand = mulberry32(Math.floor(input.date / 1000) ^ (input.theme === 'green' ? 0x9e3779b9 : 0));

  drawPaper(g, t, rand);

  // 上: 日付（手書き風）と、右上のスタンプ
  g.fillStyle = t.ink;
  g.font = `600 56px ${HAND}`;
  g.textBaseline = 'alphabetic';
  g.fillText(date, LEFT + 8, lineY(-1) - 14);
  drawStamp(g, t.stamp, rand);

  // 中: 写真（白いふち・-2 度・テープ・やわらかい影）
  drawPhoto(g, input.photo, input.focus, t, rand);

  // 下: 葉の数（手書き風。濃い緑で、ひとことと同じくらいの大きさ。1 行に入らなければ、空白のところで 2 行に）
  g.fillStyle = t.countInk;
  let size = 48;
  g.font = `600 ${size}px ${HAND}`;
  const countLines = splitAtSpace(countLine, RIGHT - LEFT, s => g.measureText(s).width);
  while (countLines.some(l => g.measureText(l).width > RIGHT - LEFT) && size > 30) g.font = `600 ${--size}px ${HAND}`;
  g.textAlign = 'center';
  countLines.forEach((line, i) => g.fillText(line, CARD_W / 2, lineY(13 + i) - 12));

  // いちばん下: 罫線の上に、ひとこと（2 行まで。長いときは文字を小さくする。空なら罫線だけ）
  g.textAlign = 'left';
  g.fillStyle = t.ink;
  const measureAt = (size: number) => { g.font = `400 ${size}px ${HAND}`; return (s: string) => g.measureText(s).width; };
  const note = fitNote(input.note, RIGHT - LEFT - 24, measureAt, [44, 40, 36, 32]);
  g.font = `400 ${note.size}px ${HAND}`;
  note.lines.forEach((line, i) => g.fillText(line, LEFT + 16, lineY(15 + i) - 12));

  drawDecorations(g, rand);
  if (input.ink) drawInk(g, input.ink, CARD_W, CARD_H, makeCanvas);
  return canvas;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// カードを画像（JPEG）にする。canvas から書き出すので、位置情報などのメタデータは入らない
export function cardToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/jpeg', 0.92));
}

// ── 紙 ──

function drawPaper(g: CanvasRenderingContext2D, t: typeof THEMES.cream, rand: () => number) {
  g.fillStyle = t.paper;
  g.fillRect(0, 0, CARD_W, CARD_H);

  // ふちを少しだけ暗く（古い紙のように）
  const v = g.createRadialGradient(CARD_W / 2, CARD_H / 2, CARD_H * 0.35, CARD_W / 2, CARD_H / 2, CARD_H * 0.8);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, t.paperEdge);
  g.fillStyle = v;
  g.fillRect(0, 0, CARD_W, CARD_H);

  // 紙のざらつき: 小さな画像にノイズを描き、拡大してやわらかく重ねる
  const nw = 270, nh = 338;
  const noise = document.createElement('canvas');
  noise.width = nw;
  noise.height = nh;
  const ng = noise.getContext('2d')!;
  const data = ng.createImageData(nw, nh);
  for (let i = 0; i < nw * nh; i++) {
    const shade = rand() < 0.5 ? 0 : 255;
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = shade;
    data.data[i * 4 + 3] = Math.floor(rand() * 13);
  }
  ng.putImageData(data, 0, 0);
  g.save();
  g.imageSmoothingEnabled = true;
  g.drawImage(noise, 0, 0, CARD_W, CARD_H);
  g.restore();
  // 細かい点（紙の繊維）
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(90,70,40,${0.03 + rand() * 0.06})`;
    g.fillRect(rand() * CARD_W, rand() * CARD_H, 1 + rand() * 2, 1 + rand() * 1.5);
  }

  // うすい罫線と、左の余白の線
  g.strokeStyle = t.line;
  g.lineWidth = 2;
  for (let n = -1; lineY(n) < CARD_H - 40; n++) {
    g.beginPath();
    g.moveTo(48, lineY(n));
    g.lineTo(CARD_W - 48, lineY(n));
    g.stroke();
  }
  g.strokeStyle = t.margin;
  g.beginPath();
  g.moveTo(LEFT - 16, 40);
  g.lineTo(LEFT - 16, CARD_H - 40);
  g.stroke();
}

// ── スタンプ（右上。丸いふちの四角を少し傾け、インクのかすれを付ける）──

function drawStamp(g: CanvasRenderingContext2D, color: string, rand: () => number) {
  const w = 280, h = 80;
  const s = document.createElement('canvas');
  s.width = w + 20;
  s.height = h + 20;
  const sg = s.getContext('2d')!;
  sg.strokeStyle = color;
  sg.fillStyle = color;
  sg.lineWidth = 5;
  roundRect(sg, 10, 10, w, h, 18);
  sg.stroke();
  sg.lineWidth = 1.5;
  roundRect(sg, 18, 18, w - 16, h - 16, 12);
  sg.stroke();
  sg.font = `800 24px ${STAMP}`;
  sg.textAlign = 'center';
  sg.textBaseline = 'middle';
  if ('letterSpacing' in sg) (sg as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '2px';
  sg.fillText('YOTSUBA FINDER', 10 + w / 2, 10 + h / 2 + 1);
  // かすれ: ところどころ、インクを消す
  sg.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    sg.fillStyle = `rgba(0,0,0,${0.3 + rand() * 0.6})`;
    sg.beginPath();
    sg.arc(rand() * s.width, rand() * s.height, 0.6 + rand() * 1.8, 0, Math.PI * 2);
    sg.fill();
  }
  g.save();
  g.globalAlpha = 0.85;
  g.translate(CARD_W - 64 - w / 2, 104);
  g.rotate(-7 * Math.PI / 180);
  g.drawImage(s, -s.width / 2, -s.height / 2);
  g.restore();
}

// ── 写真 ──

// 四つ葉を、まわりの景色つきで、正方形に切り抜く範囲（写真の中に収める）
export function photoSquare(width: number, height: number, focus?: Box): { x: number; y: number; size: number } {
  const short = Math.min(width, height);
  if (!focus) return { x: (width - short) / 2, y: (height - short) / 2, size: short };
  const size = Math.min(short, Math.max(Math.max(focus.w, focus.h) / 0.35, short * 0.25));
  const cx = focus.x + focus.w / 2, cy = focus.y + focus.h / 2;
  const x = Math.min(Math.max(cx - size / 2, 0), width - size);
  const y = Math.min(Math.max(cy - size / 2, 0), height - size);
  return { x, y, size };
}

function drawPhoto(g: CanvasRenderingContext2D, photo: ImageBitmap, focus: Box | undefined, t: typeof THEMES.cream, rand: () => number) {
  const outer = PHOTO + BORDER * 2;
  g.save();
  g.translate(PHOTO_CX, PHOTO_CY);
  g.rotate(PHOTO_TILT);

  // やわらかい影（写真の下）
  g.save();
  g.shadowColor = 'rgba(60,40,20,0.30)';
  g.shadowBlur = 40;
  g.shadowOffsetY = 18;
  g.fillStyle = '#FFFFFF';
  g.fillRect(-outer / 2, -outer / 2, outer, outer);
  g.restore();

  // 白いふちと写真
  g.fillStyle = '#FFFFFF';
  g.fillRect(-outer / 2, -outer / 2, outer, outer);
  const sq = photoSquare(photo.width, photo.height, focus);
  g.drawImage(photo, sq.x, sq.y, sq.size, sq.size, -PHOTO / 2, -PHOTO / 2, PHOTO, PHOTO);
  g.strokeStyle = 'rgba(0,0,0,0.06)';
  g.lineWidth = 2;
  g.strokeRect(-PHOTO / 2, -PHOTO / 2, PHOTO, PHOTO);

  // マスキングテープ（上の左右の角。半透明の色つきの帯を、少し傾ける）
  drawTape(g, -outer / 2 + 36, -outer / 2 + 6, -38, t.tapes[0], rand);
  drawTape(g, outer / 2 - 36, -outer / 2 + 6, 36, t.tapes[1], rand);
  g.restore();
}

function drawTape(g: CanvasRenderingContext2D, x: number, y: number, deg: number, color: string, rand: () => number) {
  const w = 220, h = 58;
  g.save();
  g.translate(x, y);
  g.rotate(deg * Math.PI / 180);
  g.fillStyle = color;
  g.beginPath();
  // 両はしは、手でちぎったように、ぎざぎざにする
  g.moveTo(-w / 2, -h / 2);
  g.lineTo(w / 2, -h / 2);
  for (let i = 1; i <= 6; i++) g.lineTo(w / 2 + (i % 2 ? -6 : 0) - rand() * 3, -h / 2 + (h * i) / 6);
  g.lineTo(-w / 2, h / 2);
  for (let i = 5; i >= 0; i--) g.lineTo(-w / 2 + (i % 2 ? 6 : 0) + rand() * 3, -h / 2 + (h * i) / 6);
  g.closePath();
  g.fill();
  // テープの、うすいすじ
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    g.beginPath();
    g.moveTo(-w / 2 + 8, -h / 2 + (h * i) / 4);
    g.lineTo(w / 2 - 8, -h / 2 + (h * i) / 4);
    g.stroke();
  }
  g.restore();
}

// ── 飾り（文字のない、四つ葉のシールと星）──

function drawDecorations(g: CanvasRenderingContext2D, rand: () => number) {
  // 四つ葉のシール（写真の右下に、少しはみ出して貼る）
  g.save();
  g.translate(PHOTO_CX + 336, PHOTO_CY + 286);
  g.rotate(12 * Math.PI / 180);
  g.shadowColor = 'rgba(60,40,20,0.25)';
  g.shadowBlur = 10;
  g.shadowOffsetY = 4;
  g.fillStyle = '#FFFFFF';
  g.beginPath();
  g.arc(0, 0, 62, 0, Math.PI * 2);
  g.fill();
  g.shadowColor = 'transparent';
  drawClover(g, 0, 0, 34);
  g.restore();

  // 星（文字に重ならない、紙の余白と写真のまわり）
  const stars: [number, number, number, string][] = [
    [52, 120, 14, '#F2B84B'], [1036, 196, 10, '#F2B84B'], [124, 300, 12, '#9BD083'], [1000, 980, 14, '#F2B84B'], [140, 990, 10, '#F2B84B'],
  ];
  for (const [x, y, r, c] of stars) drawStar(g, x + (rand() - 0.5) * 6, y + (rand() - 0.5) * 6, r, c);
}

function drawClover(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.save();
  g.translate(x, y);
  g.rotate(8 * Math.PI / 180);
  g.strokeStyle = '#3E8E47';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(r * 0.3, r * 0.9, r * 0.1, r * 1.25);
  g.stroke();
  for (let i = 0; i < 4; i++) {
    g.save();
    g.rotate((i * Math.PI) / 2 + Math.PI / 4);
    const grad = g.createLinearGradient(0, 0, 0, -r);
    grad.addColorStop(0, '#7CCB6A');
    grad.addColorStop(1, '#3E9A4A');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(-r * 0.95, -r * 0.35, -r * 0.75, -r * 1.25, 0, -r * 0.82);
    g.bezierCurveTo(r * 0.75, -r * 1.25, r * 0.95, -r * 0.35, 0, 0);
    g.fill();
    g.restore();
  }
  g.restore();
}

function drawStar(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  g.save();
  g.translate(x, y);
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.32;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
  g.restore();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// 同じ記録なら同じ模様になる、小さな乱数（紙のざらつき・テープのぎざぎざ用）
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
