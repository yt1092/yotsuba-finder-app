// カメラの画面（scan.html）の、強制終了のあとの動きと、今日のよつばのモデルの取り込みの確かめ（npm run test:e2e の 4 つ目）
//
//   npm run build && node tests-e2e/scan-crash.mjs
//
// 偽のカメラで scan.html を開き、ページをわざと落とす（Chrome の開発用の機能 Page.crash。iPhone で落ちたときと同じく、
// 画面を離れたときの処理が動かない）。確かめること
//   1. 1 秒ごとに、経過秒数・推論の回数・直近の推論の時間・映像の大きさを、localStorage に書く
//   2. 診断の URL（?diag=1）で開き直すと、「前回は◯秒で止まりました。そのときの推論は…」が出る。自動では始めない
//   3. ふつうの URL: 1 回目に落ちたあとは「カメラを つかう」の案内。続けて 2 回目に落ちると、写真から探すに切り替わり、理由の文が出る（16px 以上）
//   4. ブラウザが、落ちたあとに写真から探すを開いたとき（印が「動いている」のまま）も、理由の文が出る
//   5. scan.html を開いているあいだ（検出のモデルを読み込んでも）、今日のよつばのモデルを取りにいかない。ホームを開くと、背景で入る
//   6. カメラの検出は、ふだん WASM。次の推論までの間は「直前の推論の時間の半分、最小 200ms」（src/lib/scan-pace.ts）
//   7. 写真から探すの診断（?diag=1&repeat=3）: 同じ写真で 3 回続けて検出し、終わったと出す。途中で落ちたら、次に開いたとき「前回は◯回目の途中で止まりました」
//   8. 自分のサイト以外への通信は 0 件
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4184;
const BASE = (process.env.E2E_BASE ?? `http://localhost:${PORT}`).replace(/[/]$/, '');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.webp': 'image/webp',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
// サーバーが受けた、今日のよつばのモデルの依頼の数（Service Worker の背景の取り込みも、ここで数える）
let gachaServed = 0;
const server = createServer(async (req, res) => {
  if (req.url.includes('/models/gacha-pretrain-fp32.onnx')) gachaServed++;
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
if (!process.env.E2E_BASE) await new Promise(r => server.listen(PORT, r));

// 今日のよつばのモデルが、モデル用キャッシュに入るまで待つ（waitForFunction は、Promise を返す関数を待たないので、ここで調べ直す）
const waitGachaCached = async (page, timeout = 120_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(500)) {
    if (await page.evaluate(m => caches.match(m).then(r => !!r), '/models/gacha-pretrain-fp32.onnx')) return;
  }
  throw new Error('今日のよつばのモデルが、キャッシュに入らない');
};

const KEY = 'yotsuba-scan-session';
const PHOTO = 'public/images/tutorial-2.webp';
const GACHA = '/models/gacha-pretrain-fp32.onnx';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const outside = [];
const gachaAsked = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'], serviceWorkers: 'allow' });
  const record = url => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (!url.startsWith(BASE)) outside.push(url);
    if (url.includes(GACHA)) gachaAsked.push(url);
  };
  context.on('request', req => record(req.url()));
  context.on('serviceworker', sw => sw.on?.('request', req => record(req.url())));
  const step = async (name, fn) => { await fn(); console.log(`  ok: ${name}`); };
  const session = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY);
  // カメラの画面を開き、推論が n 回を超えるまで待ってから、ページを落とす
  // ページを落とす（Page.crash の返事は来ないので、待たずに、ページの crash のできごとを待つ）
  const crash = async page => {
    const crashed = new Promise(r => page.once('crash', r));
    const cdp = await context.newCDPSession(page);
    cdp.send('Page.crash').catch(() => undefined);
    await Promise.race([crashed, new Promise(r => setTimeout(r, 5000))]);
    await page.close().catch(() => undefined);
  };
  // この回に書いた印（開いた時刻より後に書いたもの）で、推論が n 回以上・動いている
  const waitRunning = (page, since, n = 1) => page.waitForFunction(([k, t, n]) => {
    const s = JSON.parse(localStorage.getItem(k) ?? 'null');
    return s && s.alive === true && s.at > t && s.infer >= n;
  }, [KEY, since, n], { timeout: 120_000, polling: 500 });
  const runAndCrash = async (url, minInfer = 1) => {
    const page = await context.newPage();
    const since = Date.now();
    await page.goto(`${BASE}${url}`);
    await waitRunning(page, since, minInfer);
    await page.waitForTimeout(1200); // 1 秒ごとの書き込みを、もう 1 回待つ
    const before = await session(page);
    await crash(page);
    return before;
  };

  // 準備: Service Worker を動かす（ホームは、検出のモデルがまだ無いので、今日のよつばのモデルを頼まない）
  const home = await context.newPage();
  await home.goto(`${BASE}/index.html`);
  await home.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await home.close();

  let last;
  await step('1. 1 秒ごとに、経過秒数・推論の回数・直近の推論の時間・映像の大きさを書く', async () => {
    const page = await context.newPage();
    await page.goto(`${BASE}/scan.html?diag=1`);
    await page.waitForFunction(k => (JSON.parse(localStorage.getItem(k) ?? 'null')?.infer ?? 0) >= 1, KEY, { timeout: 120_000, polling: 500 });
    const a = await session(page);
    await page.waitForTimeout(2500);
    const b = await session(page);
    assert.equal(b.alive, true);
    assert.ok(b.sec >= a.sec + 2, `1 秒ごとに書いていない: ${a.sec} → ${b.sec}`);
    assert.ok(b.at - a.at >= 1800 && b.at - a.at <= 3600, `書いた時刻の間: ${b.at - a.at}ms`);
    assert.ok(b.infer >= 1 && b.ms > 0, `推論の回数・時間: ${JSON.stringify(b)}`);
    assert.ok(b.frameW > 0 && b.frameH > 0, `映像の大きさが無い: ${JSON.stringify(b)}`);
    await page.close(); // きれいに終わる
  });

  await step('6. カメラの検出は、ふだん WASM。間は、直前の推論の時間の半分（最小 200ms）', async () => {
    const page = await context.newPage();
    await page.goto(`${BASE}/scan.html?diag=1`);
    await page.waitForFunction(k => (JSON.parse(localStorage.getItem(k) ?? 'null')?.infer ?? 0) >= 3, KEY, { timeout: 120_000, polling: 500 });
    const s = await session(page);
    assert.equal(s.backend, 'wasm');
    assert.ok(s.gap >= 200 && s.gap >= Math.round(s.ms / 2) - 1, `間: ${s.gap}ms（推論 ${s.ms}ms）`);
    console.log(`    推論 ${s.ms}ms → 間 ${s.gap}ms`);
    await page.close();
  });

  await step('5. scan.html のあいだは、今日のよつばのモデルを取りにいかない', async () => {
    assert.deepEqual(gachaAsked, [], `scan.html のあいだに、今日のよつばのモデルを取りにいった: ${gachaAsked}`);
    assert.equal(gachaServed, 0, 'scan.html のあいだに、サーバーが今日のよつばのモデルを送った');
    const page = await context.newPage();
    await page.goto(`${BASE}/scan.html`);
    await page.waitForTimeout(8000); // 前は、検出のモデルを取ったすぐあとに、背景で取りにいっていた
    assert.deepEqual(gachaAsked, [], `scan.html のあいだに、今日のよつばのモデルを取りにいった: ${gachaAsked}`);
    assert.equal(gachaServed, 0, 'scan.html のあいだに、サーバーが今日のよつばのモデルを送った（Service Worker の背景の取り込み）');
    assert.equal(await page.evaluate(m => caches.match(m).then(r => !!r), GACHA), false);
    await page.close();
  });

  await step('2. 診断の URL で落ちたあと、開き直すと「前回は◯秒で止まりました。そのときの推論は…」。自動では始めない', async () => {
    last = await runAndCrash('/scan.html?diag=1');
    assert.equal(last.alive, true);
    const page = await context.newPage();
    await page.goto(`${BASE}/scan.html?diag=1`);
    const text = await page.waitForFunction(() => [...document.querySelectorAll('div')].map(d => d.textContent).find(t => t?.startsWith('前回は')), null, { timeout: 10_000 }).then(h => h.jsonValue());
    assert.match(text, new RegExp(`^前回は ${last.sec}秒で 止まりました。そのときの推論は ${last.infer}回・直近 ${last.ms}ms・間 ${last.gap}ms・映像 ${last.frameW}×${last.frameH}・wasm`));
    assert.ok(await page.isVisible('#cameraHelp'), '自動で始まった（案内が出ていない）');
    await page.close();
  });

  await step('3. ふつうの URL: 1 回目は「カメラを つかう」の案内、続けて 2 回目で写真から探すに切り替わり、理由の文が出る', async () => {
    await (async () => { const p = await context.newPage(); await p.goto(`${BASE}/index.html`); await p.evaluate(k => localStorage.removeItem(k), KEY); await p.close(); })();
    await runAndCrash('/scan.html');
    let page = await context.newPage();
    await page.goto(`${BASE}/scan.html`);
    await page.waitForSelector('#cameraHelp:not([hidden])');
    assert.match(page.url(), /scan\.html/);
    const since = Date.now();
    await page.click('#cameraRetry'); // もう一度「カメラを つかう」
    await waitRunning(page, since);
    await page.waitForTimeout(1200);
    await crash(page);
    page = await context.newPage();
    await page.goto(`${BASE}/scan.html`);
    await page.waitForURL(/photo-pick\.html/, { timeout: 10_000 });
    const box = await page.waitForSelector('#cameraFallback:not([hidden])');
    assert.equal(await box.textContent(), 'カメラが 不安定なので、写真から探すに 切り替えました。写真を 1枚 えらぶと、四つ葉を 探します。');
    assert.ok(await box.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    assert.equal(new URL(page.url()).search, '', '読み込み直すと、また出る');
    // 次にカメラを開いたときは、ふつうに始まる
    await page.goto(`${BASE}/scan.html`);
    await page.waitForTimeout(1500);
    assert.match(page.url(), /scan\.html/);
    assert.ok(await page.isHidden('#cameraHelp'));
    await page.close();
  });

  await step('4. 落ちたあとに、ブラウザが写真から探すを開いたときも、理由の文が出る', async () => {
    await runAndCrash('/scan.html');
    const page = await context.newPage();
    await page.goto(`${BASE}/photo-pick.html`);
    await page.waitForSelector('#cameraFallback:not([hidden])');
    assert.equal((await session(page)).alive, false, '見たあとも、印が「動いている」のまま');
    await page.reload();
    assert.ok(await page.isHidden('#cameraFallback'), '2 回目も出た');
    await page.close();
  });

  await step('5. ホームを開くと、今日のよつばのモデルが、背景で入る（検出のモデルがあるとき）', async () => {
    const page = await context.newPage();
    await page.goto(`${BASE}/index.html`);
    await waitGachaCached(page);
    assert.ok(gachaServed >= 1 || process.env.E2E_BASE, 'ホームで、背景の取り込みが動いていない');
    await page.close();
  });

  await step('7. 写真から探すの診断: 同じ写真で 3 回続ける。途中で落ちたら、次に開いたとき、何回目で止まったかを出す', async () => {
    const REPEAT = 'yotsuba-photo-repeat';
    const repeat = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null'), REPEAT);
    let page = await context.newPage();
    await page.goto(`${BASE}/photo-pick.html?diag=1&repeat=3`);
    await page.setInputFiles('#fileInput', PHOTO);
    await page.waitForFunction(() => /3回 続けて 終わりました/.test(document.querySelector('.diag-box')?.textContent ?? ''), null, { timeout: 300_000, polling: 500 });
    const done = await repeat(page);
    assert.equal(done.alive, false);
    assert.equal(done.ms.length, 3);
    assert.match(page.url(), /photo-pick\.html/, '結果の画面に進んだ');
    console.log(`    ${await page.textContent('.diag-box')}`);
    // 途中で落とす
    await page.reload();
    await page.setInputFiles('#fileInput', PHOTO);
    await page.waitForFunction(k => (JSON.parse(localStorage.getItem(k) ?? 'null')?.done ?? 0) >= 1 && JSON.parse(localStorage.getItem(k)).alive, REPEAT, { timeout: 300_000, polling: 200 });
    const before = await repeat(page);
    await crash(page);
    page = await context.newPage();
    await page.goto(`${BASE}/photo-pick.html?diag=1&repeat=3`);
    const text = await page.textContent('.diag-box');
    assert.match(text, new RegExp(`^前回は ${before.done + 1}回目の 途中で 止まりました`), text);
    console.log(`    ${text}`);
    await page.close();
  });

  assert.deepEqual(outside, [], `自分のサイト以外への通信がありました:\n${outside.join('\n')}`);
  console.log('OK: カメラは WASM・間は実測から・写真から探すを続けて検出する診断・落ちる前の状態を 1 秒ごとに残す・診断の URL で前回のようす・2 回目で写真から探す（理由の文）・scan.html では今日のよつばのモデルを取らない・外部への通信 0 件');
} finally {
  await browser.close();
  if (!process.env.E2E_BASE) server.close();
}
