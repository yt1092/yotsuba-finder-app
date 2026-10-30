// 「外部通信なし」と「オフラインで動く」ことの確かめ（本番のビルドを、ブラウザで一連の操作をして確かめる）
//
//   npm run build && npm run test:e2e
//
// 1. 本番のビルド（dist/）を、このテストの中の小さなサーバー（http://localhost）で配り、Playwright の Chromium で開く（偽のカメラ）
//    （vite preview の自己署名の https では、Chromium が Service Worker を登録しないため。localhost は http でも安全な場所として扱われる）
// 2. 起動 → スタート → チュートリアル（4 枚）→ 写真から探す → 確認のポップアップ → 図鑑 → 日記カード → 今日のよつば → 設定 → カメラ
//    のあいだの通信を、ページと Service Worker の分も含めて、すべて記録する
// 3. 自分のサイト（http://localhost:<ポート>）以外への通信が 1 つでもあれば、失敗にする（CDN・外部のフォント・解析など）
// 4. 通信を切って（機内モードと同じ）、もう一度開き、ホーム・写真から探す（モデルの読み込みと検出）・図鑑が動くことを確かめる
//    （Service Worker のキャッシュから動く）
// 写真は、リポジトリに入っている絵（public/images/tutorial-2.webp）を使う（data/ は Git に入らないため）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 4179;
// E2E_BASE に URL を入れると、そのサイト（本番など）に向けて確かめる（小さなサーバーは立てない）
//   例: E2E_BASE=https://yotsuba-finder.vercel.app node tests-e2e/network-offline.mjs
const BASE = (process.env.E2E_BASE ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const PHOTO = 'public/images/tutorial-2.webp';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.webp': 'image/webp',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

// dist/ を配るだけの小さなサーバー（本番と同じファイル）
const server = createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, BASE).pathname)).replace(/^([/\\])+/, '');
    if (!path || path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
    const file = join('dist', path);
    if (!file.startsWith('dist')) throw new Error('外');
    await stat(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
if (!process.env.E2E_BASE) await new Promise(r => server.listen(PORT, r));
const stop = () => { if (!process.env.E2E_BASE) server.close(); };

// 今日のよつば: モデルが、モデル用キャッシュに入ったか・DiT の形のときの説明の 1 行・端末に残った今日の形
// 今日のよつばのモデルが、モデル用キャッシュに入るまで待つ（waitForFunction は、Promise を返す関数を待たないので、ここで調べ直す）
const waitGachaCached = async (page, timeout = 120_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(500)) {
    if (await page.evaluate(m => caches.match(m).then(r => !!r), '/models/gacha-pretrain-fp32.onnx')) return;
  }
  throw new Error('今日のよつばのモデルが、キャッシュに入らない');
};
const GACHA_DIT_NOTE = 'この端末の中で、小さなモデル（DiT）が作った形です';
const readGachaToday = page => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('yotsuba-hunter');
  open.onsuccess = () => {
    const req = open.result.transaction('progress', 'readonly').objectStore('progress').get('gachaToday');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  };
  open.onerror = () => reject(open.error);
}));

const outside = [];
const all = new Set();
const record = url => {
  if (url.startsWith('data:') || url.startsWith('blob:')) return;
  all.add(new URL(url).origin);
  if (!url.startsWith(BASE)) outside.push(url);
};

try {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, permissions: ['camera'], serviceWorkers: 'allow' });
  context.on('request', req => record(req.url()));
  context.on('serviceworker', sw => sw.on?.('request', req => record(req.url())));
  const page = await context.newPage();
  const step = async (name, fn) => { await fn(); console.log(`  ok: ${name}`); };

  await step('起動・スタート・チュートリアル（4 枚）', async () => {
    await page.goto(`${BASE}/index.html`);
    await page.click('#startBtn');
    await page.waitForSelector('.tut');
    // 「つぎへ」は、なめらかに動くので、1 枚ずつ待ちながら押す（最後は「はじめる」）
    for (let i = 0; i < 8 && await page.$('.tut'); i++) {
      await page.click('[data-next]');
      await page.waitForTimeout(800);
    }
    await page.waitForSelector('.tut', { state: 'detached' });
  });
  await step('写真から探す・確認のポップアップ', async () => {
    await page.goto(`${BASE}/photo-pick.html`);
    await page.setInputFiles('#fileInput', PHOTO);
    await page.waitForURL(/photo-(found|none)\.html/, { timeout: 120_000 });
    // 確認のポップアップ（候補があるときだけ）。最後の 1 つを決めると、ボタンを全部押せなくして保存し、保存が終わってから閉じる
    // （src/components/four-confirm.ts の finish）。押せないボタンを押しにいくと、押せるようになるのを待ち続けて時間切れになるので、
    // 押せるボタンだけを押し、そのあとは、ポップアップが閉じるのを待つ
    if (/photo-found/.test(page.url()) && await page.waitForSelector('.confirm', { timeout: 5000 }).catch(() => null)) {
      let kept = 0;
      for (; kept < 20; kept++) {
        const keep = await page.$('.confirm [data-keep]:not([disabled])');
        if (!keep) break;
        await keep.click();
      }
      await page.waitForSelector('.confirm', { state: 'detached', timeout: 60_000 });
      console.log(`    （確認のポップアップで ${kept} 個を図鑑に入れた）`);
    }
    await page.waitForTimeout(1500);
  });
  await step('図鑑・日記カード', async () => {
    await page.goto(`${BASE}/collection.html`);
    // 記録がなければ、1 つ作る（日記カードを開くため）
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('yotsuba-hunter');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('records', 'readwrite'); // src/lib/db.ts の STORE
        const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').fillRect(0, 0, 64, 64);
        tx.objectStore('records').add({ date: Date.now(), imageDataUrl: c.toDataURL('image/jpeg'), label: '四つ葉', source: 'photo', counts: { three: 3, four: 1 } });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    }));
    await page.reload();
    await page.click('.record-card');
    await page.waitForURL(/detail\.html/);
    await page.click('#diaryBtn');
    await page.waitForSelector('[data-preview][src]', { timeout: 30_000 });
  });
  // 「今日のよつば」: 検出のモデルを取ったあと、Service Worker が背景で、今日のよつばのモデルを入れる → DiT の形が出る
  //   ひく前 → つくっている間 → 結果（3 つの見た目）→ 確認のポップアップのあとで図鑑に入る・同じ日は同じ形・押せる大きさ
  let gachaMask = '';
  await step('今日のよつば（DiT）', async () => {
    // ホームを開くと、検出のモデルがあるので、背景で今日のよつばのモデルを入れる（scan.html では入れない。tests-e2e/scan-crash.mjs）
    await page.goto(`${BASE}/index.html#home`);
    await waitGachaCached(page);
    await page.click('a[href="gacha.html"]');
    await page.waitForURL(/gacha\.html/);
    await page.waitForSelector('#gachaBefore:not([hidden])');
    await page.click('#gachaDraw');
    await page.waitForSelector('#gachaMaking:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('.gacha-step.is-on').length === 4, null, { timeout: 30_000 });
    await page.waitForSelector('#gachaResult:not([hidden])', { timeout: 30_000 });
    assert.equal(await page.textContent('#gachaNote'), GACHA_DIT_NOTE);
    assert.match(await page.getAttribute('#gachaArt', 'aria-label'), /小さなモデルが作った四つ葉の形/);
    const text = await page.textContent('body');
    assert.ok(!/\d+\s*%|本物/.test(text), `画面に、数字のパーセントか「本物」の文字がある: ${text}`);
    for (const st of ['press', 'pixel', 'cut']) {
      await page.click(`[data-style=${st}]`);
      assert.equal(await page.getAttribute(`[data-style=${st}]`, 'aria-pressed'), 'true');
    }
    const sizes = await page.$$eval('#gachaSave, .gacha-style', els => els.map(el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, f: parseFloat(getComputedStyle(el).fontSize) }; }));
    for (const b of sizes) assert.ok(b.w >= 48 && b.h >= 48 && b.f >= 16, `ボタンが小さい: ${JSON.stringify(b)}`);
    const chipGap = await page.$$eval('.gacha-style', els => els[1].getBoundingClientRect().left - els[0].getBoundingClientRect().right);
    assert.ok(chipGap >= 8, `見た目のボタンの間が 8px より狭い: ${chipGap}`);
    assert.ok(await page.$eval('#gachaNote', el => parseFloat(getComputedStyle(el).fontSize)) >= 16, '説明の文字が 16px より小さい');
    const today = await readGachaToday(page);
    assert.ok(today?.mask, '今日の形が、端末に残っていない');
    assert.equal(today.kind, 'dit');
    gachaMask = today.mask;
    await page.click('#gachaSave');
    await page.waitForSelector('.confirm [data-keep]');
    const gap = await page.$$eval('.confirm-choice button', els => els[1].getBoundingClientRect().top - els[0].getBoundingClientRect().bottom);
    assert.ok(gap >= 8, `確認のポップアップのボタンの間が 8px より狭い: ${gap}`);
    await page.click('.confirm [data-keep]');
    await page.waitForSelector('#gachaSaved:not([hidden])');
    // 開き直すと、ひく前ではなく、同じ形の結果がすぐに出る
    await page.reload();
    await page.waitForSelector('#gachaResult:not([hidden])');
    await page.waitForSelector('#gachaSaved:not([hidden])');
    assert.equal((await readGachaToday(page)).mask, gachaMask, '同じ日なのに、形が変わった');
    // 今日のよつばは、図鑑の入れ物ではなく、今日のよつばの入れ物に入る（64×64 の形もいっしょに）
    const saved = await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('yotsuba-hunter');
      open.onsuccess = () => {
        const tx = open.result.transaction(['records', 'gacha'], 'readonly');
        const out = {};
        tx.objectStore('records').getAll().onsuccess = e => { out.inRecords = e.target.result.filter(r => r.source === 'gacha').length; out.others = e.target.result.length; };
        tx.objectStore('gacha').getAll().onsuccess = e => { out.gacha = e.target.result.map(r => r.gachaKind); out.shapes = e.target.result.map(r => r.shape64?.slice(0, 22)); };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    }));
    assert.deepEqual(saved.gacha, ['dit'], `今日のよつばの一覧に入った今日のよつば: ${saved.gacha}（DiT の 1 件のはず）`);
    assert.equal(saved.inRecords, 0, '今日のよつばが、図鑑の入れ物に入った');
    assert.deepEqual(saved.shapes, ['data:image/png;base64,'], '64×64 の形が残っていない');
    // 図鑑の詳細に「数式で作った形で学習したモデルです」
    await page.click('#gachaOpen');
    await page.waitForSelector('#detailGachaModel:not([hidden])');
    assert.equal(await page.textContent('#detailGachaModel'), '数式で作った形で学習したモデルです');
    // 見切れない: 今日のよつばの絵は、詳細でも一覧でも、切り抜かない（contain）。写真は、枠いっぱい（cover）のまま
    assert.equal(await page.$eval('#detailImg', el => getComputedStyle(el).objectFit), 'contain', '詳細で、今日のよつばの絵が切り抜かれている');
    // 図鑑の「すべて」には、写真だけ（枠いっぱい = cover）。今日のよつばは「今日のよつば」の一覧に、形の全体（contain）で出る
    await page.goto(`${BASE}/collection.html`);
    await page.waitForSelector('.record-card img');
    const fits = await page.$$eval('.record-card img', els => els.map(el => getComputedStyle(el).objectFit));
    assert.ok(fits.length > 0 && fits.every(f => f === 'cover'), `一覧の見え方: ${JSON.stringify(fits)}`);
    assert.equal(await page.locator('.record-card[aria-label$="今日のよつば"]').count(), 0, '図鑑の一覧に、今日のよつばが混ざった');
    await page.click('.tab-btn[data-filter="gacha"]');
    await page.waitForSelector('.gacha-row img');
    assert.equal(await page.$eval('.gacha-row img', el => getComputedStyle(el).objectFit), 'contain');
    // ホームの「見つけた四つ葉」の数には、今日のよつばを入れない
    await page.goto(`${BASE}/index.html#home`);
    await page.waitForFunction(n => document.getElementById('cloverCount')?.textContent === String(n), saved.others, { timeout: 10_000 });
  });
  await step('設定', async () => {
    await page.goto(`${BASE}/settings.html`);
    await page.click('[data-mode=auto]');
    await page.click('[data-mode=confirm]');
  });
  await step('カメラ（5 秒）', async () => {
    await page.goto(`${BASE}/scan.html`);
    await page.waitForTimeout(5000);
  });

  const origins = [...all].sort();
  console.log(`通信した場所: ${origins.join(', ')}`);
  assert.deepEqual(outside, [], `自分のサイト以外への通信がありました:\n${outside.join('\n')}`);
  console.log('OK: 自分のサイト以外への通信は 0 件');

  // オフライン（機内モードと同じ）: Service Worker のキャッシュから動くか
  await context.setOffline(true);
  await step('オフライン: ホーム', async () => {
    await page.goto(`${BASE}/index.html#home`);
    assert.ok(await page.$('.home-screen'), 'ホームが出ない');
  });
  await step('オフライン: 写真から探す（モデルの読み込みと検出）', async () => {
    await page.goto(`${BASE}/photo-pick.html`);
    await page.setInputFiles('#fileInput', PHOTO);
    await page.waitForURL(/photo-(found|none)\.html/, { timeout: 120_000 });
  });
  await step('オフライン: 図鑑', async () => {
    await page.goto(`${BASE}/collection.html`);
    await page.waitForSelector('.record-card');
  });
  // 今日の形を消して（次の日と同じ）、通信を切ったまま、もう一度ひく: キャッシュのモデルで、同じ形ができる（同じ日は同じシード）
  await step('オフライン: 今日のよつば（キャッシュのモデルで DiT の形を作る）', async () => {
    await page.goto(`${BASE}/gacha.html`);
    await page.waitForSelector('#gachaResult:not([hidden])');
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('yotsuba-hunter');
      open.onsuccess = () => { const tx = open.result.transaction('progress', 'readwrite'); tx.objectStore('progress').delete('gachaToday'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); };
    }));
    await page.reload();
    await page.waitForSelector('#gachaBefore:not([hidden])');
    await page.click('#gachaDraw');
    await page.waitForSelector('#gachaResult:not([hidden])', { timeout: 60_000 });
    assert.equal(await page.textContent('#gachaNote'), GACHA_DIT_NOTE);
    assert.equal((await readGachaToday(page)).mask, gachaMask, '同じ日なのに、オフラインで作った形がちがう');
  });
  console.log('OK: 通信を切っても、ホーム・写真から探す・図鑑・今日のよつば（DiT）が動く');

  // 設定の「すべてのデータを消す」（書き出しの案内を飛ばして、2 回押す）: 図鑑・まちがいの記録・きろく・調整の記録が消え、チュートリアルの「見た」印は残る
  await step('すべてのデータを消す', async () => {
    await page.goto(`${BASE}/settings.html`);
    await page.click('#wipeBtn');
    await page.click('#wipeSkip'); // 消す前の書き出しの案内は、飛ばす
    await page.click('#wipeBtn');
    await page.waitForSelector('#wipeMessage:not([hidden])');
    const left = await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('yotsuba-hunter');
      open.onsuccess = () => {
        const db = open.result;
        const names = ['records', 'gacha', 'feedback', 'lastPhoto', 'progress'];
        const tx = db.transaction(names, 'readonly');
        const out = {};
        for (const n of names) tx.objectStore(n).getAllKeys().onsuccess = e => { out[n] = e.target.result; };
        tx.oncomplete = () => resolve({ ...out, tutorialSeen: localStorage.getItem('yotsuba-tutorial-seen') });
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    }));
    assert.deepEqual(left.records, [], '図鑑が消えていない');
    assert.deepEqual(left.gacha, [], '今日のよつばの一覧が消えていない');
    assert.deepEqual(left.feedback, [], 'まちがいの記録が消えていない');
    assert.deepEqual(left.lastPhoto, [], '最後に調べた写真が消えていない');
    assert.deepEqual(left.progress, ['tutorial'], `きろく・調整の記録が消えていない、または、チュートリアルの印が消えた: ${left.progress}`);
    assert.equal(left.tutorialSeen, '1', 'チュートリアルの「見た」印が消えた');
  });
  await step('すべてのデータを消すと、今日のよつばも、ひく前にもどる', async () => {
    await page.goto(`${BASE}/gacha.html`);
    await page.waitForSelector('#gachaBefore:not([hidden])');
    assert.equal(await readGachaToday(page), null);
  });
  console.log('OK: すべてのデータを消すと、図鑑・まちがいの記録・きろく・調整の記録・今日のよつばの形が消え、チュートリアルの印は残る');

  // モデルが、まだ無いとき（検出を使う前）で、通信できる: ひいたときに、自分のサイトからモデルを取って、DiT の形を出す
  //   （オフラインでモデルが無いときに 60 枚から出ることは、tests-e2e/gacha-dit.mjs で確かめる）
  await context.setOffline(false);
  await step('今日のよつば（モデルが無い・通信できる → その場で取って DiT）', async () => {
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
    const asked = [];
    fresh.on('request', req => { record(req.url()); if (req.url().includes('/models/')) asked.push(req.url()); });
    fresh.on('serviceworker', sw => sw.on?.('request', req => record(req.url())));
    const p2 = await fresh.newPage();
    await p2.goto(`${BASE}/gacha.html`);
    await p2.waitForSelector('#gachaBefore:not([hidden])');
    await p2.click('#gachaDraw');
    await p2.waitForSelector('#gachaResult:not([hidden])', { timeout: 90_000 });
    assert.equal(await p2.textContent('#gachaNote'), GACHA_DIT_NOTE);
    assert.equal((await readGachaToday(p2)).kind, 'dit');
    assert.ok(asked.some(u => u.endsWith('/models/gacha-pretrain-fp32.onnx')), `今日のよつばのモデルを取りにいっていない: ${asked}`);
    assert.ok(asked.every(u => u.startsWith(BASE)), `自分のサイト以外から、モデルを取った: ${asked}`);
    await fresh.close();
  });
  assert.deepEqual(outside, [], `自分のサイト以外への通信がありました:\n${outside.join('\n')}`);
  console.log('OK: モデルが無くても、通信できれば、自分のサイトから取って DiT の形を出す。自分のサイト以外への通信は 0 件');
  await browser.close();
} finally {
  stop();
}
