// scripts/make-licenses.mjs のテスト（「このアプリについて」の部品のライセンスの一覧）
// アプリと一緒に配る部品すべてに、ライセンスの全文が入っていること（node_modules を読む。npm ci のあとで動かす）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLicenses } from '../scripts/make-licenses.mjs';

const list = collectLicenses();
const part = (name: string) => list.find(p => p.name === name)!;

test('部品すべてに、ライセンスの全文が入っている（短い説明や、無いという断り書きではない）', () => {
  assert.ok(list.length >= 5);
  for (const p of list) {
    assert.ok(p.text.length >= 500, `${p.name}: ${p.text.length} 文字`);
    assert.doesNotMatch(p.text, /ライセンスの文のファイルがありません/, p.name);
  }
});

test('onnxruntime-web: MIT の全文と、wasm に入っている部品のライセンス（ThirdPartyNotices）', () => {
  const ort = part('onnxruntime-web');
  assert.match(ort.text, /^MIT License\n\nCopyright \(c\) Microsoft Corporation\n\nPermission is hereby granted/);
  assert.match(ort.text, /THIRD PARTY SOFTWARE NOTICES AND INFORMATION/);
  assert.match(part('onnxruntime-common').text, /^MIT License/);
});

test('ファイルの無い部品（guid-typescript）は、ISC の全文と著作権の表示', () => {
  assert.match(part('guid-typescript').text, /^ISC License\n\nCopyright \(c\) nicolas\n\nPermission to use, copy, modify/);
});

test('フォント（SIL OFL 1.1）は、著作権の表示つきの全文', () => {
  for (const [name, holder] of [['@fontsource/nunito', 'The Nunito Project Authors'], ['@fontsource/klee-one', 'The Klee Project Authors'], ['@fontsource/zen-maru-gothic', 'The Zen Maru Gothic Authors']]) {
    const t = part(name).text;
    assert.match(t, new RegExp(`Copyright \\d{4} ${holder}`), name);
    assert.match(t, /SIL OPEN FONT LICENSE Version 1\.1/i, name);
  }
});
