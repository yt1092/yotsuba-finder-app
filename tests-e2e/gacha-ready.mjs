// ホームの「今日のよつば」の行の、準備ができた印（npm run test:e2e の 8 つ目）
//
//   npm run build && node tests-e2e/gacha-ready.mjs
//
// 確かめること
//   1. 準備前（モデルが端末に無い）: 印を出さない
//   2. 準備後（モデルが端末のキャッシュにあり、読める）: 印を出す。文字は無い。読み上げの文がある。押せる範囲（行）は 48px 以上
//      ネットにつながっていない（navigator.onLine が false）ときも、出す
//   3. 読み込みの失敗（こわれたファイル・途中まで・この端末で読み込めなかった記録）: 出さない。エラーにしない
//   4. 自分のサイト以外への通信は 0 件
// Service Worker は止めておく（モデルを背景で取りにいかないように。キャッシュには、テストが入れる）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4177;
const BASE = `http://localhost:${PORT}`;
const MODEL = '/models/gacha-pretrain-fp32.onnx';
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
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    if (!res.headersSent) { res.writeHead(404); res.end(); }
  }
});
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch();
const outside = [];
const errors = [];
const step = async (name, fn) => { await fn(); console.log(`  ok: ${name}`); };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  context.on('request', req => { const u = req.url(); if (!/^(data|blob):/.test(u) && !u.startsWith(BASE)) outside.push(u); });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${BASE}/about.html`);
  await page.evaluate(() => localStorage.setItem('yotsuba-tutorial-seen', '1'));

  // ホームを開き直して、印を確かめ終えるのを待つ
  const home = async () => {
    await page.goto(`${BASE}/about.html`); // 同じ URL（#home つき）へは読み直さないので、いったん別の画面へ
    await page.goto(`${BASE}/index.html#home`); // 始まりの画面を出さずに、ホームを開く
    await page.waitForSelector('.gacha-entry[data-ready-checked]', { state: 'attached', timeout: 20_000 });
    return page.evaluate(() => {
      const mark = document.getElementById('gachaReady');
      const row = mark.closest('a').getBoundingClientRect();
      return { shown: !mark.hidden && mark.getBoundingClientRect().width > 0, label: mark.getAttribute('aria-label'), role: mark.getAttribute('role'), text: mark.textContent, rowH: row.height, rowW: row.width };
    });
  };
  // テストのキャッシュに、モデルを入れる（body: そのまま・こわれた中身・途中まで）
  const putModel = kind => page.evaluate(async ([url, kind]) => {
    for (const k of await caches.keys()) await caches.delete(k);
    if (kind === 'none') return;
    const real = await (await fetch(url)).arrayBuffer();
    const cache = await caches.open('yotsuba-test-models');
    if (kind === 'good') await cache.put(url, new Response(real, { headers: { 'Content-Length': String(real.byteLength) } }));
    if (kind === 'broken') await cache.put(url, new Response('<!doctype html><p>not found</p>', { headers: { 'Content-Type': 'text/html' } }));
    if (kind === 'partial') await cache.put(url, new Response(real.slice(0, 1_000_000), { headers: { 'Content-Length': String(real.byteLength) } }));
  }, [MODEL, kind]);
  const setLoad = ok => page.evaluate(([url, ok]) => {
    if (ok === null) localStorage.removeItem('yotsuba-gacha-load');
    else localStorage.setItem('yotsuba-gacha-load', JSON.stringify({ url, ok, at: Date.now() }));
  }, [MODEL, ok]);

  await step('準備前（モデルが端末に無い）: 印を出さない', async () => {
    await putModel('none');
    assert.equal((await home()).shown, false);
  });

  await step('準備後（モデルが読める）: 印を出す。文字は無く、読み上げの文がある。押せる範囲（行）は 48px 以上', async () => {
    await putModel('good');
    const m = await home();
    assert.equal(m.shown, true, JSON.stringify(m));
    assert.equal(m.text, '');
    assert.equal(m.role, 'img');
    assert.equal(m.label, '今日のよつばの 準備が できています');
    assert.ok(m.rowH >= 48 && m.rowW >= 48, JSON.stringify(m));
    await page.evaluate(() => document.querySelector('.gacha-entry').scrollIntoView({ block: 'center' })); // 下のメニューに隠れないように
    await page.screenshot({ path: 'docs/screens/finish-home.png' });
    await page.click('.gacha-entry');
    await page.waitForURL(/gacha\.html/);
  });

  await step('ネットにつながっていない（navigator.onLine が false）ときも、モデルが読めれば印を出す', async () => {
    const p = await context.newPage();
    await p.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false }));
    await p.goto(`${BASE}/index.html#home`); // 始まりの画面を出さずに、ホームを開く
    await p.waitForSelector('.gacha-entry[data-ready-checked]', { state: 'attached' });
    assert.equal(await p.evaluate(() => navigator.onLine), false);
    assert.equal(await p.isVisible('#gachaReady'), true);
    await p.close();
  });

  await step('読み込みの失敗（こわれたファイル・途中まで・この端末で読み込めなかった）: 印を出さない。エラーにしない', async () => {
    await putModel('broken');
    assert.equal((await home()).shown, false, 'こわれたファイル');
    await putModel('partial');
    assert.equal((await home()).shown, false, '途中まで');
    await putModel('good');
    await setLoad(false);
    assert.equal((await home()).shown, false, '読み込めなかった記録');
    await setLoad(true);
    assert.equal((await home()).shown, true, '読み込めた記録');
    await setLoad(null);
    assert.deepEqual(errors, [], 'ページのエラー');
  });

  await context.close();
  assert.deepEqual(outside, [], '自分のサイト以外への通信');
  console.log('OK: 今日のよつばの準備の印（準備前は出ない・準備後は出る・オフラインでも出る・失敗では出ない）・外部への通信 0 件');
} finally {
  await browser.close();
  server.close();
}
