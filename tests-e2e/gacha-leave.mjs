// 「今日のよつば」: 画面を離れたとき、作っている途中でも、ワーカーが止まるか（npm run test:e2e の 2 つ目）
//
//   npm run build && node tests-e2e/gacha-leave.mjs
//
// ワーカーが始まった数・止まった数は、Playwright の worker イベント（作られた）と close イベント（terminate された）で数える
// （アプリに、テストのための仕組みは入れない）。作っている途中で離れるために、CPU を遅くする（Chrome の開発用の機能）
// 確かめること
//   1. ふつうに作り終えたら、ワーカーは止まる（始まった 1・止まった 1）
//   2. 「ひく」を押したすぐあと（ワーカーを作る前）に離れる → ワーカーは作られない。戻ると「ひく前」。今日の形は残らない
//   3. ワーカーが動いている途中で離れる（visibilitychange の hidden）→ すぐ止まる。あとから結果が来ても使わない
//   4. 動いている途中で、別のページへ移る（pagehide）→ 止まる
//   どれも、ページでエラーが出ないこと
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4181;
const BASE = `http://localhost:${PORT}`;
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
    await stat(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    if (!res.headersSent) { res.writeHead(404); res.end(); }
  }
});
await new Promise(r => server.listen(PORT, r));

const t0 = Date.now();
const log = msg => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const readToday = page => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('yotsuba-hunter');
  open.onsuccess = () => {
    const req = open.result.transaction('progress', 'readonly').objectStore('progress').get('gachaToday');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  };
  open.onerror = () => reject(open.error);
}));
const clearToday = page => page.evaluate(() => new Promise(resolve => {
  const open = indexedDB.open('yotsuba-hunter');
  open.onsuccess = () => { const tx = open.result.transaction('progress', 'readwrite'); tx.objectStore('progress').delete('gachaToday'); tx.oncomplete = resolve; };
}));
// 画面を隠す・出す（タブを切り替えたときと同じ visibilitychange を出す）
const setVisible = (page, visible) => page.evaluate(v => {
  Object.defineProperty(document, 'visibilityState', { value: v ? 'visible' : 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, visible);

// 今日のよつばのモデルが、モデル用キャッシュに入るまで待つ（waitForFunction は、Promise を返す関数を待たないので、ここで調べ直す）
const waitGachaCached = async (page, timeout = 120_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(500)) {
    if (await page.evaluate(m => caches.match(m).then(r => !!r), '/models/gacha-pretrain-fp32.onnx')) return;
  }
  throw new Error('今日のよつばのモデルが、キャッシュに入らない');
};

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors = []; // ページのエラー（止めるときに、エラーが出ていないか）
  page.on('pageerror', e => errors.push(e.message));
  // ワーカーの数（今日のよつばのワーカーだけ）
  const count = { started: 0, closed: 0 };
  page.on('worker', w => {
    if (!/gacha\.worker/.test(w.url())) return;
    count.started++;
    w.on('close', () => { count.closed++; });
  });
  // 止まったワーカーが n になるまで、5 秒まで待つ
  const waitClosed = async n => {
    for (let i = 0; i < 50 && count.closed < n; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(count.closed, n, `止まったワーカーの数: ${count.closed}（${n} のはず）`);
  };

  // 準備: Service Worker を動かし、検出のモデルを取る → 背景で、今日のよつばのモデルが入る
  await page.goto(`${BASE}/index.html`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.evaluate(() => fetch('/models/yotsuba-v5mix.onnx').then(r => r.arrayBuffer()).then(b => b.byteLength));
  await page.goto(`${BASE}/index.html`); // ホームを開くと、背景で今日のよつばのモデルが入る
  await waitGachaCached(page);
  log('準備: 今日のよつばのモデルがキャッシュに入った');

  // 1. ふつうに作り終える
  await page.goto(`${BASE}/gacha.html`);
  await page.click('#gachaDraw');
  await page.waitForSelector('#gachaResult:not([hidden])', { timeout: 60_000 });
  assert.equal(count.started, 1);
  await waitClosed(1);
  log(`1. 作り終えたら止まる: 始まった ${count.started}・止まった ${count.closed}`);

  // ここからは CPU を 20 倍遅くして、作っている途中で離れられるようにする
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });

  // 2. 押してすぐ（同じ瞬間）に離れる: ワーカーは作られない
  await clearToday(page);
  await page.reload();
  await page.waitForSelector('#gachaBefore:not([hidden])');
  // 押すのと隠すのを、同じ瞬間に（ワーカーを作る前の、キャッシュを見ているあいだに離れる）
  await page.evaluate(() => {
    document.getElementById('gachaDraw').click();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1500);
  await setVisible(page, true);
  await page.waitForTimeout(1500);
  assert.equal(count.started, 1, `押してすぐ離れたのに、ワーカーが作られた（始まった ${count.started}）`);
  assert.ok(await page.isVisible('#gachaBefore'), '戻ったのに「ひく前」ではない');
  assert.equal(await readToday(page), null, '途中で離れたのに、今日の形が残った');
  log('2. 押してすぐ離れる: ワーカーは作られない・ひく前にもどる');

  // 3. ワーカーが動いている途中で離れる（hidden）
  await page.click('#gachaDraw');
  for (let i = 0; i < 100 && count.started < 2; i++) await page.waitForTimeout(50);
  assert.equal(count.started, 2, 'ワーカーが始まらない');
  assert.ok(await page.isVisible('#gachaMaking'), '「つくっている間」になっていない');
  await setVisible(page, false);
  await waitClosed(2);
  log(`3. 途中で離れる（hidden）: すぐ止まる（始まった ${count.started}・止まった ${count.closed}）`);
  await page.waitForTimeout(3000); // 止めたワーカーの結果が、あとから来ても使わない
  await setVisible(page, true);
  await page.waitForTimeout(500);
  assert.ok(await page.isVisible('#gachaBefore'), '戻ったのに「ひく前」ではない');
  assert.equal(await readToday(page), null, '途中で止めたのに、今日の形が残った');

  // 4. 動いている途中で、別のページへ移る（pagehide）
  await page.click('#gachaDraw');
  for (let i = 0; i < 100 && count.started < 3; i++) await page.waitForTimeout(50);
  assert.equal(count.started, 3, 'ワーカーが始まらない');
  await page.goto(`${BASE}/index.html#home`);
  await waitClosed(3);
  log(`4. 途中で別のページへ（pagehide）: 止まる（始まった ${count.started}・止まった ${count.closed}）`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  assert.deepEqual(errors, [], `ページでエラーが出た: ${errors.join(' / ')}`);

  console.log('OK: 今日のよつばのワーカーは、作り終えたとき・画面を離れたとき（作っている途中でも）に止まる');
} finally {
  await browser.close();
  server.close();
}
