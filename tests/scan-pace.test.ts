// src/lib/scan-pace.ts のテスト（カメラの検出・WASM の、推論と推論のあいだの休み）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wasmGapMs } from '../src/lib/scan-pace.ts';

test('ふだんは、直前の推論の時間の半分', () => {
  assert.equal(wasmGapMs(391, 380), 200); // 391 ÷ 2 = 約 196 → 最小の 200ms
  assert.equal(wasmGapMs(600, 500), 300);
  assert.equal(wasmGapMs(1000, 900), 500);
});

test('最小は 200ms（速い端末でも、続けて計算しつづけない）', () => {
  assert.equal(wasmGapMs(120, 100), 200);
  assert.equal(wasmGapMs(0, 0), 200);
});

test('いちばん速かったときの 2 倍以上かかったら、同じだけ休む・3 倍以上なら 2 倍休む', () => {
  assert.equal(wasmGapMs(799, 400), 400); // 2 倍に届かない → 半分
  assert.equal(wasmGapMs(800, 400), 800); // 2 倍 → 同じだけ
  assert.equal(wasmGapMs(1200, 400), 2400); // 3 倍 → 2 倍
});

test('はじめの 1 回（いちばん速かった時間が、まだ無い）は、半分', () => {
  assert.equal(wasmGapMs(3000, 0), 1500);
});

test('長くても 5 秒まで', () => {
  assert.equal(wasmGapMs(4000, 1000), 5000);
  assert.equal(wasmGapMs(20000, 0), 5000);
});
