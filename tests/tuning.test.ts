// 使うほど合う、端末内の調整（src/lib/tuning.ts）: 単体テストと、人工的に作った選択の履歴でのシミュレーション
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tuneThreshold, MAX_SHIFT, type Choice } from '../src/lib/tuning.ts';

const BASE = 0.4;

// くり返しても同じになる乱数
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// 人工的な選択の履歴: スコアは base〜1 の一様。keepProb(スコア) の確率で「入れる」
function history(n: number, keepProb: (s: number) => number, seed = 1, low = BASE): Choice[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const score = low + (1 - low) * r();
    return { score, keep: r() < keepProb(score) };
  });
}

test('数が足りないあいだは動かさない（「入れる」5・「入れない」5・合計 20）', () => {
  const few = history(19, s => (s > 0.7 ? 1 : 0));
  assert.deepEqual(tuneThreshold(few, BASE), { threshold: BASE, shift: 0, ready: false });
  const onlyKeeps: Choice[] = Array.from({ length: 40 }, (_, i) => ({ score: 0.4 + i / 100, keep: true }));
  assert.equal(tuneThreshold(onlyKeeps, BASE).ready, false); // 「入れない」が 0 件
});

test('オフのときは、もとの値のまま', () => {
  const h = history(200, s => (s > 0.8 ? 1 : 0.1));
  assert.equal(tuneThreshold(h, BASE, false).threshold, BASE);
});

test('シミュレーション: 低いスコアも、ほとんど「入れる」人 → しきい値を少し下げる（候補が増える）', () => {
  const h = history(120, () => 0.9, 2);
  const t = tuneThreshold(h, BASE);
  assert.equal(t.ready, true);
  assert.ok(t.shift < 0, `shift ${t.shift}`);
  assert.ok(t.shift >= -MAX_SHIFT);
});

test('シミュレーション: 低いスコアを「入れない」人 → しきい値を上げるが、下げるときより小さく、+0.1 まで', () => {
  const h = history(120, s => (s > 0.75 ? 0.95 : 0.1), 3);
  const t = tuneThreshold(h, BASE);
  assert.ok(t.shift > 0, `shift ${t.shift}`);
  assert.ok(t.shift <= MAX_SHIFT);
  // 上げる向きは、推定した境目との差の半分（さらに件数で寄せる）: 境目との差より、ずっと小さい
  assert.ok(t.boundary !== undefined && t.shift < (t.boundary - BASE) * 0.5 + 1e-9, `${t.shift} / ${t.boundary}`);
});

test('シミュレーション: スコアと関係なく半々に選ぶ人 → ほとんど動かさない（もとの値に引き寄せる）', () => {
  const h = history(100, () => 0.5, 4);
  const t = tuneThreshold(h, BASE);
  assert.ok(Math.abs(t.shift) <= 0.05, `shift ${t.shift}`);
});

test('シミュレーション: 記録がとても多くても、動かせる幅は ±0.1 まで', () => {
  const up = tuneThreshold(history(3000, s => (s > 0.95 ? 1 : 0), 5), BASE);
  assert.equal(up.shift, MAX_SHIFT);
  assert.equal(up.threshold, 0.5);
  const down = tuneThreshold(history(3000, () => 0.97, 6), BASE);
  assert.ok(down.shift >= -MAX_SHIFT && down.threshold >= 0.3 - 1e-9);
});

test('シミュレーション: 件数が増えるほど、少しずつ動く（急に変わらない）', () => {
  const pref = (s: number) => (s > 0.75 ? 0.95 : 0.05);
  const shifts = [20, 40, 80, 160, 320].map(n => tuneThreshold(history(n, pref, 7), BASE).shift);
  for (let i = 1; i < shifts.length; i++) assert.ok(shifts[i] >= shifts[i - 1] - 0.01, shifts.join(', '));
  assert.ok(shifts[0] < shifts[shifts.length - 1]);
});
