// src/lib/pick-box.ts のテスト（密集した枠から、タップした場所に合う枠を選ぶ）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBox, distanceToRect, PICK_RADIUS, PICK_TIE } from '../src/lib/pick-box.ts';

const r = (x: number, y: number, w = 20, h = 20) => ({ x, y, w, h });

test('点から枠までの距離（枠の中なら 0）', () => {
  assert.equal(distanceToRect(10, 10, r(0, 0)), 0);
  assert.equal(distanceToRect(30, 10, r(0, 0)), 10);
  assert.equal(distanceToRect(23, 24, r(0, 0)), 5);
});

test('半径 24px 以内の、いちばん近い枠を選ぶ（枠の外を押しても選べる）', () => {
  assert.equal(PICK_RADIUS, 24);
  assert.deepEqual(pickBox(10, 10, [r(0, 0), r(100, 100)]), { kind: 'one', index: 0 });
  assert.deepEqual(pickBox(40, 10, [r(0, 0), r(100, 100)]), { kind: 'one', index: 0 });   // 枠の 20px 外
  assert.deepEqual(pickBox(60, 10, [r(0, 0), r(100, 100)]), { kind: 'none' });            // 40px 離れている
  assert.deepEqual(pickBox(36, 10, [r(0, 0), r(60, 0)]), { kind: 'one', index: 0 });      // 16px と 24px → 差が 8 以上
});

test('枠が重なっている・同じくらい近いときは、一覧から選んでもらう', () => {
  assert.equal(PICK_TIE, 8);
  // 2 つの枠の中にいる
  assert.deepEqual(pickBox(15, 15, [r(0, 0), r(10, 10), r(200, 200)]), { kind: 'choose', indices: [0, 1] });
  // 2 つの枠のあいだ（どちらにも 5px）
  assert.deepEqual(pickBox(25, 10, [r(0, 0), r(30, 0)]), { kind: 'choose', indices: [0, 1] });
});
