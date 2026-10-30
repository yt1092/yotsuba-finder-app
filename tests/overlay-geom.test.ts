// 枠を画面に重ねるときの位置（src/lib/overlay-geom.ts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverMap, labelPos } from '../src/lib/overlay-geom.ts';

test('cover: 縦長の映像（720×1080）を 390×844 に出すと、左右が切れて、まん中が合う', () => {
  const m = coverMap(720, 1080, 390, 844);
  assert.ok(Math.abs(m.s - 844 / 1080) < 1e-9);
  assert.ok(m.ox < 0 && Math.abs(m.oy) < 1e-9);
  assert.ok(Math.abs(360 * m.s + m.ox - 195) < 1e-9); // 映像のまん中 → 画面のまん中
});

test('ラベル: ふつうは枠の上。上に場所がなければ枠の中。使ってよい範囲に収まらなければ出さない', () => {
  const area = { left: 0, right: 390, top: 120, bottom: 700 };
  assert.deepEqual(labelPos({ x: 100, y: 300, w: 80, h: 80 }, 100, 28, area), { x: 100, y: 268 });
  assert.deepEqual(labelPos({ x: 100, y: 130, w: 80, h: 80 }, 100, 28, area), { x: 100, y: 134 });
  assert.equal(labelPos({ x: 100, y: 740, w: 80, h: 80 }, 100, 28, area), null); // 下のボタンの近く（枠がボタンの下）
  assert.deepEqual(labelPos({ x: 350, y: 300, w: 80, h: 80 }, 100, 28, area), { x: 290, y: 268 }); // 右端に寄せる
});


test('ラベルどうしの重なり: 重なる・すき間 2px 未満は重なりとみなす', async () => {
  const { overlaps } = await import('../src/lib/overlay-geom.ts');
  assert.equal(overlaps({ x: 0, y: 0, w: 50, h: 20 }, { x: 40, y: 10, w: 50, h: 20 }), true);
  assert.equal(overlaps({ x: 0, y: 0, w: 50, h: 20 }, { x: 51, y: 0, w: 50, h: 20 }), true);
  assert.equal(overlaps({ x: 0, y: 0, w: 50, h: 20 }, { x: 60, y: 0, w: 50, h: 20 }), false);
});
