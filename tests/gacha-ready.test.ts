// src/lib/gacha-ready.ts のテスト（ホームの「今日のよつば」の準備ができた印を出すか）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoadResult, readyFrom } from '../src/lib/gacha-ready.ts';
import { GACHA_MODEL_URL } from '../src/lib/gacha-config.ts';

const good = { size: 16_896_754, expected: 16_896_754, firstByte: 0x08 };

test('準備前: モデルが端末に無ければ、印を出さない', () => {
  assert.equal(readyFrom(null, null), false);
});

test('準備後: モデルが端末にあり、終わりまで読めれば、印を出す（大きさが分からないときも）', () => {
  assert.equal(readyFrom(good, null), true);
  assert.equal(readyFrom({ ...good, expected: null }, null), true);
  assert.equal(readyFrom(good, { url: GACHA_MODEL_URL, ok: true, at: 1 }), true);
});

test('読み込みの失敗: こわれたファイル・途中まで・空・この端末で読み込めなかった → 印を出さない', () => {
  assert.equal(readyFrom({ ...good, firstByte: 0x3c }, null), false);           // モデルではない（HTML など）
  assert.equal(readyFrom({ ...good, size: 1000 }, null), false);                // 途中までしか入っていない
  assert.equal(readyFrom({ size: 0, expected: null, firstByte: null }, null), false);
  assert.equal(readyFrom(good, { url: GACHA_MODEL_URL, ok: false, at: 1 }), false);
  // 前のモデルで失敗した記録は、今のモデルには使わない
  assert.equal(readyFrom(good, { url: '/models/gacha-old.onnx', ok: false, at: 1 }), true);
});

test('判定に使うのは、モデルと読み込みの結果だけ（ネットの接続・今日もう作ったかは、引数に無い）', () => {
  assert.equal(readyFrom.length, 2); // ファイルと、読み込みの結果（3 つ目の URL は、ふつうは今のモデル）
});

test('読み込みの結果の記録: こわれていれば、無いものとみなす', () => {
  assert.deepEqual(parseLoadResult(JSON.stringify({ url: GACHA_MODEL_URL, ok: false, at: 5 })), { url: GACHA_MODEL_URL, ok: false, at: 5 });
  assert.equal(parseLoadResult(null), null);
  assert.equal(parseLoadResult('{'), null);
  assert.equal(parseLoadResult(JSON.stringify({ ok: 'yes' })), null);
});
