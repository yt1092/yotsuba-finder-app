// 結果の画面の見出しと文（src/lib/result-text.ts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultText } from '../src/lib/result-text.ts';

test('検出なし: 「四つ葉は 見つかりませんでした」／三つ葉の本数', () => {
  assert.deepEqual(resultText({ fourDetected: 0, kept: 0, three: 47 }),
    { mascot: 'smile', title: '四つ葉は 見つかりませんでした', sub: '三つ葉が 47本 ありました', detail: '' });
  assert.equal(resultText({ fourDetected: 0, kept: 0, three: 0 }).sub, '');
});

test('すべて「入れない」: 「四つ葉は ありませんでした」', () => {
  assert.deepEqual(resultText({ fourDetected: 12, kept: 0, three: 34 }),
    { mascot: 'smile', title: '四つ葉は ありませんでした', sub: '三つ葉が 34本 ありました', detail: '' });
});

test('一部・すべて入れた（自動で入れるも）: 「四つ葉を ◯本 図鑑に入れました」', () => {
  assert.equal(resultText({ fourDetected: 12, kept: 2, three: 34 }).title, '四つ葉を 2本 図鑑に入れました');
  assert.equal(resultText({ fourDetected: 1, kept: 1, three: 0 }).title, '四つ葉を 1本 図鑑に入れました');
  assert.equal(resultText({ fourDetected: 1, kept: 1, three: 0 }).sub, '');
});

test('× で閉じた: 入れたものがあれば、その数。なければ「図鑑に入れませんでした」', () => {
  assert.equal(resultText({ fourDetected: 5, kept: 1, three: 3, closedEarly: true }).title, '四つ葉を 1本 図鑑に入れました');
  assert.equal(resultText({ fourDetected: 5, kept: 0, three: 3, closedEarly: true }).title, '四つ葉は 図鑑に入れませんでした');
});

test('まだ決めていない（ポップアップの後ろ）', () => {
  assert.equal(resultText({ fourDetected: 3, kept: 0, three: 3, pending: true }).title, '四つ葉の候補を たしかめています');
});

test('同じ写真の 2 回目: 見出しは「調べたことがあります」、いつもの文は下に', () => {
  assert.deepEqual(resultText({ fourDetected: 3, kept: 2, three: 5, repeated: true }),
    { mascot: 'happy', title: 'この写真は、調べたことがあります', sub: '経験値は、増えません', detail: '四つ葉を 2本 図鑑に入れました。三つ葉が 5本 ありました' });
  assert.equal(resultText({ fourDetected: 0, kept: 0, three: 0, repeated: true }).detail, '四つ葉は 見つかりませんでした');
});

test('失敗した感じの言葉は使わない', () => {
  const all = [0, 1, 3].flatMap(f => [0, 1].flatMap(k => [false, true].map(rep =>
    resultText({ fourDetected: f, kept: Math.min(k, f), three: 2, repeated: rep, closedEarly: f > 0 && k === 0 }))));
  for (const t of all) assert.doesNotMatch(t.title + t.sub + t.detail, /ざんねん|残念|失敗|ダメ|だめ/);
});

test('キャラクター: 入れた = happy・四つ葉がなかった = smile・まだ決めていない／× で閉じた = 出さない', () => {
  assert.equal(resultText({ fourDetected: 2, kept: 1, three: 0 }).mascot, 'happy');
  assert.equal(resultText({ fourDetected: 0, kept: 0, three: 3 }).mascot, 'smile');
  assert.equal(resultText({ fourDetected: 2, kept: 0, three: 3 }).mascot, 'smile');
  assert.equal(resultText({ fourDetected: 2, kept: 0, three: 3, pending: true }).mascot, null);
  assert.equal(resultText({ fourDetected: 2, kept: 0, three: 3, closedEarly: true }).mascot, null);
});
