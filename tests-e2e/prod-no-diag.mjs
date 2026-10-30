// 本番のビルドに、診断（?diag=1 など）と測定・診断のファイルが入っていないことの確かめ（npm run test:e2e には入れない。本番の設定のビルドが要る）
//
//   VERCEL_ENV=production npm run build && node tests-e2e/prod-no-diag.mjs
//   E2E_BASE=https://yotsuba-finder.vercel.app node tests-e2e/prod-no-diag.mjs   … 本番のドメインに向ける
//
// 確かめること
//   1. /bench.html・/bench-threads.html・/models/diag/ のモデル・/bench-ort/ が 404
//   2. ?diag=1&sleep=0 を付けてカメラを開いても、診断の表示が出ず、ふつうに検出する（WASM）
//   3. ?diag=1&repeat=3 を付けて写真から探すを使っても、続けて検出せず、ふつうに結果の画面に進む
//   4. 落ちたあとの見張りは残っている: 続けて 2 回落ちたら、?diag=1 を付けていても、写真から探すに切り替わる
//   5. 通常の画面が開く・自分のサイト以外への通信は 0 件
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4188;
const BASE = (process.env.E2E_BASE ?? `http://localhost:${PORT}`).replace(/[/]$/, '');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.webp': 'image/webp',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const server = createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, BASE).pathname)).replace(/^[\\/]+/, '');
    if (!path) path = 'index.html';
    const file = join('dist', path);
    if (!file.startsWith('dist')) throw new Error('外');
    if ((await stat(file)).isDirectory()) throw new Error('フォルダ');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    if (!res.headersSent) { res.writeHead(404); res.end(); }
  }
});
if (!process.env.E2E_BASE) await new Promise(r => server.listen(PORT, r));

const KEY = 'yotsuba-scan-session';
const PHOTO = 'public/images/tutorial-2.webp';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const outside = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'], serviceWorkers: 'allow' });
  context.on('request', req => { const u = req.url(); if (!/^(data|blob):/.test(u) && !u.startsWith(BASE)) outside.push(u); });
  const step = async (name, fn) => { await fn(); console.log(`  ok: ${name}`); };
  const page = await context.newPage();

  await step('測定・診断のファイルは 404', async () => {
    for (const p of ['/bench.html', '/bench-threads.html', '/models/diag/yotsuba-v3.onnx', '/models/diag/yotsuba-v5mix-fp16.onnx', '/bench-ort/1.30.0/ort-wasm-simd-threaded.asyncify.mjs']) {
      const r = await page.request.get(`${BASE}${p}`, { maxRedirects: 0 });
      assert.equal(r.status(), 404, `${p} が ${r.status()}`);
      assert.equal(r.headers()['cross-origin-embedder-policy'], undefined, `${p} に COEP が付いている`);
      assert.equal(r.headers()['cross-origin-opener-policy'], undefined, `${p} に COOP が付いている`);
    }
  });

  await step('通常の画面が開く（COOP/COEP なし）', async () => {
    for (const p of ['index.html', 'collection.html', 'kiroku.html', 'settings.html', 'gacha.html', 'photo-pick.html']) {
      const r = await page.goto(`${BASE}/${p}`);
      assert.equal(r.status(), 200, `${p} が ${r.status()}`);
      assert.equal(r.headers()['cross-origin-embedder-policy'], undefined, `${p} に COEP が付いている`);
      assert.equal(await page.evaluate(() => self.crossOriginIsolated), false);
    }
  });

  await step('カメラに ?diag=1&sleep=0 を付けても、診断の表示が出ない（WASM で検出する）', async () => {
    await page.evaluate(k => localStorage.removeItem(k), KEY);
    await page.goto(`${BASE}/scan.html?diag=1&sleep=0`);
    await page.waitForFunction(k => (JSON.parse(localStorage.getItem(k) ?? 'null')?.infer ?? 0) >= 1, KEY, { timeout: 120_000, polling: 500 });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('.diag-box').count(), 0, '診断の表示が出ている');
    const s = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
    assert.equal(s.backend, 'wasm');
    await page.goto(`${BASE}/index.html`); // きれいに終わる
  });

  await step('写真から探すに ?diag=1&repeat=3 を付けても、ふつうに結果の画面に進む', async () => {
    await page.goto(`${BASE}/photo-pick.html?diag=1&repeat=3`);
    assert.equal(await page.locator('.diag-box').count(), 0, '診断の表示が出ている');
    await page.setInputFiles('#fileInput', PHOTO);
    await page.waitForURL(/photo-(found|none)\.html/, { timeout: 180_000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('yotsuba-photo-repeat')), null, '続けて検出した記録がある');
  });

  await step('続けて 2 回落ちたら、?diag=1 を付けていても、写真から探すに切り替わる（見張りは残る）', async () => {
    await page.goto(`${BASE}/index.html`);
    await page.evaluate(k => localStorage.setItem(k, JSON.stringify({
      alive: true, sec: 12, infer: 20, ms: 400, crashes: 1, queue: 0, backend: 'wasm', model: 'mix', res: 1280, at: Date.now(),
    })), KEY);
    await page.goto(`${BASE}/scan.html?diag=1`);
    // 写真から探すは、理由の文を出したあと ?from=camera を URL から消す（読み込み直しても、もう出さない）
    await page.waitForURL(/photo-pick\.html/, { timeout: 30_000 });
    await page.waitForSelector('#cameraFallback:not([hidden])', { timeout: 10_000 });
    assert.match(await page.textContent('#cameraFallback'), /写真から探すに 切り替えました/);
  });

  assert.deepEqual(outside, [], '自分のサイト以外への通信');
  console.log('  ok: 自分のサイト以外への通信は 0 件');
  console.log('OK');
} finally {
  await browser.close();
  server.close();
}
