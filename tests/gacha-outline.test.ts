// src/lib/gacha-outline.ts のテスト（「今日のよつば」の絵の線: 輪郭・葉脈・葉ごとの扇形）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chaikin, contours, loopArea, outline } from '../src/lib/gacha-outline.ts';
import { countLobes, lobeDetails, SIZE } from '../src/lib/gacha-shape.ts';

interface Case { name: string; cleaned: string; lobes: number; valid: boolean }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/gacha-shape-cases.json', import.meta.url), 'utf8')) as { cases: Case[] };
const fromFixture = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64');
  const m = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) m[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return m;
};
const disk = (cx: number, cy: number, r: number, hole = 0) => {
  const m = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - cx, y - cy);
    m[y * SIZE + x] = d <= r && d >= hole ? 1 : 0;
  }
  return m;
};
const count = (m: Uint8Array) => m.reduce((a, v) => a + v, 0);

test('輪郭: 円は 1 つの閉じた輪で、面積は画素の数とほぼ同じ', () => {
  const m = disk(31.5, 31.5, 20);
  const loops = contours(m);
  assert.equal(loops.length, 1);
  const area = Math.abs(loopArea(chaikin(loops[0])));
  assert.ok(Math.abs(area - count(m)) / count(m) < 0.05, `面積 ${area} と画素 ${count(m)}`);
});

test('輪郭: 穴のある形は、外の輪と穴の輪の 2 つ（塗るときは evenodd なので、輪の向きは問わない）', () => {
  const m = disk(31.5, 31.5, 22, 8);
  const loops = contours(m);
  assert.equal(loops.length, 2);
  const [big, small] = loops.map(l => Math.abs(loopArea(chaikin(l)))).sort((x, y) => y - x);
  assert.ok(Math.abs(big - small - count(m)) / count(m) < 0.05, `外 ${big} − 穴 ${small} と画素 ${count(m)}`);
});

test('輪郭: 何も無い形は、輪が無い。端までの形も、輪は閉じる', () => {
  assert.equal(contours(new Uint8Array(SIZE * SIZE)).length, 0);
  const full = contours(new Uint8Array(SIZE * SIZE).fill(1));
  assert.equal(full.length, 1);
  for (const [x, y] of full[0]) assert.ok(x >= -1 && y >= -1 && x <= SIZE && y <= SIZE);
});

test('葉の向きを足しても、葉の数は前と同じ（Python の答えと同じ）', () => {
  for (const c of fixture.cases) {
    const m = fromFixture(c.cleaned);
    assert.equal(lobeDetails(m).count, c.lobes, c.name);
    assert.equal(countLobes(m), c.lobes, c.name);
  }
});

test('妥当な形: 輪郭があり、葉脈と、4 枚の葉の扇形ができる。葉の先は、その葉の扇形の中', () => {
  const valid = fixture.cases.filter(c => c.valid);
  assert.ok(valid.length > 100, `妥当な形が少ない: ${valid.length}`);
  for (const c of valid) {
    const m = fromFixture(c.cleaned);
    const o = outline(m);
    assert.match(o.d, /^M[\d.\- ]+L/, c.name);
    assert.ok(o.veins.length > 0, c.name);
    assert.equal(o.wedges.length, 4, c.name);
    const lb = lobeDetails(m);
    lb.tips.forEach((tip, k) => {
      const a0 = lb.valleys[(k + 3) % 4];
      let a1 = lb.valleys[k], a = tip.angle;
      if (a1 <= a0) a1 += Math.PI * 2;
      if (a < a0) a += Math.PI * 2;
      assert.ok(a >= a0 && a <= a1, `${c.name}: 葉 ${k} の先が、扇形の外`);
    });
  }
});

test('葉が 4 枚と数えられない形: 輪郭だけ（葉脈・扇形なし）', () => {
  const o = outline(disk(31.5, 31.5, 20));
  assert.ok(o.d.length > 0);
  assert.equal(o.veins, '');
  assert.deepEqual(o.wedges, []);
});
