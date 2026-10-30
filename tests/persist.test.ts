// src/lib/persist.ts のテスト（記録が勝手に消されにくくするお願いと、その結果の記録）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askPersist, needsExportHint, readPersist, requestPersist, PERSIST_KEY, type KeyValue, type PersistApi } from '../src/lib/persist.ts';

const memory = (): KeyValue & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } };
};

test('結果: 許可された・断られた・使えない（エラーも「使えない」にして、投げない）', async () => {
  assert.equal(await askPersist({ persisted: async () => false, persist: async () => true }), 'granted');
  assert.equal(await askPersist({ persisted: async () => false, persist: async () => false }), 'denied');
  assert.equal(await askPersist(undefined), 'unsupported');
  assert.equal(await askPersist({}), 'unsupported');
  assert.equal(await askPersist({ persist: async () => { throw new Error('だめ'); } }), 'unsupported');
});

test('すでに許可されていれば、頼まない', async () => {
  let asked = 0;
  const api: PersistApi = { persisted: async () => true, persist: async () => { asked++; return true; } };
  assert.equal(await askPersist(api), 'granted');
  assert.equal(asked, 0);
});

test('結果を残す。once のときは、残っていれば、もう頼まない', async () => {
  const store = memory();
  let asked = 0;
  const api: PersistApi = { persist: async () => { asked++; return false; } };
  assert.equal(await requestPersist({ once: true, api, store, now: () => 1000 }), 'denied');
  assert.deepEqual(JSON.parse(store.data.get(PERSIST_KEY)!), { result: 'denied', at: 1000 });
  assert.equal(await requestPersist({ once: true, api, store }), null);
  assert.equal(asked, 1);
  // once でなければ、頼み直して、上書きする
  assert.equal(await requestPersist({ api: { persist: async () => true }, store, now: () => 2000 }), 'granted');
  assert.deepEqual(readPersist(store), { result: 'granted', at: 2000 });
});

test('設定の書き出しの案内: 断られた・使えないときだけ', () => {
  assert.equal(needsExportHint(null), false); // まだ頼んでいない
  assert.equal(needsExportHint({ result: 'granted', at: 0 }), false);
  assert.equal(needsExportHint({ result: 'denied', at: 0 }), true);
  assert.equal(needsExportHint({ result: 'unsupported', at: 0 }), true);
});

test('壊れた記録は、無いものとして読む', () => {
  const store = memory();
  store.set(PERSIST_KEY, '{');
  assert.equal(readPersist(store), null);
  store.set(PERSIST_KEY, JSON.stringify({ result: 'maybe', at: 1 }));
  assert.equal(readPersist(store), null);
});
