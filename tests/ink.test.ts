// src/lib/ink.ts のテスト（手書きの線とシールのデータ・座標の変換・「もどす」）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InkHistory, UNDO_LIMIT, emptyInk, fromCard, hasInk, parseInk, pressureOf, toCard, type InkStroke, type InkSticker } from '../src/lib/ink.ts';

const rect = { left: 20, top: 100, width: 300, height: 375 };

test('画面の位置を、カードの中の位置（0〜1）にする', () => {
  assert.deepEqual(toCard(20, 100, rect), [0, 0]);
  assert.deepEqual(toCard(320, 475, rect), [1, 1]);
  assert.deepEqual(toCard(170, 287.5, rect), [0.5, 0.5]);
});

test('カードの外は、ふちに寄せる。小数は 4 けたに丸める', () => {
  assert.deepEqual(toCard(0, 600, rect), [0, 1]);
  assert.deepEqual(toCard(120, 200, rect), [0.3333, 0.2667]);
});

test('カードの中の位置を、どの大きさの画像の上にも戻せる（共有の 1080×1350 と、画面のプレビュー）', () => {
  const [x, y] = toCard(170, 287.5, rect);
  assert.deepEqual(fromCard(x, y, 1080, 1350), [540, 675]);
  assert.deepEqual(fromCard(x, y, 300, 375), [150, 187.5]);
});

test('筆圧: ペンのときだけ使う。ほかは 0.5', () => {
  assert.equal(pressureOf('pen', 0.8), 0.8);
  assert.equal(pressureOf('pen', 0), 0.5);
  assert.equal(pressureOf('touch', 1), 0.5);
  assert.equal(pressureOf('mouse', 0.5), 0.5);
});

const line: InkStroke = { kind: 'line', color: 'blue', size: 0.011, points: [[0.1, 0.2, 0.5], [0.3, 0.4, 0.7]] };
const sticker: InkSticker = { kind: 'sticker', type: 'heart', x: 0.5, y: 0.6, size: 0.14 };

test('保存と読み込み: JSON にして戻しても、同じ', () => {
  const ink = { v: 1 as const, items: [line, { ...line, erase: true, color: 'black' as const }, sticker] };
  assert.deepEqual(parseInk(JSON.parse(JSON.stringify(ink))), ink);
});

test('読み込み: 壊れたところは捨てる（知らない色・知らないシール・点のない線）', () => {
  const raw = { items: [
    { ...line, color: 'gold' },
    { ...sticker, type: 'rocket' },
    { kind: 'line', color: 'red', size: 0.01, points: [] },
    { kind: 'line', color: 'red', size: 0.01, points: [[0.1, 0.1, 0.5], ['x', 1, 1], [2, -1, 0.5]] },
    sticker,
  ] };
  assert.deepEqual(parseInk(raw).items, [
    { kind: 'line', color: 'red', size: 0.01, points: [[0.1, 0.1, 0.5], [1, 0, 0.5]] },
    sticker,
  ]);
  assert.deepEqual(parseInk(undefined), emptyInk());
  assert.deepEqual(parseInk({ items: 'x' }), emptyInk());
});

test('手書きがあるか: けしゴムだけなら、ないとみなす', () => {
  assert.equal(hasInk(emptyInk()), false);
  assert.equal(hasInk({ v: 1, items: [{ ...line, erase: true }] }), false);
  assert.equal(hasInk({ v: 1, items: [line] }), true);
  assert.equal(hasInk({ v: 1, items: [sticker] }), true);
});

test('もどす: 書いた順に 1 つずつ戻る。「ぜんぶけす」も戻せる', () => {
  const h = new InkHistory();
  assert.equal(h.canUndo, false);
  h.add(line);
  h.add(sticker);
  h.clear();
  assert.deepEqual(h.ink.items, []);
  assert.equal(h.undo(), true);
  assert.deepEqual(h.ink.items, [line, sticker]);
  h.undo();
  assert.deepEqual(h.ink.items, [line]);
  h.undo();
  assert.deepEqual(h.ink.items, []);
  assert.equal(h.undo(), false);
});

test('もどす: 50 回前まで', () => {
  const h = new InkHistory();
  for (let i = 0; i < UNDO_LIMIT + 10; i++) h.add({ ...sticker, x: i / 100 });
  let n = 0;
  while (h.undo()) n++;
  assert.equal(n, UNDO_LIMIT);
  assert.equal(h.ink.items.length, 10);
});

test('前に書いたものから続けられる（読み込んだ線は、もどすでは消えない）', () => {
  const h = new InkHistory([line]);
  h.add(sticker);
  h.undo();
  assert.deepEqual(h.ink.items, [line]);
  assert.equal(h.canUndo, false);
});

test('空の「ぜんぶけす」は、もどすに積まない', () => {
  const h = new InkHistory();
  h.clear();
  assert.equal(h.canUndo, false);
});
