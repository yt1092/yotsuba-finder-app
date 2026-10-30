// src/lib/gacha-list.ts・src/lib/gacha-thumb.ts のテスト（今日のよつばの一覧を、図鑑と分ける）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GACHA_SHAPE_SIZE, collectionItems, gachaDateLabel, gachaListItems, idToSkipPast, isGacha, newGachaRecord, planGachaMove, recordStoreOf, sortGacha, splitGacha } from '../src/lib/gacha-list.ts';
import { shapeThumb } from '../src/lib/gacha-thumb.ts';

const photo = (id: number, label: '四つ葉' | '三つ葉' = '四つ葉') => ({ id, date: id * 1000, imageDataUrl: 'data:image/jpeg;base64,AA', label, source: 'photo' as const });
const gacha = (id: number, day: string) => ({ id, date: id * 1000, imageDataUrl: 'data:image/jpeg;base64,BB', label: '四つ葉' as const, source: 'gacha' as const, gachaDay: day, gachaKind: 'dit' as const });

test('分ける: 図鑑の写真と、今日のよつば（順番はそのまま）', () => {
  const all = [photo(1), gacha(2, '2026-10-28'), photo(3, '三つ葉'), gacha(4, '2026-10-29')];
  const { photos, gacha: g } = splitGacha(all);
  assert.deepEqual(photos.map(r => r.id), [1, 3]);
  assert.deepEqual(g.map(r => r.id), [2, 4]);
  assert.ok(isGacha(g[0]) && !isGacha(photos[0]));
});

test('混ぜない: 図鑑の「すべて」「四つ葉」には、今日のよつばが入らない（移せずに残ったものがあっても）', () => {
  const all = [photo(1), gacha(2, '2026-10-28'), photo(3, '三つ葉')];
  assert.deepEqual(collectionItems(all, 'all').map(r => r.id), [1, 3]);
  assert.deepEqual(collectionItems(all, '四つ葉').map(r => r.id), [1]);
});

test('今日のよつばの一覧: 新しい日が上。日付は「2026年10月29日」（日付が無い古い記録は、入れた日）', () => {
  const list = sortGacha([gacha(1, '2026-10-27'), gacha(3, '2026-10-29'), gacha(2, '2026-10-28')]);
  assert.deepEqual(list.map(r => r.gachaDay), ['2026-10-29', '2026-10-28', '2026-10-27']);
  assert.equal(gachaDateLabel(list[0]), '2026年10月29日');
  const old = { date: new Date(2026, 9, 5, 12).getTime() };
  assert.equal(gachaDateLabel(old), '2026年10月5日');
});

test('移すもの: 図鑑の入れ物にある、今日のよつばだけ（ID のあるもの）', () => {
  const move = planGachaMove([photo(1), gacha(2, '2026-10-28'), { ...gacha(0, '2026-10-29'), id: undefined }]);
  assert.deepEqual(move.map(r => r.id), [2]);
});

// IndexedDB の自動の番号（入れ物ごと）: 番号を指定して書くと、それより先に進む。足すと、次の番号
class Numbering {
  next = 1;
  put(id: number) { if (id >= this.next) this.next = id + 1; }
  add() { return this.next++; }
}

test('ID が重ならない: 今日のよつばの ID は、図鑑の記録と同じ番号の並びから取る', () => {
  // 図鑑に 1〜5。今日のよつばを足すときは、図鑑の入れ物の番号を 1 つ使う（src/lib/db.ts の reserveId）
  const recs = new Numbering();
  for (let i = 0; i < 5; i++) recs.add();
  const gachaId = recs.add();      // 今日のよつば → 6
  const nextPhoto = recs.add();    // 次の写真 → 7
  assert.notEqual(gachaId, nextPhoto);
  // 読み込み（上書き）で、今日のよつばを ID つきで書いたとき（図鑑の記録は 1〜3、今日のよつばは 10）: 図鑑の番号を 10 の先に進める
  const after = new Numbering();
  for (const id of [1, 2, 3]) after.put(id);
  const skip = idToSkipPast([1, 2, 3], [10]);
  assert.equal(skip, 10);
  after.put(skip!);
  assert.equal(after.add(), 11);
  // 図鑑の記録のほうが大きければ、何もしない。今日のよつばが無ければ、何もしない
  assert.equal(idToSkipPast([1, 20], [10]), null);
  assert.equal(idToSkipPast([1, 2], []), null);
  assert.equal(idToSkipPast([], [4]), 4);
});

test('64×64 の絵: 絵の全体を、64×64 の中に収める（正方形でなければ、まん中に置く）', () => {
  const made: { w: number; h: number; draws: number[][]; type: string }[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const c = { width: 0, height: 0, draws: [] as number[][], getContext: () => ({ imageSmoothingQuality: '', drawImage: (_s: unknown, ...a: number[]) => c.draws.push(a) }),
        toDataURL: (type: string) => { made.push({ w: c.width, h: c.height, draws: c.draws, type }); return `data:${type};base64,AA`; } };
      return c;
    },
  };
  try {
    assert.equal(GACHA_SHAPE_SIZE, 64);
    assert.match(shapeThumb({} as CanvasImageSource, 512, 512), /^data:image\/png/);
    assert.deepEqual(made[0], { w: 64, h: 64, draws: [[0, 0, 64, 64]], type: 'image/png' });
    shapeThumb({} as CanvasImageSource, 400, 200);
    assert.deepEqual(made[1].draws, [[0, 16, 64, 32]]);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test('保存先: 今日のよつばは、図鑑の入れ物に入らない（今日のよつばの入れ物へ）。写真は図鑑の入れ物へ', () => {
  const rec = newGachaRecord({ now: 5, image: 'data:image/jpeg;base64,CC', day: '2026-10-30', kind: 'dit', shape64: 'data:image/png;base64,DD' });
  assert.deepEqual(rec, { date: 5, imageDataUrl: 'data:image/jpeg;base64,CC', label: '四つ葉', source: 'gacha', gachaDay: '2026-10-30', gachaKind: 'dit', shape64: 'data:image/png;base64,DD' });
  assert.equal(recordStoreOf(rec), 'gacha');
  assert.equal(recordStoreOf(newGachaRecord({ now: 5, image: 'x', day: '2026-10-30', kind: 'preset' })), 'gacha');
  assert.ok(!('shape64' in newGachaRecord({ now: 5, image: 'x', day: '2026-10-30', kind: 'preset' })));
  for (const source of ['camera', 'photo'] as const) assert.equal(recordStoreOf({ source }), 'records');
});

test('図鑑の「今日のよつば」: 今日のよつばの入れ物のものと、移せずに図鑑の入れ物に残ったもの。写真は入らない', () => {
  const list = gachaListItems([gacha(5, '2026-10-29'), gacha(2, '2026-10-27')], [photo(1), gacha(3, '2026-10-28'), photo(4)]);
  assert.deepEqual(list.map(r => r.id), [5, 3, 2]);
  assert.ok(list.every(isGacha));
});
