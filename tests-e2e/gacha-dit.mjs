// 「今日のよつば」: モデルの取り方・60 枚に切り替わるとき・種（端末ごとの値）の確かめ（npm run test:e2e の 3 つ目）
//
//   npm run build && node tests-e2e/gacha-dit.mjs
//
// 検出を一度も使っていない（今日のよつばのモデルが、まだ端末に無い）ところから始める
//   1. オフラインで、モデルが無い → 60 枚から出る。説明の 1 行は出ない。今日の形は残らない。設定は「まだ準備中です」
//   2. オンラインで、モデルが無い → ひいたときに、その場で取る（「準備しています」）→ DiT の形。残る。設定は「準備できています」
//   3. 同じ端末の同じ日は、同じ形（今日の形を消して、もう一度ひいても同じ）
//   4. 端末の値がちがえば、同じ日でも、ちがう形（いくつかの値で、すべてちがう）
//   5. モデルを取ったあとは、オフラインでも DiT の形
//   6. 「すべてのデータを消す」で、端末の値と今日の形が消える。次は、新しい値になる
//   7. 自分のサイト以外への通信は 0 件（モデルを取るのも、自分のサイトから）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4182;
// E2E_BASE に URL を入れると、そのサイト（本番など）に向けて確かめる（小さなサーバーは立てない）
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
    await stat(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    if (!res.headersSent) { res.writeHead(404); res.end(); }
  }
});
if (!process.env.E2E_BASE) await new Promise(r => server.listen(PORT, r));

const DIT_NOTE = 'この端末の中で、小さなモデル（DiT）が作った形です';
const MODEL = '/models/gacha-pretrain-fp32.onnx';

// IndexedDB の progress の入れ物の 1 件を読む・書く・消す
const progress = (page, op, id, value) => page.evaluate(([op, id, value]) => new Promise((resolve, reject) => {
  const open = indexedDB.open('yotsuba-hunter');
  open.onsuccess = () => {
    const tx = open.result.transaction('progress', op === 'get' ? 'readonly' : 'readwrite');
    const store = tx.objectStore('progress');
    const req = op === 'get' ? store.get(id) : op === 'put' ? store.put({ id, ...value }) : store.delete(id);
    let out = null;
    req.onsuccess = () => { out = req.result ?? null; };
    tx.oncomplete = () => resolve(op === 'get' ? out : null);
    tx.onerror = () => reject(tx.error);
  };
  open.onerror = () => reject(open.error);
}), [op, id, value ?? null]);

const browser = await chromium.launch();
const outside = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  const modelAsked = [];
  const record = url => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (!url.startsWith(BASE)) outside.push(url);
    if (url.includes(MODEL)) modelAsked.push(url);
  };
  context.on('request', req => record(req.url()));
  context.on('serviceworker', sw => sw.on?.('request', req => record(req.url())));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const step = async (name, fn) => { await fn(); console.log(`  ok: ${name}`); };

  // ひいて、結果まで待つ。「つくっている間」に出た文（準備しています・つくっています）も集める
  const draw = async () => {
    await page.goto(`${BASE}/gacha.html`);
    await page.waitForSelector('#gachaBefore:not([hidden])');
    await page.evaluate(() => {
      window.__stages = [];
      const el = document.getElementById('gachaStage');
      new MutationObserver(() => window.__stages.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
    await page.click('#gachaDraw');
    await page.waitForSelector('#gachaResult:not([hidden])', { timeout: 90_000 });
    const note = await page.$eval('#gachaNote', el => (el.hidden ? null : el.textContent));
    const stages = await page.evaluate(() => window.__stages);
    const today = await progress(page, 'get', 'gachaToday');
    return { note, stages, today };
  };
  const settingsLine = async () => {
    await page.goto(`${BASE}/settings.html`);
    await page.waitForFunction(() => !/しらべています/.test(document.getElementById('gachaModelStatus').textContent));
    return page.textContent('#gachaModelStatus');
  };

  // 準備: アプリを開き、Service Worker を動かす（アプリの画面はキャッシュに入る。モデルは、まだ取らない）
  await page.goto(`${BASE}/index.html`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  assert.equal(await page.evaluate(m => caches.match(m).then(r => !!r), MODEL), false, 'はじめから、モデルがキャッシュにある');

  await step('1. オフライン・モデルなし → 60 枚から。説明の 1 行なし・今日の形は残らない・設定は「まだ準備中です」', async () => {
    await context.setOffline(true);
    const r = await draw();
    assert.equal(r.note, null, `60 枚の形なのに、説明の 1 行が出た: ${r.note}`);
    assert.equal(r.today, null, '60 枚の形が、今日の形として残った');
    assert.ok(await page.isVisible('#gachaSave'), '60 枚の形でも、図鑑には入れられる');
    assert.equal(await settingsLine(), '今日のよつばのモデル：まだ準備中です');
    // 開き直すと、ひく前から（60 枚の形は残っていない）
    await page.goto(`${BASE}/gacha.html`);
    await page.waitForSelector('#gachaBefore:not([hidden])');
    await context.setOffline(false);
  });

  let mine;
  await step('2. オンライン・モデルなし → その場で取る（準備しています）→ DiT の形。残る。設定は「準備できています」', async () => {
    const r = await draw();
    assert.ok(r.stages.includes('準備しています'), `「準備しています」が出なかった: ${r.stages}`);
    assert.equal(r.note, DIT_NOTE);
    assert.equal(r.today?.kind, 'dit');
    assert.ok(modelAsked.length >= 1, 'モデルを取りにいっていない');
    assert.ok(modelAsked.every(u => u.startsWith(BASE)), `自分のサイト以外から、モデルを取った: ${modelAsked}`);
    assert.equal(await page.evaluate(m => caches.match(m).then(r => !!r), MODEL), true, '取ったモデルが、キャッシュに入っていない');
    assert.equal(await settingsLine(), '今日のよつばのモデル：準備できています');
    mine = r.today.mask;
  });

  await step('3. 同じ端末の同じ日は、同じ形（今日の形を消して、もう一度ひいても同じ）', async () => {
    await progress(page, 'delete', 'gachaToday');
    const r = await draw();
    assert.equal(r.note, DIT_NOTE);
    assert.ok(!r.stages.includes('準備しています'), 'モデルがあるのに、取りにいった');
    assert.equal(r.today.mask, mine, '同じ端末の同じ日なのに、形がちがう');
  });

  const device = await progress(page, 'get', 'gachaDevice');
  await step('4. 端末の値がちがえば、同じ日でも、ちがう形（4 つの値で、すべてちがう）', async () => {
    assert.equal(device?.value?.length, 4, '端末の値が残っていない');
    const masks = [mine];
    for (const value of [[1, 2, 3, 4], [5, 6, 7, 8], [4294967295, 0, 123456789, 987654321], [device.value[0] ^ 1, ...device.value.slice(1)]]) {
      await progress(page, 'put', 'gachaDevice', { value, at: Date.now() });
      await progress(page, 'delete', 'gachaToday');
      const r = await draw();
      assert.equal(r.note, DIT_NOTE);
      masks.push(r.today.mask);
    }
    assert.equal(new Set(masks).size, masks.length, '端末の値がちがうのに、同じ形があった');
    await progress(page, 'put', 'gachaDevice', device); // 元の値にもどす
  });

  await step('5. モデルを取ったあとは、オフラインでも DiT の形（同じ端末なので、同じ形）', async () => {
    await context.setOffline(true);
    await progress(page, 'delete', 'gachaToday');
    const r = await draw();
    assert.equal(r.note, DIT_NOTE);
    assert.equal(r.today.mask, mine);
    await context.setOffline(false);
  });

  await step('6. 「すべてのデータを消す」で、端末の値と今日の形が消える。次は新しい値', async () => {
    await page.goto(`${BASE}/settings.html`);
    await page.click('#wipeBtn');
    await page.click('#wipeSkip'); // 消す前の書き出しの案内は、飛ばす
    await page.click('#wipeBtn');
    await page.waitForSelector('#wipeMessage:not([hidden])');
    assert.equal(await progress(page, 'get', 'gachaDevice'), null, '端末の値が消えていない');
    assert.equal(await progress(page, 'get', 'gachaToday'), null, '今日の形が消えていない');
    assert.equal(await settingsLine(), '今日のよつばのモデル：準備できています', 'モデルの保存（キャッシュ）は、消さない');
    const r = await draw();
    const fresh = await progress(page, 'get', 'gachaDevice');
    assert.notDeepEqual(fresh.value, device.value, '消したあとも、端末の値が同じ');
    assert.notEqual(r.today.mask, mine, '消したあとも、同じ形');
  });

  assert.deepEqual(errors, [], `ページでエラーが出た: ${errors.join(' / ')}`);
  assert.deepEqual(outside, [], `自分のサイト以外への通信がありました:\n${outside.join('\n')}`);
  console.log('OK: モデルは、ひいたときにも自分のサイトから取る・60 枚の形は残さない・種は日付と端末ごとの値・外部への通信 0 件');
} finally {
  await browser.close();
  if (!process.env.E2E_BASE) server.close();
}
