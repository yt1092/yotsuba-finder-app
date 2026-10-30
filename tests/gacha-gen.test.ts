// src/lib/gacha-gen.ts のテスト（「今日のよつば」を DiT で作る手順。モデルは、にせもので代える）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyShape, eulerSample, mulberry32, noise, RETRY_LIMIT, STEPS } from '../src/lib/gacha-gen.ts';
import { dayNumber, tokyoDayKey } from '../src/lib/gacha.ts';
import { mixSeed, presetNumber } from '../src/lib/gacha-seed.ts';
import { SIZE } from '../src/lib/gacha-shape.ts';

// 4 枚の葉の形（妥当な形）と、空の形（妥当でない）を、0〜1 の出力として
function fourLeaves(): Float32Array {
  const x = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let k = 0; k < SIZE; k++) {
      const dx = k - 31.5, dy = y - 31.5;
      const a = Math.atan2(dy, dx), r = Math.hypot(dx, dy);
      x[y * SIZE + k] = r <= 26 * (0.2 + 0.8 * Math.abs(Math.cos(2 * a))) ? 0.9 : 0.1;
    }
  }
  return x;
}
const empty = () => new Float32Array(SIZE * SIZE);
const NOW = new Date('2026-10-27T03:00:00Z');

test('乱数: 同じシードなら同じ列・ちがうシードならちがう列', () => {
  const a = mulberry32(5), b = mulberry32(5), c = mulberry32(6);
  const xa = [a(), a(), a()], xb = [b(), b(), b()], xc = [c(), c(), c()];
  assert.deepEqual(xa, xb);
  assert.notDeepEqual(xa, xc);
  assert.ok(xa.every(v => v >= 0 && v < 1));
});

test('ノイズ: 長さ 4096・だいたい平均 0・標準偏差 1・同じシードで同じ', () => {
  const n = noise(123);
  assert.equal(n.length, 4096);
  const mean = n.reduce((s, v) => s + v, 0) / n.length;
  const sd = Math.sqrt(n.reduce((s, v) => s + (v - mean) ** 2, 0) / n.length);
  assert.ok(Math.abs(mean) < 0.05, `平均 ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.05, `標準偏差 ${sd}`);
  assert.deepEqual(noise(123), n);
  assert.ok(n.every(Number.isFinite));
});

test('Euler: x ← x + v / 歩数 を、t = 0, 1/4, 2/4, 3/4 で 4 回。最後に 0〜1 にする', async () => {
  const ts: number[] = [];
  const x0 = new Float32Array(4).fill(-1);
  const out = await eulerSample(async (x, t) => { ts.push(t); return new Float32Array(x.length).fill(1); }, x0, 4);
  assert.deepEqual(ts, [0, 0.25, 0.5, 0.75]);
  assert.deepEqual([...out], [0.5, 0.5, 0.5, 0.5]); // -1 + 4 × (1/4) = 0 → 0.5
  assert.deepEqual([...x0], [-1, -1, -1, -1]); // 渡したノイズは変えない
  assert.equal(STEPS, 4);
});

// 種: 作り直しの番号 k から、決まった種（ここでは、端末の値と日付を決めた mixSeed）
const DEV = [1, 2, 3, 4];
const DAY = dayNumber(tokyoDayKey(NOW));
const seedOf = (k: number) => mixSeed(DEV, DAY, k);

test('今日の形: 1 回目で妥当なら、そのまま（種 = 作り直しの番号 0 の種）', async () => {
  const seeds: number[] = [];
  const r = await dailyShape(seedOf, async s => { seeds.push(s); return fourLeaves(); });
  assert.equal(r.kind, 'dit');
  assert.deepEqual(seeds, [seedOf(0)]);
  if (r.kind === 'dit') { assert.equal(r.tries, 1); assert.equal(r.seed, seedOf(0)); }
});

test('今日の形: 妥当でなければ、作り直しの番号を 1, 2, … と進めて、決まった順で作り直す', async () => {
  const seeds: number[] = [];
  const r = await dailyShape(seedOf, async s => { seeds.push(s); return seeds.length < 3 ? empty() : fourLeaves(); });
  assert.deepEqual(seeds, [seedOf(0), seedOf(1), seedOf(2)]);
  assert.equal(r.kind, 'dit');
  if (r.kind === 'dit') assert.equal(r.tries, 3);
});

test('今日の形: 作り直しは 8 回まで（全部で 9 回）。だめなら、60 枚から、1 回目の種で決まる 1 枚', async () => {
  const seeds: number[] = [];
  const r = await dailyShape(seedOf, async s => { seeds.push(s); return empty(); });
  assert.equal(RETRY_LIMIT, 8);
  assert.deepEqual(seeds, Array.from({ length: 9 }, (_, k) => seedOf(k)));
  assert.equal(new Set(seeds).size, 9, '作り直しの種が重なった');
  assert.equal(r.kind, 'fallback');
  if (r.kind === 'fallback') { assert.equal(r.number, presetNumber(seedOf(0))); assert.equal(r.reasons.length, 9); }
});

test('途中の形: 1 歩ごとに 1 つ（全部で 4 つ・0〜1）。最後の 1 つは、できた形と同じ', async () => {
  const steps: Float32Array[] = [];
  const out = await eulerSample(async x => new Float32Array(x.length).fill(1), noise(3), STEPS, x => steps.push(x));
  assert.equal(steps.length, STEPS);
  for (const s of steps) assert.ok(s.every(v => v >= 0 && v <= 1));
  assert.deepEqual(steps[STEPS - 1], out);
  assert.notDeepEqual(steps[0], out); // 途中は、まだノイズが残る
});
