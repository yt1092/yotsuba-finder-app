// 「今日のよつば」: 64×64 の形から、絵にするための線を作る（テスト: tests/gacha-outline.test.ts）
// - 輪郭: 形を少しぼかし（3×3）、0.5 の等高線を取り（marching squares）、角を丸める（Chaikin 法を 2 回）
// - 葉脈と葉ごとの色分け: 葉の数え方（src/lib/gacha-shape.ts の lobeDetails。妥当な形のチェックと同じ）の、葉の先と谷の向き
// 座標は、形の画素の座標（左上が 0・1 画素 = 1）。絵にするのは src/lib/gacha-draw.ts
import { SIZE, lobeDetails, type Mask } from './gacha-shape.ts';

export type Pt = [number, number];
const ISO = 0.5;
const PAD = 2;
const N = SIZE + PAD * 2;

// 形を、まわりに 2 画素の 0 を足して、3×3（1・2・1）でぼかす。値は画素の中心の点
function field(m: Mask): Float32Array {
  const g = new Float32Array(N * N);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) g[(y + PAD) * N + x + PAD] = m[y * SIZE + x];
  const out = new Float32Array(N * N);
  const k = [1, 2, 1];
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += k[dy + 1] * k[dx + 1] * g[(y + dy) * N + x + dx];
      out[y * N + x] = s / 16;
    }
  }
  return out;
}

// 等高線の輪（閉じた折れ線）。まわりが 0 なので、輪はかならず閉じる
export function contours(m: Mask): Pt[][] {
  const f = field(m);
  const at = (x: number, y: number) => f[y * N + x];
  const pts = new Map<string, Pt>();
  // 辺の上の点（2 つの格子点のあいだを、値で割り振る）。画素の座標に直す（格子点 (gx, gy) = 画素の中心 (gx - PAD + 0.5, …)）
  const edge = (h: boolean, x: number, y: number): string => {
    const key = `${h ? 'h' : 'v'}${x},${y}`;
    if (!pts.has(key)) {
      const a = at(x, y), b = h ? at(x + 1, y) : at(x, y + 1);
      const t = (ISO - a) / (b - a);
      pts.set(key, h ? [x + t - PAD + 0.5, y - PAD + 0.5] : [x - PAD + 0.5, y + t - PAD + 0.5]);
    }
    return key;
  };
  const segs: [string, string][] = [];
  for (let y = 0; y < N - 1; y++) {
    for (let x = 0; x < N - 1; x++) {
      const tl = at(x, y) >= ISO, tr = at(x + 1, y) >= ISO, br = at(x + 1, y + 1) >= ISO, bl = at(x, y + 1) >= ISO;
      const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const T = () => edge(true, x, y), B = () => edge(true, x, y + 1), L = () => edge(false, x, y), R = () => edge(false, x + 1, y);
      const mid = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 >= ISO;
      switch (c) {
        case 1: case 14: segs.push([L(), B()]); break;
        case 2: case 13: segs.push([B(), R()]); break;
        case 3: case 12: segs.push([L(), R()]); break;
        case 4: case 11: segs.push([T(), R()]); break;
        case 6: case 9: segs.push([T(), B()]); break;
        case 7: case 8: segs.push([L(), T()]); break;
        case 5: // 右上と左下が中: まん中も中なら、つながっている
          if (mid) segs.push([L(), T()], [B(), R()]); else segs.push([T(), R()], [L(), B()]);
          break;
        case 10: // 左上と右下が中
          if (mid) segs.push([T(), R()], [L(), B()]); else segs.push([L(), T()], [B(), R()]);
          break;
      }
    }
  }
  // 辺を共有する線分をつないで、輪にする
  const byEdge = new Map<string, number[]>();
  segs.forEach(([a, b], i) => { for (const e of [a, b]) byEdge.set(e, [...(byEdge.get(e) ?? []), i]); });
  const used = new Uint8Array(segs.length);
  const loops: Pt[][] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const start = segs[s][0];
    const loop = [pts.get(start)!];
    let cur = segs[s][1];
    while (cur !== start) {
      loop.push(pts.get(cur)!);
      const next = (byEdge.get(cur) ?? []).find(i => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      cur = segs[next][0] === cur ? segs[next][1] : segs[next][0];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// 角を丸める（Chaikin 法。辺を 1:3 と 3:1 に分ける点でつなぎ直す）
export function chaikin(loop: Pt[], times = 2): Pt[] {
  let p = loop;
  for (let t = 0; t < times; t++) {
    const q: Pt[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = q;
  }
  return p;
}

// 輪の面積（向きつき。外の輪と穴で符号が逆になる）
export function loopArea(loop: Pt[]): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

const num = (v: number) => String(Math.round(v * 100) / 100);
const pathOf = (loops: Pt[][]) => loops.map(l => 'M' + l.map(p => `${num(p[0])} ${num(p[1])}`).join('L') + 'Z').join('');

// 絵にするための線: 輪郭（なめらか）・葉脈・葉ごとの扇形（葉が 4 枚と数えられたときだけ）
export interface Outline {
  d: string;          // 輪郭（SVG の path の書き方。Path2D にそのまま渡せる。塗るときは evenodd）
  veins: string;      // 葉脈（線）
  wedges: string[];   // 葉ごとの扇形（形と重ねて切り抜くと、1 枚の葉になる）
  cx: number;
  cy: number;
}

export function outline(m: Mask): Outline {
  const d = pathOf(contours(m).map(l => chaikin(l)));
  const lb = lobeDetails(m);
  const { cx, cy } = lb;
  if (lb.count !== 4 || lb.valleys.length !== 4) return { d, veins: '', wedges: [], cx, cy };
  const at = (a: number, r: number): Pt => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  const line = (a: Pt, b: Pt) => `M${num(a[0])} ${num(a[1])}L${num(b[0])} ${num(b[1])}`;
  // 葉脈: 重心から葉の先へ 1 本（先の手前まで）と、そのまん中あたりから、左右に 1 本ずつ
  let veins = '';
  for (const tip of lb.tips) {
    veins += line(at(tip.angle, tip.r * 0.12), at(tip.angle, tip.r * 0.86));
    const base = at(tip.angle, tip.r * 0.42);
    for (const side of [-1, 1]) {
      const a = tip.angle + side * 0.42;
      veins += line(base, [base[0] + Math.cos(a) * tip.r * 0.3, base[1] + Math.sin(a) * tip.r * 0.3]);
    }
  }
  // 扇形: 葉 k は、谷 k-1 から谷 k まで（向きが増える方へ）
  const wedges = lb.tips.map((_, k) => {
    const a0 = lb.valleys[(k + 3) % 4];
    let a1 = lb.valleys[k];
    if (a1 <= a0) a1 += Math.PI * 2;
    const ring: Pt[] = [[cx, cy]];
    for (let i = 0; i <= 24; i++) ring.push(at(a0 + ((a1 - a0) * i) / 24, SIZE * 2));
    return pathOf([ring]);
  });
  return { d, veins, wedges, cx, cy };
}
