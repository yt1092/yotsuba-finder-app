// 今日のよつばの一覧を、図鑑と分ける（npm run test:e2e の 7 つ目）
//
//   npm run build && node tests-e2e/gacha-list.mjs
//
// 確かめること
//   1. 前の版（DB の版 4）で図鑑に入っていた今日のよつばが、開いたときに今日のよつばの入れ物へ移る
//      移す前の元の値が残る。前から図鑑にある写真の記録は、書きかわらない
//   2. 図鑑の「すべて」「四つ葉」には、今日のよつばが混ざらない
//   3. 図鑑の「今日のよつば」: 1 行に、日付と、形（64×64。前の版の記録は、開いたときに作って残す）
//      文字は 16px 以上、押せる行は 48px 以上。画面の横にはみ出さない（320px・390px）
//   4. 今日のよつばの詳細: 戻る・消したあとは、今日のよつばの一覧へ。日記カードの記録（ひとこと）はそのまま
//   5. 自分のサイト以外への通信は 0 件
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4176;
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
    if ((await stat(file)).isDirectory()) throw new Error('フォルダ');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    if (!res.headersSent) { res.writeHead(404); res.end(); }
  }
});
await new Promise(r => server.listen(PORT, r));

// 前の版（DB の版 4）の中身: 写真 2 件（四つ葉・三つ葉）と、今日のよつば 2 件（絵は 512×512 の PNG）
async function seedV4(page) {
  await page.evaluate(async () => {
    const art = color => { const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d'); g.fillStyle = '#F4EBD0'; g.fillRect(0, 0, 512, 512); g.fillStyle = color; g.beginPath(); g.arc(256, 256, 160, 0, Math.PI * 2); g.fill(); return c.toDataURL('image/png'); };
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('yotsuba-hunter', 4); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('records', { keyPath: 'id', autoIncrement: true }).createIndex('date', 'date');
      d.createObjectStore('feedback', { keyPath: 'key' }); d.createObjectStore('lastPhoto', { keyPath: 'id' }); d.createObjectStore('progress', { keyPath: 'id' });
    }; });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['records', 'progress'], 'readwrite');
      const s = tx.objectStore('records');
      s.put({ id: 1, date: Date.UTC(2026, 9, 20), imageDataUrl: jpeg, label: '四つ葉', source: 'photo', counts: { three: 3, four: 1 }, note: 'こうえん' });
      s.put({ id: 2, date: Date.UTC(2026, 9, 27, 3), imageDataUrl: art('#4E9A50'), label: '四つ葉', source: 'gacha', gachaDay: '2026-10-27', gachaKind: 'preset' });
      s.put({ id: 3, date: Date.UTC(2026, 9, 21), imageDataUrl: jpeg, label: '三つ葉', source: 'camera' });
      s.put({ id: 4, date: Date.UTC(2026, 9, 29, 3), imageDataUrl: art('#2F7A3A'), label: '四つ葉', source: 'gacha', gachaDay: '2026-10-29', gachaKind: 'dit', note: 'きょうの かたち' });
      tx.objectStore('progress').put({ id: 'me', leaves: 4, fours: 1, diaryCards: 1, xp: 136, badges: [], photoHashes: [], photoFourXp: {}, diaryRecordIds: [4], wroteNote: true, drewInk: false });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    localStorage.setItem('yotsuba-tutorial-seen', '1');
  });
}

const readDb = page => page.evaluate(() => new Promise((resolve, reject) => {
  const r = indexedDB.open('yotsuba-hunter');
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction(['records', 'gacha', 'progress'], 'readonly');
    const out = { version: db.version };
    tx.objectStore('records').getAll().onsuccess = e => { out.records = e.target.result; };
    tx.objectStore('gacha').getAll().onsuccess = e => { out.gacha = e.target.result; };
    tx.objectStore('progress').get('gachaMove').onsuccess = e => { out.move = e.target.result; };
    tx.oncomplete = () => { db.close(); resolve(out); };
  };
}));

const browser = await chromium.launch();
const outside = [];
const step = async (name, fn) => { await fn(); console.log(`  ok: ${name}`); };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.on('request', req => { const u = req.url(); if (!/^(data|blob):/.test(u) && !u.startsWith(BASE)) outside.push(u); });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  await page.goto(`${BASE}/about.html`); // DB を開かない画面で、前の版の中身を入れる
  await seedV4(page);
  const before = await page.evaluate(() => new Promise(resolve => {
    const r = indexedDB.open('yotsuba-hunter');
    r.onsuccess = () => { const q = r.result.transaction('records').objectStore('records').getAll(); q.onsuccess = () => { r.result.close(); resolve(q.result); }; };
  }));

  await step('前の版の今日のよつばが、今日のよつばの入れ物へ移る（元の値が残る・写真の記録は書きかわらない）', async () => {
    await page.goto(`${BASE}/collection.html`);
    await page.waitForSelector('.record-card');
    const db = await readDb(page);
    assert.equal(db.version, 5);
    assert.deepEqual(db.records.map(r => r.id), [1, 3]);
    assert.deepEqual(db.records, before.filter(r => r.source !== 'gacha')); // 写真の記録は、まったく同じ
    assert.deepEqual(db.gacha.map(g => g.id).sort(), [2, 4]);
    for (const g of db.gacha) {
      const { shape64, ...rest } = g; // 一覧で作る 64×64 の形のほかは、元の値と同じ
      assert.deepEqual(rest, before.find(r => r.id === g.id));
    }
    assert.deepEqual(db.move.records, before.filter(r => r.source === 'gacha'));
    assert.deepEqual([db.move.moved.sort(), db.move.failed, db.move.done], [[2, 4], [], true]);
    console.log(`    （移した: ${db.move.moved.length} 件・移せなかった: ${db.move.failed.length} 件）`);
  });

  await step('図鑑の「すべて」「四つ葉」には、今日のよつばが混ざらない', async () => {
    const all = await page.$$eval('.record-card', els => els.map(e => e.getAttribute('href')));
    assert.deepEqual(all.sort(), ['detail.html?id=1', 'detail.html?id=3']);
    await page.click('.tab-btn[data-filter="四つ葉"]');
    assert.deepEqual(await page.$$eval('.record-card', els => els.map(e => e.getAttribute('href'))), ['detail.html?id=1']);
    assert.equal(await page.locator('[data-gacha-list]').count(), 0);
    await page.screenshot({ path: 'docs/screens/finish-collection-four.png', fullPage: true });
  });

  await step('図鑑の「今日のよつば」: 日付と 64×64 の形。前の版の記録の形は、開いたときに作って残す。文字 16px 以上・押せる行 48px 以上', async () => {
    await page.click('.tab-btn[data-filter="gacha"]');
    await page.waitForSelector('[data-gacha-list] .gacha-row');
    assert.match(page.url(), /\?tab=gacha$/);
    await page.waitForFunction(() => document.querySelectorAll('[data-gacha-list] img[data-need-shape]').length === 0);
    const rows = await page.$$eval('.gacha-row', els => els.map(a => {
      const img = a.querySelector('img'), date = a.querySelector('.gacha-row-date');
      const r = a.getBoundingClientRect(), i = img.getBoundingClientRect();
      return { href: a.getAttribute('href'), label: a.getAttribute('aria-label'), date: date.textContent, font: parseFloat(getComputedStyle(date).fontSize), h: r.height, img: [i.width, i.height, img.naturalWidth, img.naturalHeight], src: img.src.slice(0, 22) };
    }));
    assert.deepEqual(rows.map(r => [r.href, r.date]), [['detail.html?id=4', '2026年10月29日'], ['detail.html?id=2', '2026年10月27日']]);
    for (const r of rows) {
      assert.deepEqual(r.img, [64, 64, 64, 64], JSON.stringify(r));
      assert.equal(r.src, 'data:image/png;base64,');
      assert.ok(r.font >= 16 && r.h >= 48, JSON.stringify(r));
      assert.match(r.label, /の今日のよつば$/);
      assert.doesNotMatch(r.date, /%/);
    }
    const db = await readDb(page);
    assert.ok(db.gacha.every(g => /^data:image\/png/.test(g.shape64)), '形が残っていない');
    const tabs = await page.$$eval('.tab-btn', els => els.map(e => { const r = e.getBoundingClientRect(); return { h: r.height, f: parseFloat(getComputedStyle(e).fontSize), fits: e.scrollWidth <= e.clientWidth }; }));
    for (const t of tabs) assert.ok(t.h >= 48 && t.f >= 16 && t.fits, JSON.stringify(tabs));
    await page.screenshot({ path: 'docs/screens/finish-gacha-list.png', fullPage: true });
  });

  await step('狭い画面（320px）でも、切り替えと一覧が横にはみ出さない', async () => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.reload();
    await page.waitForSelector('.gacha-row');
    const m = await page.evaluate(() => ({
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tabs: [...document.querySelectorAll('.tab-btn')].map(e => [e.scrollWidth <= e.clientWidth, parseFloat(getComputedStyle(e).fontSize), e.getBoundingClientRect().height]),
    }));
    assert.ok(m.over <= 0, JSON.stringify(m));
    for (const [fits, f, h] of m.tabs) assert.ok(fits && f >= 16 && h >= 48, JSON.stringify(m));
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step('今日のよつばの詳細: ひとことはそのまま。戻る・消したあとは、今日のよつばの一覧へ', async () => {
    await page.click('a[href="detail.html?id=4"]');
    await page.waitForURL(/detail\.html\?id=4/);
    await page.waitForSelector('#detailGacha:not([hidden])');
    assert.equal(await page.textContent('#noteText'), 'きょうの かたち');
    assert.equal(await page.getAttribute('a[aria-label="戻る"]', 'href'), 'collection.html?tab=gacha');
    await page.click('#deleteBtn');
    await page.waitForURL(/collection\.html\?tab=gacha/);
    await page.waitForSelector('.gacha-row');
    assert.deepEqual(await page.$$eval('.gacha-row', els => els.map(e => e.getAttribute('href'))), ['detail.html?id=2']);
    const db = await readDb(page);
    assert.deepEqual(db.gacha.map(g => g.id), [2]);
    assert.deepEqual(db.records.map(r => r.id), [1, 3]); // 写真の記録は消えない
    assert.ok(db.move.records.some(r => r.id === 4)); // 移す前の元の値は残っている
  });

  await context.close();
  assert.deepEqual(outside, [], '自分のサイト以外への通信');
  console.log('OK: 今日のよつばの移し替え・図鑑に混ぜない・今日のよつばの一覧（日付と 64×64 の形）・外部への通信 0 件');
} finally {
  await browser.close();
  server.close();
}
