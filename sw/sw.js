// サービスワーカー: オフラインでもアプリを使えるように、ファイルをキャッシュする
//
// このファイルはひな形。npm run build のときに vite.config.ts が「__」で囲んだ部分を埋めて、dist/sw.js を作る
//
// キャッシュは 2 つに分ける
//   画面用（APP_CACHE）  : HTML・JS・CSS・フォント・アイコン。ビルドごとに作り直す
//   モデル用（MODEL_CACHE）: /models/ と /ort/。大きいので、アプリを更新しても消さずに使い回す
//
// 「今日のよつば」のモデル（GACHA_MODEL_URL。src/lib/gacha-config.ts）は、ホームの画面から頼まれたときだけ、背景で入れる
// （prefetchGachaModel。ホームは、検出のモデルがキャッシュにあるときに頼む。src/pages/main.ts）。
// カメラの画面（scan.html）が開いているあいだは、取らない（開いたら、取っている途中でも止める。カメラの負担を増やさないため）。
// 今日のよつばの画面が、ひいたときに取ったものも、ここ（cacheFirst）でキャッシュに入る

const APP_NAME = 'yotsuba-finder';
const APP_VERSION = '__APP_VERSION__'; // package.json の version
const BUILD_ID = '__BUILD_ID__';       // ビルドした中身から作った短い ID（中身が変わると変わる）
const PRECACHE_URLS = __PRECACHE_URLS__; // インストール時に先に入れておくファイル（モデルと wasm は含めない）
const GACHA_MODEL_URL = '__GACHA_MODEL_URL__'; // 今日のよつばのモデル

const APP_CACHE = `${APP_NAME}-app-v${APP_VERSION}-${BUILD_ID}`;
const MODEL_CACHE = `${APP_NAME}-models-v6`; // 今日のよつばのモデルを、ひいたときにも取るようにしたので、版を上げた（古いキャッシュは、入れかえのときに消える）

// インストール: 画面の表示に必要なファイルを先にキャッシュに入れる
// （モデルと wasm は大きいので、ここでは入れない。写真検索か Scan を初めて開いたときに入る）
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

// 有効化: このアプリの古いキャッシュ（前のビルドの画面用キャッシュなど）を消す
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(name => name.startsWith('yotsuba') && name !== APP_CACHE && name !== MODEL_CACHE)
          .map(name => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

// 通信の横取り: ファイルの種類ごとに、キャッシュとネットワークのどちらを優先するかを決める
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 自分のサイト以外には手を出さない

  const path = url.pathname;
  // 診断用のモデル（?model=v3|fp16。src/lib/diag.ts）はキャッシュしない（今のモデルのキャッシュを消してしまわないように）
  if (path.startsWith('/models/diag/')) return;
  if (path === '/scan.html' && request.mode === 'navigate') gachaAbort?.abort(); // カメラの画面を開いたら、背景の取り込みを止める
  if (path.startsWith('/models/') || path.startsWith('/ort/')) {
    event.respondWith(cacheFirst(MODEL_CACHE, request, removeOldModelFiles));
  } else if (request.mode === 'navigate' || path === '/' || path.endsWith('.html')) {
    event.respondWith(htmlNetworkFirst(request));
  } else if (path.startsWith('/assets/')) {
    event.respondWith(cacheFirst(APP_CACHE, request)); // ハッシュ付きの JS・CSS・フォント
  } else {
    event.respondWith(networkFirst(APP_CACHE, request)); // manifest.json・アイコンなど
  }
});

// キャッシュ優先: キャッシュにあればそれを返す。なければネットワークから取って、キャッシュに入れる
async function cacheFirst(cacheName, request, afterPut) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.status === 200) { // 一部だけの応答（206）などは入れない
    await cache.put(request, response.clone());
    if (afterPut) await afterPut(cache, request.url);
  }
  return response;
}

// ネットワーク優先: つながればネットワークから取ってキャッシュを更新する。つながらなければキャッシュを返す
async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

// HTML 用のネットワーク優先
// detail.html?id=3 のような「?」付きの URL も、キャッシュでは「?」を除いた同じページとして扱う
async function htmlNetworkFirst(request) {
  const cache = await caches.open(APP_CACHE);
  const url = new URL(request.url);
  const key = url.origin + url.pathname;
  try {
    const response = await fetch(request);
    if (response.ok && !response.redirected) await cache.put(key, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(key)) ?? (url.pathname === '/' ? await cache.match(url.origin + '/index.html') : undefined);
    if (cached) return cached;
    throw error;
  }
}

// ホームの画面からの頼み: 今日のよつばのモデルを、背景で入れる
self.addEventListener('message', event => {
  if (event.data?.type === 'prefetch-gacha') event.waitUntil(prefetchGachaModel().catch(() => undefined));
});

// カメラの画面が開いているか
async function scanOpen() {
  const list = await self.clients.matchAll({ type: 'window' });
  return list.some(c => new URL(c.url).pathname === '/scan.html');
}

// 今日のよつばのモデルを、モデル用キャッシュに入れる（もう入っていれば、何もしない。同時に 2 回は取らない。
// カメラの画面が開いていれば、取らない。取っている途中でカメラの画面が開いたら、止める）
let gachaPrefetch = null;
let gachaAbort = null;
function prefetchGachaModel() {
  gachaPrefetch ??= (async () => {
    const cache = await caches.open(MODEL_CACHE);
    if (await cache.match(GACHA_MODEL_URL)) return;
    if (await scanOpen()) return;
    gachaAbort = new AbortController();
    const response = await fetch(GACHA_MODEL_URL, { signal: gachaAbort.signal });
    if (response.ok && response.status === 200) {
      await cache.put(GACHA_MODEL_URL, response);
      await removeOldModelFiles(cache, new URL(GACHA_MODEL_URL, self.location.origin).href);
      // 開いているホームに知らせる（「今日のよつば」の準備の印を確かめ直す。src/pages/main.ts）
      for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'gacha-model-cached' });
    }
  })().finally(() => { gachaPrefetch = null; gachaAbort = null; });
  return gachaPrefetch;
}

// モデルの種類（検出のモデルと、今日のよつばのモデルは、たがいに消し合わない）
const modelKind = path => (path.startsWith('/models/gacha-') ? 'gacha' : 'detector');

// モデル用キャッシュから、古い版のファイルを消す（新しい版をキャッシュに入れた直後に呼ぶ）
//   /models/ : 今入れたファイルと同じ種類で、今入れたファイル以外のモデルを消す（yotsuba-v2.onnx → yotsuba-v3.onnx に上げたとき、v2 を消す）
//   /ort/<版>/ : 今入れたファイルと違う版のフォルダのファイルを消す
async function removeOldModelFiles(cache, keptUrl) {
  const kept = new URL(keptUrl).pathname;
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    const oldModel = kept.startsWith('/models/') && path.startsWith('/models/') && path !== kept && modelKind(path) === modelKind(kept);
    const oldOrt = kept.startsWith('/ort/') && path.startsWith('/ort/') && ortVersionDir(path) !== ortVersionDir(kept);
    if (oldModel || oldOrt) await cache.delete(request);
  }
}

// /ort/1.30.0/ファイル名 → /ort/1.30.0/
function ortVersionDir(path) {
  return path.split('/').slice(0, 3).join('/') + '/';
}
