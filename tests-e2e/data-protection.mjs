// データを守るしくみの確かめ（npm run test:e2e の 5 つ目）
//
//   npm run build && node tests-e2e/data-protection.mjs
//
// 確かめること
//   1. チュートリアルの最後のスライド: iPhone の Safari では「ホーム画面に追加」の手順。ほかのブラウザは Safari で開く案内。
//      案内の枠の内側に、余白をとって文字が入る（いくつかの画面の幅で。カードもはみ出さない）
//      ホーム画面から開いたとき（standalone）は出さない
//   2. チュートリアルのあと、記録が消えにくくするお願い（navigator.storage.persist）の結果を残す
//   3. 書き出し → すべてのデータを消す（書き出しの案内を飛ばす）→ 読み込み（上書き）で、図鑑・今日のよつばの一覧・日記・きろく・まちがいの記録・調整・設定が同じに戻る。
//      書き出しには、今日のよつばの端末ごとの値・今日の形・移す前の元の値が入らない。最後に書き出した日が出る
//      前の版（DB の版 4）の中身を入れて開くので、今日のよつばは、開いたときに今日のよつばの入れ物へ移る（書き出しは版 2）
//      「すべてのデータを消す」で、今日のよつばの一覧と、移す前の元の値も消える
//   4. こわれたファイル・新しすぎる版は、はっきりしたエラーで、何も変わらない
//   5. 足す: 同じ記録は足さない（何も変わらない）
//   6. 自分のサイト以外への通信は 0 件
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4191;
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

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';

// 図鑑などのデータを、IndexedDB に直接入れる（写真は小さな JPEG の data URL）
async function seed(page) {
  await page.evaluate(async () => {
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('yotsuba-hunter', 4); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); r.onupgradeneeded = () => {
      const d = r.result;
      const s = d.createObjectStore('records', { keyPath: 'id', autoIncrement: true }); s.createIndex('date', 'date');
      d.createObjectStore('feedback', { keyPath: 'key' }); d.createObjectStore('lastPhoto', { keyPath: 'id' }); d.createObjectStore('progress', { keyPath: 'id' });
    }; });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['records', 'feedback', 'progress'], 'readwrite');
      tx.objectStore('records').put({ id: 1, date: 1000, imageDataUrl: jpeg, label: '四つ葉', source: 'photo', counts: { three: 5, four: 1 }, note: 'こうえんで', detections: [{ label: '四つ葉', score: 0.9, bbox: { x: 0, y: 0, w: 1, h: 1 } }], ink: { lines: [], stickers: [] }, diaryTheme: 'green' });
      tx.objectStore('records').put({ id: 2, date: 2000, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', label: '四つ葉', source: 'gacha', gachaDay: '2026-10-29', gachaKind: 'dit' });
      tx.objectStore('feedback').put({ key: 'record:1', date: 1500, photo: new Uint8Array([255, 216, 255, 1, 2, 3]).buffer, width: 1, height: 1, detections: [], answers: [{ kind: 'not-four', index: 0, bbox: { x: 0, y: 0, w: 1, h: 1 } }] });
      tx.objectStore('progress').put({ id: 'me', leaves: 6, fours: 1, diaryCards: 1, xp: 136, badges: [{ id: 'first-four', date: 1 }], photoHashes: ['h1'], photoFourXp: { h1: 1 }, diaryRecordIds: [1], wroteNote: true, drewInk: false });
      tx.objectStore('progress').put({ id: 'tuning', enabled: false, choices: [{ score: 0.4, keep: false, at: 1 }], model: '/models/yotsuba-v5mix.onnx' });
      tx.objectStore('progress').put({ id: 'gachaDevice', value: [1, 2, 3, 4], at: 1 });
      tx.objectStore('progress').put({ id: 'gachaToday', day: '2026-10-29', w: 1, h: 1, data: 'AA' });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    localStorage.setItem('yotsuba-save-mode', 'auto');
  });
}

// 比べるための、今のデータ（まちがいの記録の写真はバイトの並びに）
const snapshot = page => page.evaluate(() => new Promise((resolve, reject) => {
  const r = indexedDB.open('yotsuba-hunter');
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction(['records', 'gacha', 'feedback', 'progress'], 'readonly');
    const out = {};
    tx.objectStore('records').getAll().onsuccess = e => { out.records = e.target.result; };
    tx.objectStore('gacha').getAll().onsuccess = e => { out.gacha = e.target.result; };
    tx.objectStore('progress').get('gachaMove').onsuccess = e => { out.moveKept = !!e.target.result; };
    tx.objectStore('feedback').getAll().onsuccess = e => { out.feedback = e.target.result.map(f => ({ ...f, photo: [...new Uint8Array(f.photo)] })); };
    tx.objectStore('progress').getAll().onsuccess = e => { out.progress = e.target.result.filter(p => p.id === 'me' || p.id === 'tuning'); };
    tx.oncomplete = () => { db.close(); resolve({ ...out, saveMode: localStorage.getItem('yotsuba-save-mode') }); };
    tx.onerror = () => reject(tx.error);
  };
}));
// 移す前の元の値の有無は、比べるときには外す（消したあとは無い・読み込みでは戻さない）
const stored = ({ moveKept: _m, ...rest }) => rest;

const browser = await chromium.launch();
const outside = [];
const step = async (name, fn) => { await fn(); console.log(`  ok: ${name}`); };
try {
  // ── 1・2. チュートリアル ──
  const lastSlideGuide = async (ua, initScript, viewport = { width: 390, height: 844 }) => {
    const context = await browser.newContext({ viewport, userAgent: ua, hasTouch: true });
    context.on('request', req => { const u = req.url(); if (!/^(data|blob):/.test(u) && !u.startsWith(BASE)) outside.push(u); });
    if (initScript) await context.addInitScript(initScript);
    const page = await context.newPage();
    await page.goto(`${BASE}/index.html#tutorial`);
    await page.waitForSelector('.tut');
    const guide = await page.evaluate(() => [...document.querySelectorAll('.tut-card')].pop().querySelector('[data-home-guide]')?.dataset.homeGuide ?? 'none');
    return { context, page, guide };
  };
  await step('チュートリアルの最後: iPhone の Safari は「ホーム画面に追加」の手順。ほかのブラウザは Safari で開く案内', async () => {
    const a = await lastSlideGuide(SAFARI);
    assert.equal(a.guide, 'ios-safari');
    assert.match(await a.page.textContent('[data-home-guide]'), /ホーム画面に追加/);
    // はじめる → 記録が消えにくくするお願いの結果が残る
    for (let i = 0; i < 3; i++) { await a.page.click('[data-next]'); await a.page.waitForTimeout(500); }
    await a.page.click('[data-next]');
    await a.page.waitForFunction(() => localStorage.getItem('yotsuba-persist') !== null, null, { timeout: 10_000 });
    const rec = await a.page.evaluate(() => JSON.parse(localStorage.getItem('yotsuba-persist')));
    assert.ok(['granted', 'denied', 'unsupported'].includes(rec.result), `結果: ${rec.result}`);
    console.log(`    （このブラウザの結果: ${rec.result}）`);
    await a.context.close();
    const b = await lastSlideGuide(CHROME_IOS);
    assert.equal(b.guide, 'ios-other');
    assert.match(await b.page.textContent('[data-home-guide]'), /Safari で 開いて/);
    await b.context.close();
  });
  await step('「ホーム画面に追加」の案内: 枠の内側に余白をとって文字が入る（iPhone の幅 390px・ほかの幅。カードもはみ出さない）', async () => {
    const sizes = [[390, 844], [375, 667], [320, 568], [430, 932], [768, 1024], [844, 390]];
    for (const [ua, name] of [[SAFARI, 'Safari'], [CHROME_IOS, 'ほかのブラウザ']]) {
      for (const [width, height] of sizes) {
        const g = await lastSlideGuide(ua, undefined, { width, height });
        await g.page.evaluate(() => { const t = document.querySelector('.tut-track'); t.scrollTo({ left: t.scrollWidth }); });
        await g.page.waitForTimeout(600);
        await g.page.evaluate(() => document.fonts.ready);
        const m = await g.page.evaluate(() => {
          const card = [...document.querySelectorAll('.tut-card')].pop();
          const box = card.querySelector('[data-home-guide]');
          const c = card.getBoundingClientRect(), b = box.getBoundingClientRect();
          // 文字の入っている部品（見出し・手順の 1 行ずつ・手順の番号）の、枠の内側からの距離
          const parts = [...box.querySelectorAll('p, li')].map(e => {
            const r = e.getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(e);
            const t = range.getBoundingClientRect();
            return { left: Math.min(r.left, t.left) - b.left, right: b.right - Math.max(r.right, t.right), top: r.top - b.top, bottom: b.bottom - r.bottom };
          });
          return {
            inCard: b.left >= c.left && b.right <= c.right && b.top >= c.top && b.bottom <= c.bottom + 0.5,
            clipped: card.scrollHeight - card.clientHeight,
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            minSide: Math.min(...parts.flatMap(p => [p.left, p.right])),
            minTopBottom: Math.min(parts[0].top, parts[parts.length - 1].bottom),
          };
        });
        const where = `${name} ${width}×${height}: ${JSON.stringify(m)}`;
        assert.ok(m.inCard, where);
        assert.ok(m.clipped <= 1, where);
        assert.ok(m.pageOverflow <= 0, where);
        assert.ok(m.minSide >= 12, where);   // 左右に 12px 以上の余白
        assert.ok(m.minTopBottom >= 4, where);
        if (ua === SAFARI && width === 390) await g.page.screenshot({ path: 'docs/screens/finish-tutorial-last.png' });
        await g.context.close();
      }
    }
  });
  await step('ホーム画面から開いたとき（standalone）は、案内を出さない', async () => {
    const c = await lastSlideGuide(SAFARI, () => Object.defineProperty(navigator, 'standalone', { value: true }));
    assert.equal(c.guide, 'none');
    await c.context.close();
    const d = await lastSlideGuide(SAFARI, () => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = q => (q === '(display-mode: standalone)' ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q));
    });
    assert.equal(d.guide, 'none');
    await d.context.close();
  });

  // ── 3〜5. 書き出しと読み込み ──
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  context.on('request', req => { const u = req.url(); if (!/^(data|blob):/.test(u) && !u.startsWith(BASE)) outside.push(u); });
  // 共有画面は使えないことにして、ダウンロードで受けとる
  await context.addInitScript(() => { Object.defineProperty(navigator, 'canShare', { value: undefined }); });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  await page.goto(`${BASE}/about.html`); // DB を開かない画面で、前の版（DB の版 4）の中身を入れる
  await page.evaluate(() => { localStorage.setItem('yotsuba-tutorial-seen', '1'); });
  await seed(page);
  await page.goto(`${BASE}/index.html`); // アプリの画面で開くと、版 5 へ上がり、今日のよつばが移る
  const before = await snapshot(page);
  assert.deepEqual([before.records.map(r => r.id), before.gacha.map(r => r.id), before.moveKept], [[1], [2], true], '今日のよつばが移っていない');
  const file = 'docs/screens/e2e-backup.json';

  await step('書き出す: 1 つの JSON。端末ごとの値・今日の形は入らない。最後に書き出した日が出る', async () => {
    await page.goto(`${BASE}/settings.html`);
    assert.equal(await page.textContent('#lastExport'), 'まだ 書き出していません');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backupExport')]);
    assert.match(download.suggestedFilename(), /^yotsuba-backup-\d{4}-\d{2}-\d{2}\.json$/);
    await download.saveAs(file);
    const text = await readFile(file, 'utf8');
    const data = JSON.parse(text);
    assert.equal(data.app, 'yotsuba-finder');
    assert.equal(data.schemaVersion, 2);
    assert.deepEqual([data.records.length, data.gacha.length], [1, 1]);
    assert.equal(data.gacha[0].source, 'gacha');
    for (const word of ['gachaDevice', 'gachaToday', 'gachaMove']) assert.ok(!text.includes(word), `${word} が入っている`);
    await page.waitForSelector('#backupMessage:not([hidden])');
    assert.match(await page.textContent('#lastExport'), /^最後に 書き出した日：\d+年\d+月\d+日/);
  });

  await step('すべてのデータを消す: 先に書き出しを案内する（飛ばせる）', async () => {
    await page.click('#wipeBtn');
    assert.equal(await page.isVisible('#wipeAsk'), true, '書き出しの案内が出ない');
    await page.click('#wipeSkip');
    await page.click('#wipeBtn');
    await page.waitForSelector('#wipeMessage:not([hidden])');
    const after = await snapshot(page);
    assert.deepEqual([after.records.length, after.gacha.length, after.feedback.length, after.progress.filter(p => p.id === 'me').length, after.moveKept], [0, 0, 0, 0, false]);
  });

  await step('読み込む（上書き）: 図鑑・日記・きろく・まちがいの記録・調整・設定が、同じに戻る', async () => {
    await page.evaluate(() => localStorage.setItem('yotsuba-save-mode', 'confirm'));
    await page.reload();
    await page.setInputFiles('#backupFile', file);
    await page.waitForSelector('#importChoice:not([hidden])');
    await page.click('[data-import="replace"]');
    assert.equal(await page.isVisible('#replaceWarn'), true, '上書きの前の案内が出ない');
    await page.click('#importGo');
    await page.waitForFunction(() => /読み込みました/.test(document.getElementById('backupMessage').textContent));
    assert.deepEqual(stored(await snapshot(page)), stored(before));
  });

  const unchanged = async (name, content, re) => {
    const now = await snapshot(page);
    await page.setInputFiles('#backupFile', { name, mimeType: 'application/json', buffer: Buffer.from(content) });
    await page.waitForFunction(r => new RegExp(r).test(document.getElementById('backupMessage').textContent), re.source);
    assert.equal(await page.isVisible('#importChoice'), false);
    assert.deepEqual(await snapshot(page), now, `${name}: データが変わった`);
  };
  await step('こわれたファイル・ちがうファイル・新しすぎる版: はっきりしたエラーで、何も変わらない', async () => {
    const good = JSON.parse(await readFile(file, 'utf8'));
    await unchanged('broken.json', '{"app":"yotsuba-finder","schemaVer', /こわれている/);
    await unchanged('other.json', JSON.stringify({ hello: 1 }), /このアプリで 書き出した/);
    await unchanged('new.json', JSON.stringify({ ...good, schemaVersion: 99 }), /新しい アプリ/);
    await unchanged('bad-record.json', JSON.stringify({ ...good, records: [{ ...good.records[0], source: 'x' }] }), /図鑑/);
  });

  await step('版 1 の書き出しファイル（前のアプリ）も読める: 今日のよつばは、今日のよつばの一覧に入る', async () => {
    const good = JSON.parse(await readFile(file, 'utf8'));
    const { gacha: g, ...v1 } = good;
    const old = { ...v1, schemaVersion: 1, records: [...good.records, ...g] };
    await page.setInputFiles('#backupFile', { name: 'v1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
    await page.waitForSelector('#importChoice:not([hidden])');
    await page.click('[data-import="replace"]');
    await page.click('#importGo');
    await page.waitForFunction(() => /読み込みました/.test(document.getElementById('backupMessage').textContent));
    const now = await snapshot(page);
    assert.deepEqual(stored(now), stored(before));
  });

  await step('読み込む（足す）: 同じ記録は足さない', async () => {
    const now = await snapshot(page);
    await page.setInputFiles('#backupFile', file);
    await page.waitForSelector('#importChoice:not([hidden])');
    await page.click('#importGo');
    await page.waitForFunction(() => /読み込みました/.test(document.getElementById('backupMessage').textContent));
    assert.match(await page.textContent('#backupMessage'), /0件 足しました。同じ 記録 2件は 足していません/); // 図鑑 1 件と今日のよつば 1 件
    assert.deepEqual(await snapshot(page), now);
  });

  await step('記録が消えることがあるブラウザ（お願いが断られた）では、書き出しの案内を出す', async () => {
    assert.equal(await page.isVisible('#persistHint'), false);
    await page.evaluate(() => localStorage.setItem('yotsuba-persist', JSON.stringify({ result: 'denied', at: 1 })));
    await page.reload();
    assert.equal(await page.isVisible('#persistHint'), true);
  });

  await step('写真なしで書き出す → 消す → 読み込む: 記録とひとことは戻り、写真の代わりの絵が入る（今日のよつばの絵は戻る）', async () => {
    await page.click('[data-photos="off"]');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backupExport')]);
    const small = 'docs/screens/e2e-backup-nophoto.json';
    await download.saveAs(small);
    const data = JSON.parse(await readFile(small, 'utf8'));
    assert.equal(data.withPhotos, false);
    assert.deepEqual(data.feedback, []);
    await page.click('#wipeBtn');
    await page.click('#wipeSkip');
    await page.click('#wipeBtn');
    await page.waitForSelector('#wipeMessage:not([hidden])');
    await page.setInputFiles('#backupFile', small);
    await page.waitForSelector('#importChoice:not([hidden])');
    assert.match(await page.textContent('#importSummary'), /写真なし/);
    await page.click('#importGo');
    await page.waitForFunction(() => /読み込みました/.test(document.getElementById('backupMessage').textContent));
    const after = await snapshot(page);
    const photo = after.records.find(r => r.source === 'photo');
    const gacha = after.gacha.find(r => r.source === 'gacha');
    assert.equal(after.records.some(r => r.source === 'gacha'), false, '今日のよつばが図鑑の入れ物に入った');
    assert.equal(photo.note, 'こうえんで');
    assert.equal(photo.photoMissing, true);
    assert.match(photo.imageDataUrl, /^data:image\/png;base64,/);
    assert.equal(gacha.imageDataUrl, before.gacha[0].imageDataUrl);
    // 詳細の画面: 写真が入っていなかったことを出す
    await page.goto(`${BASE}/detail.html?id=${photo.id}`);
    await page.waitForSelector('#detailNoPhoto:not([hidden])');
  });
  await step('このアプリについて: 設定から開ける。ソースコードのリンク（公開したリポジトリ）とイラストの出どころが出る。ライセンスの全文・部品の一覧が、自分のサイトから出る', async () => {
    await page.goto(`${BASE}/settings.html`);
    await page.click('a[href="about.html"]');
    await page.waitForSelector('#partsList li');
    // ソースコードのリンク（押さない。外のサイトなので、通信の数に入れないため）
    assert.equal(await page.isVisible('#sourceLink'), true);
    assert.equal(await page.getAttribute('#sourceLink', 'href'), 'https://github.com/yt1092/yotsuba-finder-app');
    assert.equal(await page.isVisible('#sourceWait'), false);
    assert.equal(await page.isVisible('text=イラスト：ChatGPT（OpenAI）で生成'), true);
    assert.ok(await page.locator('#partsList li').count() >= 5);
    assert.match(await page.textContent('#partsList'), /onnxruntime-web 1\.30\.0（MIT）/);
    await page.click('details[data-src="/about/LICENSE.txt"] summary');
    await page.waitForFunction(() => /GNU AFFERO GENERAL PUBLIC LICENSE/.test(document.querySelector('details[data-src="/about/LICENSE.txt"] pre').textContent));
    await page.click('details[data-src="/about/CREDITS.md"] summary');
    await page.waitForFunction(() => /CREDITS/.test(document.querySelector('details[data-src="/about/CREDITS.md"] pre').textContent));
  });
  await context.close();

  assert.deepEqual(outside, [], '自分のサイト以外への通信');
  console.log('OK: ホーム画面の案内・消えにくくするお願いの記録・書き出しと読み込み（上書き・足す・こわれたファイル）・外部への通信 0 件');
} finally {
  await browser.close();
  server.close();
}
