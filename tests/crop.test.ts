// src/lib/crop.ts のテスト（図鑑に入れるときの切り抜き: 枠の位置・余白・画面の端・画像の範囲外）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CROP_MARGIN_RATIO, CROP_MIN_MARGIN, CROP_MIN_SIDE, clipBox, cropAround, detectionsInCrop } from '../src/lib/crop.ts';

const contains = (c: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  b.x >= c.x && b.y >= c.y && b.x + b.w <= c.x + c.w && b.y + b.h <= c.y + c.h;
const insideImage = (c: { x: number; y: number; w: number; h: number }, W: number, H: number) =>
  c.x >= 0 && c.y >= 0 && c.x + c.w <= W && c.y + c.h <= H && Number.isInteger(c.x + c.y + c.w + c.h);

test('決まり: 余白は枠の 25%・最小 16px・一辺の最小 256px', () => {
  assert.equal(CROP_MARGIN_RATIO, 0.25);
  assert.equal(CROP_MIN_MARGIN, 16);
  assert.equal(CROP_MIN_SIDE, 256);
});

test('枠の位置: 写真のまん中の枠は、枠のまん中を中心に、各辺に枠の 25% の余白をつけた正方形', () => {
  const box = { x: 500, y: 300, w: 400, h: 400 };
  const c = cropAround([box], 1280, 1280)!;
  assert.deepEqual(c, { x: 400, y: 200, w: 600, h: 600, srcW: 1280, srcH: 1280 }); // 400 + 100×2
  assert.ok(contains(c, box));
});

test('余白: 長方形の枠は、長いほうの辺に合わせた正方形。小さい枠は、最小の余白と最小の一辺', () => {
  const c = cropAround([{ x: 600, y: 300, w: 200, h: 100 }], 1280, 720)!;
  assert.equal(c.w, 300); // 200 + 50×2
  assert.equal(c.h, 300);
  assert.equal(c.x + c.w / 2, 700); // 枠のまん中
  // 小さい枠（40px）: 余白は 25% だと 10px なので、最小の 16px。一辺は 72px → 最小の 256px
  const s = cropAround([{ x: 600, y: 300, w: 40, h: 40 }], 1280, 720)!;
  assert.deepEqual([s.w, s.h], [256, 256]);
  const m = cropAround([{ x: 600, y: 300, w: 40, h: 40 }], 1280, 720, { minSide: 0 })!;
  assert.deepEqual([m.w, m.h], [72, 72]); // 40 + 16×2
});

test('画面の端: はみ出すときは、画像の中にずらす（枠は入ったまま）', () => {
  const W = 1280, H = 720;
  for (const box of [
    { x: 0, y: 0, w: 200, h: 200 },          // 左上の角
    { x: 1180, y: 620, w: 100, h: 100 },     // 右下の角
    { x: 1200, y: 10, w: 80, h: 300 },       // 右の端
  ]) {
    const c = cropAround([box], W, H)!;
    assert.ok(insideImage(c, W, H), JSON.stringify(c));
    assert.ok(contains(c, box), JSON.stringify({ c, box }));
  }
  const tl = cropAround([{ x: 0, y: 0, w: 200, h: 200 }], W, H)!;
  assert.deepEqual([tl.x, tl.y, tl.w, tl.h], [0, 0, 300, 300]);
});

test('画像より大きい切り抜き: その向きだけ画像の幅（高さ）までにする', () => {
  // 縦長の画像の、幅いっぱいの枠
  const c = cropAround([{ x: 50, y: 400, w: 600, h: 500 }], 720, 1280)!;
  assert.equal(c.w, 720);
  assert.equal(c.h, 900); // 600 + 150×2
  assert.ok(insideImage(c, 720, 1280));
  // 写真全体より大きい枠
  const all = cropAround([{ x: -100, y: -100, w: 2000, h: 2000 }], 1280, 720)!;
  assert.deepEqual([all.x, all.y, all.w, all.h], [0, 0, 1280, 720]);
});

test('画像の範囲外: はみ出した枠は画像の中に切ってから考える。外にしかない枠は使わない。使える枠が無ければ切り抜かない', () => {
  assert.deepEqual(clipBox({ x: -50, y: 100, w: 100, h: 50 }, 640, 480), { x: 0, y: 100, w: 50, h: 50 });
  assert.equal(clipBox({ x: 700, y: 100, w: 50, h: 50 }, 640, 480), null);
  assert.equal(cropAround([{ x: 700, y: 100, w: 50, h: 50 }], 640, 480), null);
  assert.equal(cropAround([], 640, 480), null);
  assert.equal(cropAround([{ x: 0, y: 0, w: 10, h: 10 }], 0, 0), null);
  const c = cropAround([{ x: 600, y: 400, w: 200, h: 200 }, { x: 900, y: 900, w: 10, h: 10 }], 640, 480)!;
  assert.ok(insideImage(c, 640, 480));
  assert.ok(contains(c, { x: 600, y: 400, w: 40, h: 80 })); // 画像の中に残った部分
});

test('四つ葉が 2 つ: 両方を囲む', () => {
  const a = { x: 100, y: 100, w: 100, h: 100 }, b = { x: 400, y: 200, w: 100, h: 100 };
  const c = cropAround([a, b], 1280, 960)!;
  assert.ok(contains(c, a) && contains(c, b));
  assert.equal(c.w, 600); // 囲む範囲 400×200 → 長いほう 400 ＋ 100×2
});

test('枠の座標を、切り抜いた画像の座標に直す（外の枠は外し、はみ出しは切る）', () => {
  const crop = { x: 100, y: 50, w: 300, h: 300, srcW: 1000, srcH: 1000 };
  const out = detectionsInCrop([
    { label: '四つ葉', score: 0.9, bbox: { x: 150, y: 100, w: 100, h: 100 } },
    { label: '三つ葉', score: 0.8, bbox: { x: 350, y: 300, w: 100, h: 100 } },
    { label: '三つ葉', score: 0.8, bbox: { x: 700, y: 700, w: 50, h: 50 } },
  ], crop);
  assert.deepEqual(out.map(d => [d.label, d.bbox]), [
    ['四つ葉', { x: 50, y: 50, w: 100, h: 100 }],
    ['三つ葉', { x: 250, y: 250, w: 50, h: 50 }],
  ]);
});
