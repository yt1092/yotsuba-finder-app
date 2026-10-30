// src/lib/hero-slides.ts のテスト（保存済みの記録から、ホームのスライドの一覧を作る）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeroSlides, HERO_MAX_PHOTOS } from '../src/lib/hero-slides.ts';
import type { CloverRecord } from '../src/lib/db.ts';

// 記録を作る小さな道具（date は日にち。大きいほど新しい）
const rec = (id: number, day: number, label: CloverRecord['label'] = '四つ葉'): CloverRecord =>
  ({ id, date: day * 86_400_000, imageDataUrl: `data:image/jpeg;base64,${id}`, label, source: 'camera', memo: '' });

const photoIds = (slides: ReturnType<typeof buildHeroSlides>) =>
  slides.flatMap(s => (s.kind === 'photo' ? [s.id] : []));

test('写真が 0 枚: イラストだけ', () => {
  assert.deepEqual(buildHeroSlides([]), [{ kind: 'illustration' }]);
});

test('写真が 1 枚: イラスト → その写真', () => {
  const slides = buildHeroSlides([rec(7, 3)]);
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[0], { kind: 'illustration' });
  assert.deepEqual(slides[1], { kind: 'photo', id: 7, imageDataUrl: 'data:image/jpeg;base64,7', date: 3 * 86_400_000 });
});

test('写真が 9 枚以上: 新しいほうから 8 枚だけ（イラストと合わせて 9 枚）', () => {
  const records = Array.from({ length: 12 }, (_, i) => rec(i + 1, i + 1)); // id = 日にち
  const slides = buildHeroSlides(records);
  assert.equal(HERO_MAX_PHOTOS, 8);
  assert.equal(slides.length, 1 + 8);
  assert.deepEqual(photoIds(slides), [12, 11, 10, 9, 8, 7, 6, 5]);
});

test('新しい順に並ぶ（渡された順番によらない）', () => {
  const slides = buildHeroSlides([rec(1, 5), rec(2, 9), rec(3, 1), rec(4, 7)]);
  assert.deepEqual(photoIds(slides), [2, 4, 1, 3]);
});

test('三つ葉の記録は入れない（見つけた四つ葉の写真だけ）', () => {
  const slides = buildHeroSlides([rec(1, 1), rec(2, 2, '三つ葉'), rec(3, 3)]);
  assert.deepEqual(photoIds(slides), [3, 1]);
});

test('写真なしで読み込んだ記録（写真の代わりの絵）は、スライドに出さない', () => {
  const slides = buildHeroSlides([
    { id: 1, date: 1, imageDataUrl: 'data:image/png;base64,AA', label: '四つ葉', source: 'photo', photoMissing: true },
    { id: 2, date: 2, imageDataUrl: 'data:image/jpeg;base64,BB', label: '四つ葉', source: 'photo' },
  ]);
  assert.deepEqual(slides.map(s => (s.kind === 'photo' ? s.id : 0)), [0, 2]);
});
