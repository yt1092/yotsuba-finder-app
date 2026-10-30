// 「今日のよつば」: 作った形（64×64）の後処理と、「妥当な形」のチェック（テスト: tests/gacha-shape.test.ts）
// Python の training/validity.py・training/gacha_shape.py と同じ処理（同じ入力で同じ結果になることを、
// training/make_gacha_shape_fixture.py が作った答え tests/fixtures/gacha-shape-cases.json で確かめる）
//
// 「妥当な形」（作者の決定 2026-10-27。README の「今日のよつば」）
//   1. 0.5 で白黒にする
//   2. 後処理: 小さなかけら（MIN_PIECE 画素未満の、離れたかたまり）と、小さな穴（MIN_PIECE 画素未満）を消す
//   3. 葉がちょうど 4 枚・1 つにつながっている・穴がない・面積が全体の 12〜60%
// 形は Uint8Array（長さ 64×64。y * 64 + x。1 = 葉）

export const SIZE = 64;
export const THRESHOLD = 0.5;
export const MIN_PIECE = 20;
export const AREA_RANGE = [0.12, 0.6] as const;
export const VALLEY_RATIO = 0.9;
export const SMOOTH = 11;
export const BINS = 180;
const MIN_HOLE = 4;

export type Mask = Uint8Array;

export function binarize(x: ArrayLike<number>): Mask {
  if (x.length !== SIZE * SIZE) throw new Error(`形の大きさは ${SIZE}×${SIZE}（受け取った長さ: ${x.length}）`);
  const m = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) m[i] = x[i] >= THRESHOLD ? 1 : 0;
  return m;
}

// つながったかたまりに番号を付ける（1 から。上の行から、左から見て、先に見つかったかたまりほど小さい番号。OpenCV と同じ順）
// 戻り値: 番号の配列（0 = かたまりでない）と、番号ごとの画素の数（areas[0] は使わない）
function label(on: Uint8Array, w: number, h: number, conn: 4 | 8): { lab: Int32Array; areas: number[] } {
  const lab = new Int32Array(w * h);
  const areas = [0];
  const stack: number[] = [];
  const dirs = conn === 8 ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  for (let start = 0; start < w * h; start++) {
    if (!on[start] || lab[start]) continue;
    const id = areas.length;
    let area = 0;
    lab[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % w, y = (p - x) / w;
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (on[q] && !lab[q]) { lab[q] = id; stack.push(q); }
      }
    }
    areas.push(area);
  }
  return { lab, areas };
}

// 背景（まわりに 1 画素の余白を足したもの）を 4 方向でつながったかたまりに分ける。外側 = 左上の角のかたまり
function background(m: Mask) {
  const w = SIZE + 2;
  const inv = new Uint8Array(w * w).fill(1);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) inv[(y + 1) * w + x + 1] = m[y * SIZE + x] ? 0 : 1;
  const { lab, areas } = label(inv, w, w, 4);
  return { lab, areas, outside: lab[0], w };
}

// 後処理: 小さなかけらと、小さな穴を消す
export function cleanup(m: Mask, minPx = MIN_PIECE): Mask {
  const out = Uint8Array.from(m, v => (v ? 1 : 0));
  const { lab, areas } = label(out, SIZE, SIZE, 8);
  if (areas.length > 1) {
    let big = 1;
    for (let i = 2; i < areas.length; i++) if (areas[i] > areas[big]) big = i; // 同じ大きさなら、先に見つかったほう
    for (let p = 0; p < out.length; p++) if (lab[p] && lab[p] !== big && areas[lab[p]] < minPx) out[p] = 0;
  }
  const bg = background(out);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const l = bg.lab[(y + 1) * bg.w + x + 1];
      if (l && l !== bg.outside && bg.areas[l] < minPx) out[y * SIZE + x] = 1;
    }
  }
  return out;
}

// 0.5 ちょうどのときは偶数にする丸め（numpy の rint と同じ）
function rint(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// 重心（画素の座標の平均）
function centroid(m: Mask): { cx: number; cy: number; n: number } {
  let sx = 0, sy = 0, n = 0;
  for (let p = 0; p < m.length; p++) if (m[p]) { sx += p % SIZE; sy += Math.floor(p / SIZE); n++; }
  return n ? { cx: sx / n, cy: sy / n, n } : { cx: 0, cy: 0, n };
}

// 区間 i の向き（ラジアン。-π〜π。画像の座標で、x は右・y は下）
export const binAngle = (i: number) => ((i + 0.5) / BINS) * 2 * Math.PI - Math.PI;

// 重心から、角度ごとに光線をのばし、形の中のいちばん遠い点までの距離（0.25 画素刻み）
export function radialProfile(m: Mask): Float64Array {
  const prof = new Float64Array(BINS);
  const { cx, cy, n } = centroid(m);
  if (!n) return prof;
  const steps = (SIZE * 0.75) / 0.25;
  for (let i = 0; i < BINS; i++) {
    const a = binAngle(i);
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = steps - 1; j >= 0; j--) {
      const r = j * 0.25;
      const px = rint(cx + ca * r), py = rint(cy + sa * r);
      if (px >= 0 && py >= 0 && px < SIZE && py < SIZE && m[py * SIZE + px]) { prof[i] = r; break; }
    }
  }
  return prof;
}

// 葉の分け方: 重心・葉の先（山）の向きと距離・葉どうしの境目（谷）の向き。tips[k] と tips[k + 1] のあいだが valleys[k]
export interface Lobes {
  count: number;
  cx: number;
  cy: number;
  tips: { angle: number; r: number }[];
  valleys: number[];
}

// 葉の数 = 葉どうしの境目（深い谷）の数。Python の gacha_shape.lobe_details と同じ手順
// （なめらかにするのは、となりの SMOOTH 区間の合計。距離を 4 倍した整数で足すので、足す順番で結果が変わらない）
// 向き（tips・valleys）は、絵の葉脈と、葉ごとの色分けに使う（src/lib/gacha-draw.ts）。数（count）は、向きを足す前と同じ
export function lobeDetails(m: Mask): Lobes {
  const { cx, cy } = centroid(m);
  const prof = radialProfile(m);
  let max = 0;
  for (const v of prof) max = Math.max(max, v);
  if (max <= 0) return { count: 0, cx, cy, tips: [], valleys: [] };
  const n = BINS, h = Math.floor(SMOOTH / 2);
  const q = Array.from(prof, v => rint(v * 4));
  const p: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -h; d <= h; d++) s += q[(i + d + n) % n];
    p.push(s);
  }
  type Ext = { kind: 'P' | 'V'; v: number; i: number };
  let ext: Ext[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
    const kind = b > a && b >= c ? 'P' : b < a && b <= c ? 'V' : null;
    if (!kind) continue;
    const last = ext[ext.length - 1];
    if (last && last.kind === kind) {
      if ((kind === 'P') === (b > last.v)) ext[ext.length - 1] = { kind, v: b, i };
    } else {
      ext.push({ kind, v: b, i });
    }
  }
  if (ext.length > 1 && ext[0].kind === ext[ext.length - 1].kind) {
    const first = ext[0], last = ext[ext.length - 1];
    const keep = (first.v >= last.v) === (first.kind === 'P') ? first : last;
    ext = [keep, ...ext.slice(1, -1)];
  }
  const px = 1 / (4 * SMOOTH);
  if (ext.length < 2) {
    const top = p.indexOf(Math.max(...p));
    return { count: 1, cx, cy, tips: [{ angle: binAngle(top), r: p[top] * px }], valleys: [] };
  }
  if (ext[0].kind === 'V') ext = [...ext.slice(1), ext[0]];
  let peaks = ext.filter(e => e.kind === 'P');
  let vals = ext.filter(e => e.kind === 'V'); // vals[i] は peaks[i] と peaks[i + 1] のあいだ
  const ratios = () => vals.map((v, i) => v.v / Math.min(peaks[i].v, peaks[(i + 1) % peaks.length].v));
  while (vals.length > 1) {
    const r = ratios();
    let i = 0;
    for (let k = 1; k < r.length; k++) if (r[k] > r[i]) i = k;
    if (r[i] < VALLEY_RATIO) break;
    if (i === vals.length - 1) { // 最後の谷（最後の山と最初の山のあいだ）は、並びをずらしてから
      peaks = [...peaks.slice(1), peaks[0]];
      vals = [...vals.slice(1), vals[0]];
      i--;
    }
    peaks[i] = peaks[i + 1].v > peaks[i].v ? peaks[i + 1] : peaks[i];
    peaks.splice(i + 1, 1);
    vals.splice(i, 1);
  }
  return {
    count: Math.max(1, vals.length),
    cx, cy,
    tips: peaks.map(e => ({ angle: binAngle(e.i), r: e.v * px })),
    valleys: vals.map(e => binAngle(e.i)),
  };
}

export function countLobes(m: Mask): number {
  return lobeDetails(m).count;
}

export interface ShapeCheck {
  lobes: number;
  pieces: number;      // 葉のかたまりの数（8 方向）
  backgrounds: number; // 背景のかたまりの数（外側 ＋ MIN_HOLE 画素以上の穴）
  areaRatio: number;
  reasons: string[];   // 通らなかった理由（Python の gacha_shape.check と同じ文）
}

export function checkShape(m: Mask): ShapeCheck {
  const { areas } = label(m, SIZE, SIZE, 8);
  const pieces = areas.length - 1;
  const bg = background(m);
  let backgrounds = 0;
  for (let i = 1; i < bg.areas.length; i++) if (i === bg.outside || bg.areas[i] >= MIN_HOLE) backgrounds++;
  let area = 0;
  for (const v of m) area += v;
  const areaRatio = area / (SIZE * SIZE);
  const lobes = countLobes(m);
  const reasons: string[] = [];
  if (pieces !== 1) reasons.push(pieces > 1 ? 'つながっていない' : '形がない');
  if (backgrounds > 1) reasons.push('穴がある');
  if (lobes !== 4) reasons.push(`葉の数が ${lobes}`);
  if (!(AREA_RANGE[0] <= areaRatio && areaRatio <= AREA_RANGE[1])) reasons.push(areaRatio < AREA_RANGE[0] ? '面積が小さすぎる' : '面積が大きすぎる');
  return { lobes, pieces, backgrounds, areaRatio, reasons };
}

// 「妥当な形」か: 白黒にして、後処理をしてから確かめる。mask = 後処理のあとの形（見せる形）
export function validShape(x: ArrayLike<number>): { ok: boolean; mask: Mask; reasons: string[] } {
  const mask = cleanup(binarize(x));
  const { reasons } = checkShape(mask);
  return { ok: reasons.length === 0, mask, reasons };
}
