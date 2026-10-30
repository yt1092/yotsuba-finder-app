import { defineConfig, defaultClientConditions, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createHash } from 'crypto';
import { readFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { gachaImageUrls } from './src/lib/gacha';
import { GACHA_MODEL_URL } from './src/lib/gacha-config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// アプリと onnxruntime-web の版（キャッシュ名や /ort/<版>/ の場所に使う）
const readJson = (file: string) => JSON.parse(readFileSync(path.resolve(__dirname, file), 'utf8'));
const APP_VERSION: string = readJson('package.json').version;
const ORT_VERSION: string = readJson('node_modules/onnxruntime-web/package.json').version;

// 開発用の版（デバッグ表示: 枠ごとのスコアの数字など。src/lib/dev-mode.ts）を作るか
// - VITE_DEBUG_OVERLAY=1 を付けてビルドしたとき（例: VITE_DEBUG_OVERLAY=1 npm run build）
// - Vercel の、debug ブランチのプレビューのとき（VERCEL_GIT_COMMIT_REF は Vercel がビルドのときに入れる）
// 本番（Vercel の production）では、いつも false。false のときは、デバッグ表示のコードがビルドで取りのぞかれる
const DEBUG_OVERLAY = process.env.VERCEL_ENV !== 'production'
  && (process.env.VITE_DEBUG_OVERLAY === '1' || process.env.VERCEL_GIT_COMMIT_REF === 'debug');

// 診断の版か: 診断の URL パラメータ（?diag=1 など。src/lib/diag.ts）と、診断のためのファイル（public/models/diag/）を入れる
// プレビューと、手元の npm run build・npm run dev では入れる。本番（Vercel の production）では入れない
// （false のときは、診断の表示のコードがビルドで取りのぞかれ、測定・診断のファイルも dist/ から外す。npm run check:no-diag で確かめる）
const DIAG_BUILD = process.env.VERCEL_ENV !== 'production';
const DIAG_PUBLIC = ['models/diag', 'bench-models']; // bench-models は Git に入れていない（手元だけ）

// __DIAG__ を、ソースを読んだすぐあとに true / false に置き換える（define だと、置き換えが Rollup の木の刈り込みのあとになり、
// 使わない診断の関数がビルドに残るため。先に置き換えれば、if (__DIAG__ …) の中と、そこからしか使わない関数が、まるごと消える）
function diagFlag(): Plugin {
  return {
    name: 'yotsuba-diag-flag',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/src\/.*\.ts$/.test(id.replace(/\\/g, '/')) || !code.includes('__DIAG__')) return null;
      return { code: code.replace(/\b__DIAG__\b/g, String(DIAG_BUILD)), map: null };
    },
  };
}

// 本番のビルドで、public/ から写された測定・診断のファイルを dist/ から外す（public/ はそのまま写されるため）
function dropDiagPublic(): Plugin {
  let outDir = 'dist';
  return {
    name: 'yotsuba-drop-diag-public',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      if (DIAG_BUILD) return;
      for (const p of DIAG_PUBLIC) rmSync(path.join(outDir, p), { recursive: true, force: true });
    },
  };
}

// アイコンなど、public/ にあって最初からキャッシュに入れておくファイル
const PUBLIC_PRECACHE = ['/manifest.json', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png',
  // 初めて開いたときの説明の絵（4 枚・2 つの大きさ。src/components/tutorial.ts）
  ...[1, 2, 3, 4].flatMap(n => [`/images/tutorial-${n}.webp`, `/images/tutorial-${n}-640.webp`]),
  // キャラクターの表情（src/lib/mascot.ts）
  ...['happy', 'thinking', 'smile', 'surprised'].map(k => `/images/mascot/${k}.webp`),
  // 「今日のよつば」の、あらかじめ作った形 60 個（モデルで作れないときに出す。src/lib/gacha.ts。全部で 約 240KB）
  ...gachaImageUrls(),
  // 画面の文字のフォント（Zen Maru Gothic 500・700。scripts/make_fonts.py）
  '/fonts/zen-maru-gothic-500.woff2', '/fonts/zen-maru-gothic-700.woff2',
  // 「このアプリについて」で見せるファイル（scripts/make-licenses.mjs。オフラインでも見られるように）
  '/about/licenses.json', '/about/LICENSE.txt', '/about/CREDITS.md'];

// サービスワーカーを作るプラグイン（ビルドのときだけ動く）
// sw/sw.js のひな形に、キャッシュするファイルの一覧とビルド ID を書き込んで、dist/sw.js として出力する
function serviceWorker(): Plugin {
  return {
    name: 'yotsuba-service-worker',
    apply: 'build',
    enforce: 'post', // HTML は Vite 自身のプラグインが出力するので、その後に動かす
    generateBundle(_options, bundle) {
      // 画面の表示に必要な HTML・JS・CSS を先にキャッシュする（フォントは使ったときにキャッシュする）
      // 日記カードのフォントは、ここでは入れない。ホームで、手の空いたときに先読みする（src/lib/diary-fonts-prefetch.ts）
      const built = Object.keys(bundle).filter(file => /\.(html|js|css)$/.test(file)).sort();
      const precache = ['/', ...built.map(file => `/${file}`), ...PUBLIC_PRECACHE];

      // ビルドした中身全体から短い ID を作る（中身が変われば ID が変わり、新しいキャッシュに切り替わる）
      const hash = createHash('sha256');
      for (const file of Object.keys(bundle).sort()) {
        const item = bundle[file];
        hash.update(file).update(item.type === 'chunk' ? item.code : item.source);
      }
      const buildId = hash.digest('hex').slice(0, 10);

      const source = readFileSync(path.resolve(__dirname, 'sw/sw.js'), 'utf8')
        .replace('__APP_VERSION__', APP_VERSION)
        .replace('__BUILD_ID__', buildId)
        .replace('__PRECACHE_URLS__', JSON.stringify(precache, null, 2))
        .replace('__GACHA_MODEL_URL__', GACHA_MODEL_URL);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [diagFlag(), basicSsl(), serviceWorker(), dropDiagPublic()],
  server: { https: true, host: true },
  // コードの中の __ORT_VERSION__ を、onnxruntime-web の版に置き換える（wasm を /ort/<版>/ から読むため）
  define: { __ORT_VERSION__: JSON.stringify(ORT_VERSION), __APP_VERSION__: JSON.stringify(APP_VERSION), __DEBUG_OVERLAY__: JSON.stringify(DEBUG_OVERLAY) },
  // onnxruntime-web は「wasm を /ort/ から読む版（extern-wasm）」を使う
  // （既定の bundle 版だと、Vite が 27MB の wasm を assets/ にも複製してしまうため）
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  // onnxruntime-web は事前変換すると wasm の読み込みが壊れることがあるので、変換しない
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // 検出用の Web Worker を ES モジュールとしてビルドする（onnxruntime-web が import を使うため）
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        permission: path.resolve(__dirname, 'permission.html'),
        scan: path.resolve(__dirname, 'scan.html'),
        found: path.resolve(__dirname, 'found.html'),
        'photo-pick': path.resolve(__dirname, 'photo-pick.html'),
        'photo-found': path.resolve(__dirname, 'photo-found.html'),
        'photo-none': path.resolve(__dirname, 'photo-none.html'),
        collection: path.resolve(__dirname, 'collection.html'),
        detail: path.resolve(__dirname, 'detail.html'),
        settings: path.resolve(__dirname, 'settings.html'),
        kiroku: path.resolve(__dirname, 'kiroku.html'),
        gacha: path.resolve(__dirname, 'gacha.html'),
        about: path.resolve(__dirname, 'about.html'),
      },
    },
  },
});
