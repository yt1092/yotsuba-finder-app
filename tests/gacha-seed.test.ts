// src/lib/gacha-seed.ts のテスト（「今日のよつば」の種: 端末ごとの値・日付・作り直しの番号）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_WORDS, isDeviceValue, mixSeed, newDeviceValue, presetNumber } from '../src/lib/gacha-seed.ts';
import { noise } from '../src/lib/gacha-gen.ts';
import { dayNumber } from '../src/lib/gacha.ts';

const DAY = dayNumber('2026-10-28');

test('端末の値: 32 ビット × 4。作るたびにちがう', () => {
  const a = newDeviceValue(), b = newDeviceValue();
  assert.equal(a.length, DEVICE_WORDS);
  assert.ok(isDeviceValue(a) && isDeviceValue(b));
  assert.notDeepEqual(a, b);
  assert.ok(!isDeviceValue([1, 2, 3]));
  assert.ok(!isDeviceValue([1, 2, 3, -1]));
  assert.ok(!isDeviceValue('1234'));
});

test('種: 32 ビットの整数。同じ端末・同じ日・同じ番号なら、いつも同じ', () => {
  const dev = [11, 22, 33, 44];
  const s = mixSeed(dev, DAY, 0);
  assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
  for (let i = 0; i < 5; i++) assert.equal(mixSeed([...dev], DAY, 0), s);
});

test('種: 端末の値がちがえば、同じ日でも、すべてちがう（1,000 個の端末）。はじめのノイズも、すべてちがう', () => {
  const devs = Array.from({ length: 1000 }, () => newDeviceValue());
  const seeds = devs.map(d => mixSeed(d, DAY, 0));
  assert.equal(new Set(seeds).size, devs.length);
  const firsts = new Set(seeds.slice(0, 50).map(s => noise(s).slice(0, 8).join(',')));
  assert.equal(firsts.size, 50);
});

test('種: 端末の値が 1 ビットだけちがっても、ちがう種', () => {
  const base = [0, 0, 0, 0];
  const seen = new Set([mixSeed(base, DAY, 0)]);
  for (let w = 0; w < 4; w++) for (let bit = 0; bit < 32; bit++) {
    const d = [...base];
    d[w] = (1 << bit) >>> 0;
    seen.add(mixSeed(d, DAY, 0));
  }
  assert.equal(seen.size, 1 + 4 * 32);
});

test('種: 日付がちがう・作り直しの番号がちがうと、ちがう種（1 年ぶん × 9 回）', () => {
  const dev = newDeviceValue();
  const seen = new Set<number>();
  for (let d = 0; d < 365; d++) for (let k = 0; k <= 8; k++) seen.add(mixSeed(dev, DAY + d, k));
  assert.equal(seen.size, 365 * 9);
});

test('60 枚の番号: 種から 1〜60。いろいろな種で、60 枚すべてが出る', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) {
    const n = presetNumber(mixSeed([i, 0, 0, 0], DAY, 0));
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 60);
    seen.add(n);
  }
  assert.equal(seen.size, 60);
  assert.equal(presetNumber(0), 1);
  assert.equal(presetNumber(0xffffffff), (0xffffffff % 60) + 1);
});
