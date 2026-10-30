// カメラの画面に、検出の枠を描く（src/lib/box-style.ts の見た目）
// - 三つ葉: 細い白の枠（ラベルなし）
// - 四つ葉: 金色の枠（濃い縁取り）・四隅の印・「四つ葉 ●●●」のラベル
//   追っているあいだ（まだ安定していない）は点線と、安定までの進み具合の輪。安定したら実線
// - 上のバーと、下のボタンの範囲には描かない（押せる範囲にかぶせない）
// - 開発者向けの表示がオンなら、枠ごとに、クラス・スコアの数字・追跡の回数も出す
import type { Detection } from '../lib/detector';
import { GOLD, GOLD_EDGE, THREE_EDGE, THREE_LINE, devLabel, fourLabel } from '../lib/box-style';
import { coverMap, labelPos, overlaps, type Rect } from '../lib/overlay-geom';
import { DEBUG_BUILD } from '../lib/dev-mode';

export interface ScanOverlayInput {
  detections: Detection[];
  video: { w: number; h: number };       // 映像の大きさ
  view: { w: number; h: number };        // 画面（canvas の CSS px）
  area: { top: number; bottom: number }; // 描いてよい縦の範囲（上のバーの下〜下のボタンの上。CSS px）
  tracked?: Detection;                   // 追っている四つ葉（いちばんスコアの高いもの）
  hits: number;                          // 追っている四つ葉が、同じ場所に出た回数
  needed: number;                        // 安定とみなす回数
  stable: boolean;                       // 安定した（スキャンを止めた）
  dev: boolean;                          // 開発者向けの表示
  rings?: boolean;                       // 進み具合の輪を描く（?rings=0 なら描かない。診断用）
}

const FONT = '700 15px "Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif';
const DEV_FONT = '700 14px ui-monospace, monospace';

export function drawScanOverlay(ctx: CanvasRenderingContext2D, o: ScanOverlayInput): void {
  ctx.clearRect(0, 0, o.view.w, o.view.h);
  const m = coverMap(o.video.w, o.video.h, o.view.w, o.view.h);
  const toView = (d: Detection): Rect => ({ x: m.ox + d.bbox.x * m.s, y: m.oy + d.bbox.y * m.s, w: d.bbox.w * m.s, h: d.bbox.h * m.s });
  const area = { left: 4, right: o.view.w - 4, top: o.area.top, bottom: o.area.bottom };

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, o.area.top, o.view.w, o.area.bottom - o.area.top);
  ctx.clip();

  // 三つ葉（先に描く。四つ葉を上に重ねる）
  for (const d of o.detections) {
    if (d.label === '四つ葉') continue;
    const r = toView(d);
    strokeRect(ctx, r, THREE_EDGE, 3, []);
    strokeRect(ctx, r, THREE_LINE, 1.5, []);
    if (DEBUG_BUILD && o.dev) chip(ctx, r, devLabel(d), area, DEV_FONT, 'rgba(0,0,0,0.6)', '#FFFFFF');
  }

  // 四つ葉（追っているものを先に、あとはスコアの高い順。ほかのラベルと重なるラベルは出さない）
  const placed: Rect[] = [];
  const fours = o.detections.filter(d => d.label === '四つ葉')
    .sort((a, b) => Number(b === o.tracked) - Number(a === o.tracked) || (b.score ?? 0) - (a.score ?? 0));
  for (const d of fours) {
    const r = toView(d);
    const isTracked = d === o.tracked;
    const solid = isTracked && o.stable;
    const dash = solid ? [] : [10, 6];
    strokeRect(ctx, r, GOLD_EDGE, 7, dash);
    strokeRect(ctx, r, GOLD, 4, dash);
    corners(ctx, r);
    const text = DEBUG_BUILD && o.dev ? `${fourLabel(d.score)}  ${devLabel(d, isTracked ? o.hits : undefined)}` : fourLabel(d.score);
    const pos = chip(ctx, r, text, area, DEBUG_BUILD && o.dev ? DEV_FONT : FONT, '#FFFFFF', '#3A2A00', isTracked && !o.stable ? 26 : 0, placed);
    // 安定までの進み具合（輪）: ラベルの右に
    if (pos && isTracked && !o.stable && o.rings !== false) progressRing(ctx, pos.x + pos.w - 16, pos.y + pos.h / 2, Math.min(1, o.hits / o.needed));
  }
  ctx.restore();
}

function strokeRect(ctx: CanvasRenderingContext2D, r: Rect, color: string, width: number, dash: number[]) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 8);
  ctx.stroke();
  ctx.setLineDash([]);
}

// 四隅の印（太い L の字。点線のときも、四隅だけは実線）
function corners(ctx: CanvasRenderingContext2D, r: Rect) {
  const L = Math.min(18, r.w / 3, r.h / 3);
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + L); ctx.lineTo(r.x, r.y); ctx.lineTo(r.x + L, r.y);
    ctx.moveTo(r.x + r.w - L, r.y); ctx.lineTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + L);
    ctx.moveTo(r.x + r.w, r.y + r.h - L); ctx.lineTo(r.x + r.w, r.y + r.h); ctx.lineTo(r.x + r.w - L, r.y + r.h);
    ctx.moveTo(r.x + L, r.y + r.h); ctx.lineTo(r.x, r.y + r.h); ctx.lineTo(r.x, r.y + r.h - L);
  };
  ctx.lineCap = 'round';
  ctx.strokeStyle = GOLD_EDGE; ctx.lineWidth = 9; path(); ctx.stroke();
  ctx.strokeStyle = GOLD; ctx.lineWidth = 6; path(); ctx.stroke();
  ctx.lineCap = 'butt';
}

// 白い背景の小さなチップ（ラベル）。置けないときは描かない
function chip(ctx: CanvasRenderingContext2D, r: Rect, text: string, area: { left: number; right: number; top: number; bottom: number },
  font: string, bg: string, fg: string, extraW = 0, placed?: Rect[]): { x: number; y: number; w: number; h: number } | null {
  ctx.font = font;
  const w = ctx.measureText(text).width + 20 + extraW, h = 28;
  const p = labelPos(r, w, h, area);
  if (!p) return null;
  if (placed) {
    const rect = { x: p.x, y: p.y, w, h };
    if (placed.some(q => overlaps(q, rect))) return null;
    placed.push(rect);
  }
  ctx.fillStyle = bg;
  ctx.strokeStyle = GOLD_EDGE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(p.x, p.y, w, h, 14);
  ctx.fill();
  if (bg === '#FFFFFF') ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, p.x + 10, p.y + h / 2 + 1);
  return { ...p, w, h };
}

function progressRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, ratio: number) {
  const R = 8;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(58,42,0,0.2)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#C08A00';
  ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio); ctx.stroke();
}
