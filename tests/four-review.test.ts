// src/lib/four-review.ts のテスト（確認のポップアップで、候補を順に決めていく動き）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceLevel, decide, move, showSkipAll, skipAll, startReview, summarize, SKIP_ALL_FROM } from '../src/lib/four-review.ts';

test('入れる・入れないを押すと、次の候補に進み、最後にまとめになる', () => {
  let s = startReview(3);
  s = decide(s, 'keep');
  assert.equal(s.index, 1);
  s = decide(s, 'skip');
  assert.equal(s.index, 2);
  assert.equal(s.done, false);
  s = decide(s, 'keep');
  assert.equal(s.done, true);
  assert.deepEqual(summarize(s), { kept: [0, 2], skipped: [1], complete: true });
});

test('まえへ・つぎへで移れる（はしでは止まる）。とばした候補には、あとでもどる', () => {
  let s = startReview(3);
  s = move(s, -1);
  assert.equal(s.index, 0);
  s = move(s, 2);
  assert.equal(s.index, 2);
  s = move(s, 1);
  assert.equal(s.index, 2);
  s = decide(s, 'keep');       // 3 番目を先に決めると、まだの 1 番目にもどる
  assert.equal(s.index, 0);
  s = decide(s, 'skip');
  assert.equal(s.index, 1);
  s = decide(s, 'skip');
  assert.equal(s.done, true);
  assert.deepEqual(summarize(s).kept, [2]);
});

test('決めた候補にもどって、答えを変えられる', () => {
  let s = startReview(2);
  s = decide(s, 'keep');
  s = move(s, -1);
  s = decide(s, 'skip');
  assert.deepEqual(s.choices, ['skip', null]);
  assert.equal(s.index, 1);
});

test('全部「入れない」のときは、何も入れない', () => {
  let s = startReview(2);
  s = decide(s, 'skip');
  s = decide(s, 'skip');
  assert.deepEqual(summarize(s), { kept: [], skipped: [0, 1], complete: true });
});

test('ぜんぶ入れない: 候補が 10 個以上で、まだ何も決めていないときだけ出す', () => {
  assert.equal(showSkipAll(startReview(SKIP_ALL_FROM - 1)), false);
  const s = startReview(13);
  assert.equal(showSkipAll(s), true);
  assert.equal(showSkipAll(decide(s, 'keep')), false);
  const all = skipAll(s);
  assert.equal(all.done, true);
  assert.equal(summarize(all).skipped.length, 13);
  assert.equal(summarize(all).complete, true);
});

test('ぜんぶ入れない: すでに「入れる」にしたものは、そのまま', () => {
  let s = startReview(12);
  s = decide(s, 'keep');
  assert.deepEqual(summarize(skipAll(s)).kept, [0]);
});

test('決めたあとは、もう変わらない', () => {
  const s = decide(startReview(1), 'keep');
  assert.equal(decide(s, 'skip'), s);
  assert.equal(move(s, 1), s);
});

test('候補が 0 個なら、はじめから終わり', () => {
  assert.equal(startReview(0).done, true);
});

test('たしかさのめやす: 3 段階', () => {
  const levels = { high: 0.9, mid: 0.8 };
  assert.equal(confidenceLevel(0.93, levels), 3);
  assert.equal(confidenceLevel(0.9, levels), 3);
  assert.equal(confidenceLevel(0.85, levels), 2);
  assert.equal(confidenceLevel(0.8, levels), 2);
  assert.equal(confidenceLevel(0.79, levels), 1);
  assert.equal(confidenceLevel(undefined, levels), 1);
});

test('× で閉じたとき: 決めたものだけ。complete は false', () => {
  let s = startReview(3);
  s = decide(s, 'keep');
  const r = summarize(s);
  assert.deepEqual(r, { kept: [0], skipped: [], complete: false });
});
