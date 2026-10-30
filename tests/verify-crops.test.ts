// src/lib/verify-crops.ts のテスト（確認ステップの切り抜きと、判定のまとめ方）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCrops, boxInCrop, fourLeafAt, verifyVerdict, decidedVerdict, VERIFY_FRACTIONS } from '../src/lib/verify-crops.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≒ ${b}`);

test('切り抜きは 3 通りで、枠の長い辺が、切り抜きの幅のおよそ 20%・35%・50% になる', () => {
  const box = { x: 100, y: 200, w: 60, h: 40 };
  const crops = verifyCrops(box);
  assert.deepEqual([...VERIFY_FRACTIONS], [0.2, 0.35, 0.5]);
  assert.equal(crops.length, 3);
  crops.forEach((c, i) => close(60 / c.size, VERIFY_FRACTIONS[i]));
  // どれも、枠の中心が切り抜きの中心（まわりの景色を含めて切る）
  for (const c of crops) {
    close(c.x + c.size / 2, 130);
    close(c.y + c.size / 2, 220);
  }
});

test('画像の端の葉: 切り抜きは画像の外にはみ出してよい（大きさの割合を保つため）', () => {
  const [c] = verifyCrops({ x: 0, y: 0, w: 50, h: 50 });
  assert.ok(c.x < 0 && c.y < 0);
  close(50 / c.size, 0.2);
});

test('元画像の枠を、切り抜きの中の座標に直す（拡大して描いた分も）', () => {
  const crop = { x: 50, y: 100, size: 300 };
  assert.deepEqual(boxInCrop({ x: 140, y: 220, w: 60, h: 30 }, crop, 2), { x: 180, y: 240, w: 120, h: 60 });
});

test('その場所の四つ葉: 同じ場所の四つ葉だけを数える（離れた四つ葉や、同じ場所の三つ葉は数えない）', () => {
  const target = { x: 100, y: 100, w: 100, h: 100 };
  const four = (x: number, y: number, w = 100) => ({ bbox: { x, y, w, h: w }, label: '四つ葉' as const });
  assert.equal(fourLeafAt([four(110, 105)], target), true);
  assert.equal(fourLeafAt([four(400, 400)], target), false);
  assert.equal(fourLeafAt([{ bbox: target, label: '三つ葉' }], target), false);
  assert.equal(fourLeafAt([four(120, 120, 50)], target), true); // 枠の中の、小さめの四つ葉の枠
});

test('判定: 3 回中 2 回以上四つ葉なら「四つ葉のようです」、それより少なければ「よく見て、確かめてください」', () => {
  assert.equal(verifyVerdict([true, true, true]), 'four');
  assert.equal(verifyVerdict([true, false, true]), 'four');
  assert.equal(verifyVerdict([false, true, false]), 'unsure');
  assert.equal(verifyVerdict([false, false, false]), 'unsure');
  assert.equal(verifyVerdict([]), 'unsure');
});

test('厳しい決まり（3 回とも）: 1 回でも外れたら、そこで「よく見て、確かめてください」', async () => {
  const { VERIFY_NEEDED_STRICT } = await import('../src/lib/verify-crops.ts');
  assert.equal(VERIFY_NEEDED_STRICT, 3);
  assert.equal(verifyVerdict([true, true, false], 3), 'unsure');
  assert.equal(verifyVerdict([true, true, true], 3), 'four');
  assert.equal(decidedVerdict([false], 3, 3), 'unsure');     // 1 回目で外れたら決まる
  assert.equal(decidedVerdict([true, true], 3, 3), null);    // 3 回目が要る
  for (let m = 0; m < 8; m++) {
    const hits = [0, 1, 2].map(i => Boolean(m & (1 << i)));
    let early = null;
    for (let n = 1; n <= 3 && early === null; n++) early = decidedVerdict(hits.slice(0, n), 3, 3);
    assert.equal(early, verifyVerdict(hits, 3));
  }
});

test('途中で答えが決まれば、残りの判定はしない（答えは 3 回やったときと同じ）', () => {
  assert.equal(decidedVerdict([true]), null);
  assert.equal(decidedVerdict([true, true]), 'four');      // 2 回で決まる
  assert.equal(decidedVerdict([false, false]), 'unsure');  // 2 回で決まる
  assert.equal(decidedVerdict([true, false]), null);       // 3 回目が要る
  // 3 回の結果の、どの並びでも、途中で決めた答えが、3 回やった答えと同じ
  for (let m = 0; m < 8; m++) {
    const hits = [0, 1, 2].map(i => Boolean(m & (1 << i)));
    let early = null;
    for (let n = 1; n <= 3 && early === null; n++) early = decidedVerdict(hits.slice(0, n));
    assert.equal(early, verifyVerdict(hits));
  }
});
