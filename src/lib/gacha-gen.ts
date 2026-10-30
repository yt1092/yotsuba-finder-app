// 「今日のよつば」: DiT で今日の形を作る手順（モデルは呼ぶ側が渡す。テスト: tests/gacha-gen.test.ts）
// 動かすのは、今日のよつばの画面のワーカー（src/lib/gacha.worker.ts）。モデルは 仕上げ前・FP32・4 歩・CFG なし・WASM（作者の決定 2026-10-28）
//
// 決まり（作者の決定 2026-10-27・2026-10-28）
//   - 種: 端末ごとの値・日本時間の日付・作り直しの番号をまぜた 32 ビットの値（src/lib/gacha-seed.ts の mixSeed）。同じ端末の同じ日は同じ形
//   - ノイズ: 種から、決まった乱数（mulberry32）と Box-Muller で 64×64 の正規乱数を作る（PyTorch の乱数とは別のもの）
//   - 作り方: rectified flow を Euler 法で STEPS 歩（x ← x + v / STEPS。t = 0, 1/STEPS, …）。モデルは 1 歩ぶん（ONNX）
//   - 妥当でなければ、作り直しの番号を 1, 2, … と進めて作り直す（決まった順）。作り直しは RETRY_LIMIT 回まで（最初の 1 回 ＋ 8 回）
//   - それでもだめなら、あらかじめ作った 60 枚（public/gacha/）から、1 回目の種で決まる 1 枚を出す
import { validShape, type Mask } from './gacha-shape.ts'; // node のテストでそのまま読めるように、.ts を付ける
import { presetNumber } from './gacha-seed.ts';

export const STEPS = 4;
export const RETRY_LIMIT = 8;
export const PIXELS = 64 * 64;

// 1 歩ぶんのモデル: 今の x（-1〜1 付近。長さ 4096）と時刻 t（0〜1）から、向き v を返す
export type StepFn = (x: Float32Array, t: number) => Promise<Float32Array>;

// 決まった乱数（mulberry32）。0 以上 1 未満
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// シードから、64×64 の正規乱数（平均 0・標準偏差 1）
export function noise(seed: number, n = PIXELS): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = 1 - rand(); // 0 を避ける（log(0) にしない）
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

// -1〜1 の値を、0〜1 にする（はみ出た所は切る）
export function toUnit(x: Float32Array): Float32Array {
  return x.map(v => (Math.min(1, Math.max(-1, v)) + 1) / 2);
}

// Euler 法で、ノイズから形を作る。戻り値は 0〜1（0.5 で白黒にする）
// onStep: 1 歩ごとの途中の形（0〜1。「つくっている間」の画面で、順に見せる）
export async function eulerSample(step: StepFn, x0: Float32Array, steps = STEPS, onStep?: (x: Float32Array) => void): Promise<Float32Array> {
  const x = Float32Array.from(x0);
  for (let i = 0; i < steps; i++) {
    const v = await step(x, i / steps);
    for (let j = 0; j < x.length; j++) x[j] += v[j] / steps;
    onStep?.(toUnit(x));
  }
  return toUnit(x);
}

export type DailyShape =
  | { kind: 'dit'; mask: Mask; seed: number; tries: number }
  | { kind: 'fallback'; number: number; tries: number; reasons: string[][] };

// 今日の形: 妥当な形が出るまで、作り直しの番号 0, 1, … RETRY_LIMIT の順に、seedOf(番号) の種で作る。全部だめなら、60 枚から 1 枚
export async function dailyShape(seedOf: (retry: number) => number, generate: (seed: number) => Promise<Float32Array>): Promise<DailyShape> {
  const reasons: string[][] = [];
  for (let k = 0; k <= RETRY_LIMIT; k++) {
    const seed = seedOf(k);
    const r = validShape(await generate(seed));
    if (r.ok) return { kind: 'dit', mask: r.mask, seed, tries: k + 1 };
    reasons.push(r.reasons);
  }
  return { kind: 'fallback', number: presetNumber(seedOf(0)), tries: RETRY_LIMIT + 1, reasons };
}
