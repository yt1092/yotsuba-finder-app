// src/lib/gacha.ts のテスト（「今日のよつば」の日付・絵のファイル名・画面の文）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayNumber, gachaImageUrl, gachaImageUrls, tokyoDayKey } from '../src/lib/gacha.ts';

test('日本時間の日付: 日本の 0 時で日付が変わる（UTC の 15 時）', () => {
  assert.equal(tokyoDayKey(new Date('2026-10-27T14:59:59Z')), '2026-10-27');
  assert.equal(tokyoDayKey(new Date('2026-10-27T15:00:00Z')), '2026-10-28');
});

test('日数: 1970-01-01 は 0、うるう年の 2 月 29 日も数える', () => {
  assert.equal(dayNumber('1970-01-01'), 0);
  assert.equal(dayNumber('2028-03-01') - dayNumber('2028-02-28'), 2);
});

test('絵のファイル名: 2 けた・60 個', () => {
  assert.equal(gachaImageUrl(7), '/gacha/yotsuba-07.webp');
  const urls = gachaImageUrls();
  assert.equal(urls.length, 60);
  assert.equal(urls[59], '/gacha/yotsuba-60.webp');
});

test('画面の文（作者の決定 2026-10-28）。「本物」「写真から学んだ」とは書かない', async () => {
  const { GACHA_DIT_NOTE, gachaSource, gachaAlt, GACHA_MODEL_NOTE } = await import('../src/lib/gacha.ts');
  assert.equal(GACHA_DIT_NOTE, 'この端末の中で、小さなモデル（DiT）が作った形です');
  assert.equal(gachaSource('dit'), '端末の中のモデルが作った形');
  assert.equal(gachaSource('preset'), 'あらかじめ作った形');
  assert.equal(GACHA_MODEL_NOTE, '数式で作った形で学習したモデルです');
  for (const s of [GACHA_DIT_NOTE, gachaSource('dit'), gachaSource('preset'), GACHA_MODEL_NOTE, gachaAlt('dit'), gachaAlt('preset')]) {
    assert.ok(!/本物|写真|%|\d/.test(s), s);
  }
});
