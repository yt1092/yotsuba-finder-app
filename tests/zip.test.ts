// src/lib/zip.ts のテスト（まちがいの記録の書き出しに使う zip）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, createZip } from '../src/lib/zip.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

test('CRC-32: よく知られた値と一致する', () => {
  assert.equal(crc32(bytes('')), 0);
  assert.equal(crc32(bytes('hello')), 0x3610a686);
  assert.equal(crc32(bytes('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('zip: ファイルの名前と中身を、そのまま取り出せる（中のしくみを読んで確かめる）', () => {
  const files = [
    { name: 'answers.json', data: bytes('{"ok":true}') },
    { name: 'photos/まちがい-1.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
  ];
  const zip = createZip(files.map(f => ({ ...f, date: new Date(2026, 9, 22, 12, 34, 56) })));
  const v = new DataView(zip.buffer);

  // 終わりの印から、セントラルディレクトリの位置と件数を読む
  const end = zip.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  let p = v.getUint32(end + 16, true);

  const decoder = new TextDecoder();
  for (const f of files) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const localAt = v.getUint32(p + 42, true);
    assert.equal(decoder.decode(zip.subarray(p + 46, p + 46 + nameLen)), f.name);
    assert.equal(v.getUint32(p + 16, true), crc32(f.data));

    // ローカルファイルヘッダーの後ろに、中身がそのまま入っている
    assert.equal(v.getUint32(localAt, true), 0x04034b50);
    assert.equal(v.getUint16(localAt + 6, true) & 0x0800, 0x0800); // 名前は UTF-8
    const start = localAt + 30 + v.getUint16(localAt + 26, true);
    assert.deepEqual([...zip.subarray(start, start + size)], [...f.data]);
    p += 46 + nameLen;
  }
});

test('zip: 0 件でも、正しい空の zip になる', () => {
  const zip = createZip([]);
  assert.equal(zip.length, 22);
  assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x06054b50);
});
