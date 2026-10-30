// src/lib/gacha-move.ts のテスト（版 5 へ上げるときの、今日のよつばの移し替え）
// IndexedDB の代わりに、入れ物を Map でまねる（書けたかどうかを、あとで知らせる）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveGacha, type GachaMoveOps, type GachaMoveSummary } from '../src/lib/gacha-move.ts';
import type { CloverRecord } from '../src/lib/db.ts';

const photo = (id: number): CloverRecord => ({ id, date: id, imageDataUrl: `data:image/jpeg;base64,P${id}`, label: '四つ葉', source: 'photo', note: `しゃしん${id}` });
const gacha = (id: number): CloverRecord => ({ id, date: id, imageDataUrl: `data:image/jpeg;base64,G${id}`, label: '四つ葉', source: 'gacha', gachaDay: `2026-10-2${id}`, gachaKind: 'dit', note: `ひとこと${id}`, ink: { lines: [], stickers: [] } as never });

function fakeDb(records: CloverRecord[], opts: { failAdd?: number[]; failKeep?: boolean; failGetAll?: boolean } = {}) {
  const recs = new Map(records.map(r => [r.id!, structuredClone(r)]));
  const gachaStore = new Map<number, CloverRecord>();
  const kept: GachaMoveSummary[] = [];
  const queue: (() => void)[] = [];
  const later = (f: () => void) => queue.push(f); // IndexedDB と同じく、結果はあとで
  const ops: GachaMoveOps = {
    getAll: (ok, fail) => later(() => (opts.failGetAll ? fail('UnknownError') : ok([...recs.values()].map(r => structuredClone(r))))),
    keep: (s, ok, fail) => later(() => { if (opts.failKeep) fail('QuotaExceededError'); else { kept.push(structuredClone(s)); ok(); } }),
    add: (r, ok, fail) => later(() => {
      if (opts.failAdd?.includes(r.id) || gachaStore.has(r.id)) return fail('ConstraintError');
      gachaStore.set(r.id, structuredClone(r)); ok();
    }),
    remove: id => later(() => { recs.delete(id); }),
  };
  const run = () => { while (queue.length) queue.shift()!(); };
  return { recs, gachaStore, kept, ops, run };
}

test('移る: 図鑑の今日のよつばが、今日のよつばの入れ物へ（ID・ひとこと・手書きもそのまま）。写真の記録は動かない', () => {
  const before = [photo(1), gacha(2), photo(3), gacha(4)];
  const db = fakeDb(before);
  moveGacha(db.ops, 4, 123);
  db.run();
  assert.deepEqual([...db.recs.keys()], [1, 3]);
  assert.deepEqual(db.recs.get(1), photo(1)); // 前から図鑑にある写真は、書きかえない
  assert.deepEqual(db.recs.get(3), photo(3));
  assert.deepEqual([...db.gachaStore.values()], [gacha(2), gacha(4)]);
  const last = db.kept.at(-1)!;
  assert.deepEqual(last.moved, [2, 4]);
  assert.deepEqual(last.failed, []);
  assert.equal(last.done, true);
});

test('元の値が残る: 移す前に、元の値を残す（最初に残したときは、まだ何も動いていない）', () => {
  const db = fakeDb([photo(1), gacha(2), gacha(4)]);
  moveGacha(db.ops, 4, 123);
  db.run();
  assert.equal(db.kept.length, 2);
  const first = db.kept[0];
  assert.deepEqual(first.records, [gacha(2), gacha(4)]);
  assert.deepEqual([first.moved, first.done, first.fromVersion, first.at], [[], false, 4, 123]);
  assert.deepEqual(db.kept[1].records, [gacha(2), gacha(4)]); // 結果を残し直しても、元の値はそのまま
});

test('移せないもの: 理由つきで残り、図鑑から消えない。ほかのものは移る', () => {
  const db = fakeDb([gacha(2), gacha(4), photo(5)], { failAdd: [4] });
  moveGacha(db.ops, 4, 1);
  db.run();
  assert.deepEqual([...db.recs.keys()], [4, 5]);          // 4 は図鑑の入れ物に残る
  assert.deepEqual(db.recs.get(4), gacha(4));
  assert.deepEqual([...db.gachaStore.keys()], [2]);
  assert.deepEqual(db.kept.at(-1)!.failed, [{ id: 4, reason: 'ConstraintError' }]);
  assert.deepEqual(db.kept.at(-1)!.moved, [2]);
});

test('元の値を残せない・読めない: 何も移さず、何も消さない。エラーを投げない（DB は開ける）', () => {
  for (const o of [{ failKeep: true }, { failGetAll: true }]) {
    const db = fakeDb([photo(1), gacha(2)], o);
    const warned: string[] = [];
    db.ops.warn = m => warned.push(m);
    assert.doesNotThrow(() => { moveGacha(db.ops, 4, 1); db.run(); });
    assert.deepEqual([...db.recs.keys()], [1, 2]);
    assert.equal(db.gachaStore.size, 0);
    assert.equal(warned.length, 1);
  }
});

test('今日のよつばが無いとき: 何も書かない', () => {
  const db = fakeDb([photo(1), photo(2)]);
  moveGacha(db.ops, 4, 1);
  db.run();
  assert.deepEqual(db.kept, []);
  assert.equal(db.recs.size, 2);
});
