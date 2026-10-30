// src/lib/leaf-count.ts のテスト（葉の本数の文）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leafCountMessage } from '../src/lib/leaf-count.ts';

test('0本: 「葉っぱは、見つかりませんでした」', () => {
  assert.equal(leafCountMessage({ three: 0, four: 0 }), '葉っぱは、見つかりませんでした');
});

test('三つ葉だけ: 「三つ葉 3本を調べました。四つ葉は、見つかりませんでした」', () => {
  assert.equal(leafCountMessage({ three: 3, four: 0 }), '三つ葉 3本を調べました。四つ葉は、見つかりませんでした');
});

test('混ざっている: 「三つ葉 47本のなかに、四つ葉が 1本」（四つ葉が複数なら、本数をそのまま）', () => {
  assert.equal(leafCountMessage({ three: 47, four: 1 }), '三つ葉 47本のなかに、四つ葉が 1本');
  assert.equal(leafCountMessage({ three: 1, four: 2 }), '三つ葉 1本のなかに、四つ葉が 2本');
});

test('四つ葉だけ: 「四つ葉が 1本 ありました」', () => {
  assert.equal(leafCountMessage({ three: 0, four: 1 }), '四つ葉が 1本 ありました');
});
