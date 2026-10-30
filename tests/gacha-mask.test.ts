// src/lib/gacha-mask.ts のテスト（「今日のよつば」の今日の形を、端末に残す・戻す）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromStored, maskFromAlpha, packMask, toStored, unpackMask } from '../src/lib/gacha-mask.ts';
import { SIZE } from '../src/lib/gacha-shape.ts';
import { mulberry32 } from '../src/lib/gacha-gen.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/gacha-shape-cases.json', import.meta.url), 'utf8')) as { cases: { cleaned: string }[] };
const fromFixture = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64');
  const m = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) m[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return m;
};

test('形を残して戻すと、1 画素もちがわない（Python の答えの形 全部と、でたらめな形）', () => {
  const rand = mulberry32(1);
  const masks = [
    ...fixture.cases.map(c => fromFixture(c.cleaned)),
    ...Array.from({ length: 20 }, () => Uint8Array.from({ length: SIZE * SIZE }, () => (rand() < 0.5 ? 1 : 0))),
    new Uint8Array(SIZE * SIZE),
    new Uint8Array(SIZE * SIZE).fill(1),
  ];
  for (const m of masks) {
    const s = packMask(m);
    assert.equal(s.length, Math.ceil((SIZE * SIZE) / 8 / 3) * 4); // 512 バイトの base64
    assert.deepEqual(unpackMask(s), m);
  }
});

test('今日の記録: 同じ日なら、同じ DiT の形が戻る', () => {
  const m = fromFixture(fixture.cases[0].cleaned);
  assert.deepEqual(fromStored(toStored('2026-10-28', m), '2026-10-28'), m);
  assert.equal(toStored('2026-10-28', m).kind, 'dit');
});

test('今日の記録: ちがう日・こわれた記録・無い記録・前の版が残した 60 枚の形は、使わない（もう一度ひく）', () => {
  const m = fromFixture(fixture.cases[0].cleaned);
  const rec = toStored('2026-10-28', m);
  assert.equal(fromStored(toStored('2026-10-27', m), '2026-10-28'), null);
  assert.equal(fromStored(undefined, '2026-10-28'), null);
  assert.equal(fromStored(null, '2026-10-28'), null);
  assert.equal(fromStored({ ...rec, mask: 'AAAA' }, '2026-10-28'), null);
  assert.equal(fromStored({ ...rec, kind: 'preset', number: 17 }, '2026-10-28'), null);
  assert.equal(fromStored({ ...rec, id: 'me' }, '2026-10-28'), null);
});

test('あらかじめ作った絵（RGBA）から形: 不透明さが半分以上の所が葉', () => {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  rgba[3] = 255;           // 0 番: 葉
  rgba[4 + 3] = 128;       // 1 番: ちょうど半分 → 葉
  rgba[8 + 3] = 127;       // 2 番: 半分より少し下 → 葉でない
  const m = maskFromAlpha(rgba);
  assert.deepEqual([...m.slice(0, 3)], [1, 1, 0]);
  assert.equal(m.reduce((a, v) => a + v, 0), 2);
});
