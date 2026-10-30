// src/lib/gacha-shape.ts のテスト（「今日のよつば」の後処理と、妥当な形のチェック）
// Python（training/validity.py・training/gacha_shape.py）と同じ結果になるかを、Python が作った答えで確かめる
// （答え: tests/fixtures/gacha-shape-cases.json。作り直すときは python training/make_gacha_shape_fixture.py）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binarize, checkShape, cleanup, countLobes, MIN_PIECE, SIZE, validShape } from '../src/lib/gacha-shape.ts';

interface Case { name: string; input: string; cleaned: string; lobes: number; pieces: number; backgrounds: number; areaRatio: number; reasons: string[]; valid: boolean }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/gacha-shape-cases.json', import.meta.url), 'utf8')) as { size: number; minPiece: number; cases: Case[] };

// base64（行ごとに 8 画素を 1 バイト、上の位から）→ 0/1 の形
function unpack(b64: string): Uint8Array {
  const bytes = Buffer.from(b64, 'base64');
  const m = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) m[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return m;
}

test('答えの決まりが同じ（64×64・かけらの大きさ 20 画素）', () => {
  assert.equal(fixture.size, SIZE);
  assert.equal(fixture.minPiece, MIN_PIECE);
  assert.ok(fixture.cases.length > 300, `答えの数が少ない: ${fixture.cases.length}`);
});

test('Python と同じ: 後処理のあとの形（1 画素ずつ）', () => {
  const bad: string[] = [];
  for (const c of fixture.cases) {
    const got = cleanup(unpack(c.input));
    const want = unpack(c.cleaned);
    let diff = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) diff++;
    if (diff) bad.push(`${c.name}: ${diff} 画素ちがう`);
  }
  assert.deepEqual(bad, []);
});

test('Python と同じ: 葉の数・かたまりの数・背景のかたまりの数・面積・通らなかった理由', () => {
  const bad: string[] = [];
  for (const c of fixture.cases) {
    const m = unpack(c.cleaned);
    const r = checkShape(m);
    if (r.lobes !== c.lobes) bad.push(`${c.name}: 葉の数 ${r.lobes}（Python ${c.lobes}）`);
    if (r.pieces !== c.pieces) bad.push(`${c.name}: かたまり ${r.pieces}（Python ${c.pieces}）`);
    if (r.backgrounds !== c.backgrounds) bad.push(`${c.name}: 背景 ${r.backgrounds}（Python ${c.backgrounds}）`);
    if (Math.abs(r.areaRatio - c.areaRatio) > 1e-12) bad.push(`${c.name}: 面積 ${r.areaRatio}（Python ${c.areaRatio}）`);
    if (JSON.stringify(r.reasons) !== JSON.stringify(c.reasons)) bad.push(`${c.name}: 理由 ${r.reasons}（Python ${c.reasons}）`);
  }
  assert.deepEqual(bad, []);
});

test('Python と同じ: 妥当な形か（白黒 → 後処理 → チェック）', () => {
  let valid = 0;
  for (const c of fixture.cases) {
    const r = validShape(unpack(c.input));
    assert.equal(r.ok, c.valid, c.name);
    valid += r.ok ? 1 : 0;
  }
  assert.ok(valid > 50, `妥当な形が少なすぎる（${valid}）。答えが正しく読めていないかもしれない`);
});

test('白黒にする: 0.5 以上が 1', () => {
  const x = new Float32Array(SIZE * SIZE).fill(0.49);
  x[0] = 0.5;
  const m = binarize(x);
  assert.equal(m[0], 1);
  assert.equal(m.reduce((a, b) => a + b, 0), 1);
  assert.throws(() => binarize(new Float32Array(10)));
});

test('かけら・穴: 小さいものだけ消す。いちばん大きいかたまりは、小さくても残す', () => {
  const m = new Uint8Array(SIZE * SIZE);
  for (let y = 10; y < 13; y++) for (let x = 10; x < 13; x++) m[y * SIZE + x] = 1;
  assert.equal(cleanup(m).reduce((a, b) => a + b, 0), 9);
  assert.equal(countLobes(new Uint8Array(SIZE * SIZE)), 0);
});
