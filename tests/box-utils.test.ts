// src/lib/box-utils.ts のテスト（合成した枠で、まとめ方を確かめる）
// 実行方法: npm test （Node.js 組み込みのテスト機能を使うので、追加のパッケージはいらない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iou, overlapOfSmaller, mergeOverlapping } from '../src/lib/box-utils.ts';

// アプリと同じ基準（src/lib/detector-config.ts の NMS_IOU・NMS_SMALLER_OVERLAP と同じ値）
const OPTS = { iou: 0.5, smallerOverlap: 0.6, maxCount: 100 };

// 枠を作る小さな道具
const det = (x: number, y: number, w: number, h: number, label: '四つ葉' | '三つ葉', score: number) =>
  ({ bbox: { x, y, w, h }, label, score });

test('重なりの計算: 小さい枠が大きい枠にすっぽり入っていれば、IoU は小さくても「小さいほうに対する重なり」は 1', () => {
  const big = { x: 100, y: 100, w: 100, h: 100 };
  const part = { x: 100, y: 100, w: 40, h: 100 }; // 左側 40% だけの枠
  assert.equal(iou(big, part), 0.4);
  assert.equal(overlapOfSmaller(big, part), 1);
});

test('タイルの境目: 同じ四つ葉の「全体の枠」と「切れた一部の枠」は 1 つになる（スコアの高いほうが残る）', () => {
  const whole = det(100, 100, 100, 100, '四つ葉', 0.9);
  const cut = det(100, 100, 40, 100, '四つ葉', 0.7); // IoU は 0.4 で、IoU だけではまとまらない
  const result = mergeOverlapping([cut, whole], OPTS);
  assert.equal(result.length, 1);
  assert.equal(result[0], whole);
});

test('切れた一部のほうがスコアが高ければ、そちらが残る', () => {
  const whole = det(100, 100, 100, 100, '四つ葉', 0.6);
  const cut = det(150, 100, 50, 100, '四つ葉', 0.8);
  const result = mergeOverlapping([whole, cut], OPTS);
  assert.deepEqual(result, [cut]);
});

test('クラスが違っても、同じ物なら 1 つになる（切れて三つ葉に見えた四つ葉）', () => {
  const four = det(100, 100, 100, 100, '四つ葉', 0.85);
  const looksThree = det(130, 100, 70, 90, '三つ葉', 0.6);
  const result = mergeOverlapping([looksThree, four], OPTS);
  assert.equal(result.length, 1);
  assert.equal(result[0].label, '四つ葉');
});

test('離れた別の葉の枠は、両方残る', () => {
  const a = det(0, 0, 100, 100, '四つ葉', 0.9);
  const b = det(300, 300, 100, 100, '三つ葉', 0.8);
  assert.equal(mergeOverlapping([a, b], OPTS).length, 2);
});

test('隣り合って少しだけ重なる別の葉の枠は、両方残る', () => {
  const a = det(0, 0, 100, 100, '三つ葉', 0.9);
  const b = det(90, 0, 100, 100, '三つ葉', 0.8); // 重なりは幅 10 だけ（小さいほうに対して 10%）
  assert.ok(overlapOfSmaller(a.bbox, b.bbox) < 0.6);
  assert.equal(mergeOverlapping([a, b], OPTS).length, 2);
});

test('基準の値を変えられる: 「小さいほうに対する重なり」を使わない設定では、境目の 2 つの枠は両方残る', () => {
  const whole = det(100, 100, 100, 100, '四つ葉', 0.9);
  const cut = det(100, 100, 40, 100, '四つ葉', 0.7);
  assert.equal(mergeOverlapping([whole, cut], { ...OPTS, smallerOverlap: 1.01 }).length, 2);
});

test('IoU が基準を超える枠は、これまでどおり 1 つになる', () => {
  const a = det(0, 0, 100, 100, '四つ葉', 0.9);
  const b = det(5, 5, 100, 100, '四つ葉', 0.8);
  assert.ok(iou(a.bbox, b.bbox) > 0.5);
  assert.equal(mergeOverlapping([a, b], OPTS).length, 1);
});

test('返す枠の数は maxCount まで', () => {
  const many = Array.from({ length: 10 }, (_, i) => det(i * 200, 0, 100, 100, '三つ葉', 1 - i * 0.01));
  assert.equal(mergeOverlapping(many, { ...OPTS, maxCount: 3 }).length, 3);
});
