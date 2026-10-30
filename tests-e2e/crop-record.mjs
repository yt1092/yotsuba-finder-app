// 図鑑に入れる写真の切り抜きの確かめ（npm run test:e2e の 6 つ目）
//
//   npm run build && node tests-e2e/crop-record.mjs
//
// 確かめること
//   1. 写真から探す（確認してから入れる・自動で入れる）: 図鑑の写真は、四つ葉の枠のまわりで切り抜かれる（正方形に近い・元より小さい）。
//      記録の枠の座標は、切り抜いた写真の中に入っている。結果の画面には、写真の全体を出す
//   2. カメラ: 図鑑の写真は、四つ葉の枠のまわりで切り抜かれる（偽のカメラに、四つ葉の絵を映す）
//   3. 前から図鑑に入っている全体の写真は、書きかえない
//   4. 図鑑の一覧・詳細で、切り抜いた写真が崩れずに出る
//   5. 自分のサイト以外への通信は 0 件
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4194;
const BASE = `http://localhost:${PORT}`;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.webp': 'image/webp',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.md': 'text/markdown',
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

const PHOTO = 'public/images/tutorial-2.webp'; // 四つ葉が 1 つ見つかる絵（リポジトリに入っている）
const Y4M = resolve('docs/screens/e2e-camera-four.y4m'); // 偽のカメラの映像（この絵。Git には入れない）
const OLD_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const outside = [];
const step = async (name, fn) => { await fn(); console.log(`  ok: ${name}`); };

const records = page => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('yotsuba-hunter');
  r.onsuccess = () => { const q = r.result.transaction('records').objectStore('records').getAll(); q.onsuccess = () => { r.result.close(); res(q.result); }; q.onerror = () => rej(q.error); };
}));
const imageSize = (page, url) => page.evaluate(u => new Promise(res => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.src = u; }), url);
// 前からある記録（全体の写真）を 1 つ入れる
const seedOld = page => page.evaluate(url => new Promise((res, rej) => {
  const r = indexedDB.open('yotsuba-hunter', 4);
  r.onupgradeneeded = () => {
    const d = r.result;
    const s = d.createObjectStore('records', { keyPath: 'id', autoIncrement: true }); s.createIndex('date', 'date');
    d.createObjectStore('feedback', { keyPath: 'key' }); d.createObjectStore('lastPhoto', { keyPath: 'id' }); d.createObjectStore('progress', { keyPath: 'id' });
  };
  r.onsuccess = () => { const tx = r.result.transaction('records', 'readwrite'); tx.objectStore('records').put({ id: 1, date: 1, imageDataUrl: url, label: '四つ葉', source: 'camera' }); tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
}), OLD_URL);

// 切り抜いた記録の確かめ（写真の大きさ = 切り抜きの大きさ・正方形に近い・枠が写真の中）
async function checkCropped(page, rec, full) {
  assert.ok(rec.crop, '切り抜いた範囲が記録に無い');
  const [w, h] = await imageSize(page, rec.imageDataUrl);
  assert.deepEqual([w, h], [rec.crop.w, rec.crop.h], '写真の大きさが切り抜きとちがう');
  assert.deepEqual([rec.crop.srcW, rec.crop.srcH], full, '元の写真の大きさがちがう');
  assert.ok(w * h < full[0] * full[1], '切り抜かれていない（全体のまま）');
  assert.ok(Math.max(w, h) / Math.min(w, h) <= 1.5, `正方形に近くない: ${w}×${h}`);
  for (const d of rec.detections ?? []) {
    const b = d.bbox;
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= w + 0.01 && b.y + b.h <= h + 0.01, `枠が写真の外: ${JSON.stringify(b)}`);
  }
  return [w, h];
}

// 偽のカメラの映像（y4m）: 絵の、写真から探すで四つ葉が見つかったあたり（region）を、1280×720 いっぱいに映し、YUV 4:2:0 の 1 コマにする
// （絵の全体だと、カメラの処理では四つ葉が小さすぎて見つからないため）
async function makeY4m(browser, region) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/index.html`);
  const frame = await page.evaluate(async ([src, region]) => {
    const img = new Image(); img.src = src; await img.decode();
    const W = 1280, H = 720;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.fillStyle = '#5a8a3a'; g.fillRect(0, 0, W, H);
    const s = Math.min(W / region.w, H / region.h); // region の全体が入る大きさ
    g.drawImage(img, region.x, region.y, region.w, region.h, (W - region.w * s) / 2, (H - region.h * s) / 2, region.w * s, region.h * s);
    const d = g.getImageData(0, 0, W, H).data;
    const Y = new Uint8Array(W * H), U = new Uint8Array(W * H / 4), V = new Uint8Array(W * H / 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
      Y[y * W + x] = Math.round(0.257 * r + 0.504 * gg + 0.098 * b + 16);
      if (y % 2 === 0 && x % 2 === 0) {
        const j = (y / 2) * (W / 2) + x / 2;
        U[j] = Math.round(-0.148 * r - 0.291 * gg + 0.439 * b + 128);
        V[j] = Math.round(0.439 * r - 0.368 * gg - 0.071 * b + 128);
      }
    }
    return [...Y, ...U, ...V];
  }, ['/images/tutorial-2.webp', region]);
  await page.close();
  await writeFile(Y4M, Buffer.concat([Buffer.from('YUV4MPEG2 W1280 H720 F30:1 Ip A1:1 C420jpeg\nFRAME\n'), Buffer.from(frame)]));
}

let browser = await chromium.launch();
let region;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  context.on('request', req => { const u = req.url(); if (!/^(data|blob):/.test(u) && !u.startsWith(BASE)) outside.push(u); });
  const page = await context.newPage();
  await page.goto(`${BASE}/about.html`); // DB を開かない画面で、前の版（DB の版 4）の記録を入れる（アプリの画面を開くと、版 5 へ上がる）
  await page.evaluate(() => localStorage.setItem('yotsuba-tutorial-seen', '1'));
  await seedOld(page);
  const full = await (async () => { const p = await context.newPage(); await p.goto(`${BASE}/index.html`); const s = await imageSize(p, '/images/tutorial-2.webp'); await p.close(); return s; })();

  await step('写真から探す（確認してから入れる）: 図鑑の写真は、四つ葉のまわりで切り抜く。結果の画面は写真の全体', async () => {
    await page.goto(`${BASE}/photo-pick.html`);
    await page.setInputFiles('#fileInput', PHOTO);
    await page.waitForURL(/photo-found\.html/, { timeout: 120_000 });
    await page.waitForSelector('.confirm', { timeout: 30_000 });
    await page.click('.confirm [data-keep]:not([disabled])');
    await page.waitForSelector('.confirm', { state: 'detached', timeout: 60_000 });
    assert.deepEqual(await page.evaluate(() => { const i = document.getElementById('foundImg'); return [i.naturalWidth, i.naturalHeight]; }), full, '結果の画面の写真が全体ではない');
    const rec = (await records(page)).find(r => r.source === 'photo');
    const [w, h] = await checkCropped(page, rec, full);
    assert.ok(rec.detections.some(d => d.label === '四つ葉'), '四つ葉の枠が無い');
    region = rec.crop;
    console.log(`    （写真 ${full.join('×')} → 図鑑 ${w}×${h}）`);
  });

  await step('写真から探す（自動で入れる）: 同じく切り抜く', async () => {
    await page.evaluate(() => localStorage.setItem('yotsuba-save-mode', 'auto'));
    const before = (await records(page)).length;
    await page.goto(`${BASE}/photo-pick.html`);
    await page.setInputFiles('#fileInput', PHOTO);
    await page.waitForURL(/photo-found\.html/, { timeout: 120_000 });
    const all = await records(page);
    assert.equal(all.length, before + 1);
    await checkCropped(page, all.sort((a, b) => b.id - a.id)[0], full);
    await page.evaluate(() => localStorage.setItem('yotsuba-save-mode', 'confirm'));
  });

  await step('前から図鑑に入っている全体の写真は、書きかえない', async () => {
    const old = (await records(page)).find(r => r.id === 1);
    assert.equal(old.imageDataUrl, OLD_URL);
    assert.equal(old.crop, undefined);
  });

  await step('図鑑の一覧と詳細: 切り抜いた写真が、枠いっぱいに崩れずに出る', async () => {
    await page.goto(`${BASE}/collection.html`);
    await page.waitForSelector('.record-card img');
    const cards = await page.$$eval('.record-card img', imgs => imgs.map(i => ({ ok: i.complete && i.naturalWidth > 0, w: i.clientWidth, h: i.clientHeight })));
    assert.ok(cards.every(c => c.ok && c.w > 100 && c.h > 100), JSON.stringify(cards));
    const rec = (await records(page)).filter(r => r.crop).sort((a, b) => b.id - a.id)[0];
    await page.goto(`${BASE}/detail.html?id=${rec.id}`);
    await page.waitForFunction(() => { const i = document.getElementById('detailImg'); return i.complete && i.naturalWidth > 0; });
    await page.screenshot({ path: 'docs/screens/crop-detail.png' });
    await page.goto(`${BASE}/collection.html`);
    await page.waitForSelector('.record-card img');
    await page.screenshot({ path: 'docs/screens/crop-collection.png' });
  });
  await context.close();

  await step('カメラ: 図鑑の写真は、四つ葉のまわりで切り抜く（偽のカメラに四つ葉の絵を映す）', async () => {
    await makeY4m(browser, region);
    const cb = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${Y4M}`] });
    const cc = await cb.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
    cc.on('request', req => { const u = req.url(); if (!/^(data|blob):/.test(u) && !u.startsWith(BASE)) outside.push(u); });
    const page = await cc.newPage();
    await page.goto(`${BASE}/index.html`);
    await page.evaluate(() => localStorage.setItem('yotsuba-tutorial-seen', '1'));
    const before = 0;
    await page.goto(`${BASE}/scan.html`);
    await page.waitForSelector('.confirm', { timeout: 120_000 });
    await page.click('.confirm [data-keep]:not([disabled])');
    await page.waitForFunction(n => new Promise(res => {
      const r = indexedDB.open('yotsuba-hunter');
      r.onsuccess = () => { const q = r.result.transaction('records').objectStore('records').count(); q.onsuccess = () => { r.result.close(); res(q.result > n); }; };
    }), before, { timeout: 30_000, polling: 500 });
    const rec = (await records(page)).filter(r => r.source === 'camera').sort((a, b) => b.id - a.id)[0];
    const [w, h] = await checkCropped(page, rec, [1280, 720]);
    console.log(`    （カメラ 1280×720 → 図鑑 ${w}×${h}）`);
    await cb.close();
  });

  assert.deepEqual(outside, [], '自分のサイト以外への通信');
  console.log('OK: 図鑑の写真は、カメラでも写真から探すでも、四つ葉のまわりで切り抜く・前の記録は書きかえない・外部への通信 0 件');
} finally {
  await browser.close();
  server.close();
}
