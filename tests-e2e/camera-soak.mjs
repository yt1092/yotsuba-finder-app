// カメラの画面（scan.html）を、長い時間動かして、推論の回数・時間・待ち・メモリを記録する（iPhone の強制終了の調査用）
//
//   npm run build && node tests-e2e/camera-soak.mjs [ビルドのフォルダ（既定 dist）] [分（既定 10）] [出力の JSON]
//
// - ビルドを、このスクリプトの中の小さなサーバー（http://localhost）で配り、Playwright の Chromium（偽のカメラ）で開く
// - 偽のカメラは、Chrome の既定の試験の絵（四つ葉が無い。確認のポップアップで止まらないように）
// - 90 秒動きがないとお休みするので、30 秒ごとに画面を触る
// - 30 秒ごとに記録: 推論を頼んだ回数・結果が返った回数・待ち（頼んだ − 返った）・直近の推論の時間・JS のメモリ・ブラウザ全体のメモリ
//   推論の回数は、Worker とのやりとりを数える（直す前と後のどちらの版でも、同じ数え方）
import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.argv[2] ?? 'dist';
const MINUTES = Number(process.argv[3] ?? 10);
const OUT = process.argv[4] ?? 'camera-soak.json';
const PORT = 4180 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, BASE).pathname)).replace(/^[/\\]+/, '');
    if (!path) path = 'index.html';
    const file = join(ROOT, path);
    await stat(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise(r => server.listen(PORT, r));

// ブラウザ全体のメモリ（headless_shell のプロセスの、ワーキングセットの合計。Windows）
const profile = await mkdtemp(join(tmpdir(), 'yotsuba-soak-'));
const marker = profile.split(/[\\/]/).pop();
function browserMemoryMB() {
  try {
    // headless shell は、この測定だけが使うので、すべての headless_shell.exe（描画や GPU の子のプロセスも）を足す
    const ps = `(Get-CimInstance Win32_Process -Filter "Name='headless_shell.exe'" | Measure-Object -Property WorkingSetSize -Sum).Sum`;
    return Math.round(Number(execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString().trim()) / 1e6);
  } catch {
    return null;
  }
}

const context = await chromium.launchPersistentContext(profile, {
  // Playwright の Chromium（headless shell）。WebGPU は使えないので WASM で動く（直す前と後を、同じ条件で比べる）
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-webgpu'],
  viewport: { width: 390, height: 844 }, permissions: ['camera'],
});
// Worker とのやりとりを数える（ページを読む前に仕込む）
await context.addInitScript(() => {
  const w = window;
  w.__soak = { sent: 0, done: 0, lastMs: 0, backend: '' };
  const Orig = w.Worker;
  w.Worker = class extends Orig {
    constructor(...a) {
      super(...a);
      const sentAt = new Map();
      const post = this.postMessage.bind(this);
      this.postMessage = (m, t) => { if (m?.type === 'detect') { w.__soak.sent++; sentAt.set(m.id, performance.now()); } return post(m, t); };
      this.addEventListener('message', e => {
        const m = e.data;
        if (m?.type === 'ready') w.__soak.backend = m.backend;
        if (m?.type === 'result' || m?.type === 'error') { w.__soak.done++; const t = sentAt.get(m.id); if (t) { w.__soak.lastMs = Math.round(performance.now() - t); sentAt.delete(m.id); } }
      });
    }
  };
});
const page = context.pages()[0] ?? await context.newPage();
// スタート画面とチュートリアルを出さないように（スキャン画面だけを測る）
await page.goto(`${BASE}/settings.html`);
await page.evaluate(() => { localStorage.setItem('yotsuba-tutorial-seen', '1'); sessionStorage.setItem('yotsuba-started', '1'); });
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
await page.goto(`${BASE}/scan.html`);

const rows = [];
const t0 = Date.now();
for (let i = 0; i <= MINUTES * 2; i++) {
  if (i > 0) await page.waitForTimeout(30_000);
  await page.mouse.click(195, 400).catch(() => undefined); // 動きがあることにする（90 秒のお休みを防ぐ）
  const s = await page.evaluate(() => ({ ...window.__soak, status: document.getElementById('scanStatus')?.textContent ?? '', video: (() => { const v = document.querySelector('video'); return v ? `${v.videoWidth}x${v.videoHeight}` : ''; })() })).catch(e => ({ error: String(e) }));
  const m = await cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
  const heap = m.metrics.find(x => x.name === 'JSHeapUsedSize')?.value;
  const row = { sec: Math.round((Date.now() - t0) / 1000), ...s, queue: (s.sent ?? 0) - (s.done ?? 0), jsHeapMB: heap ? Math.round(heap / 1e6) : null, browserMB: browserMemoryMB() };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(OUT, JSON.stringify(rows, null, 1));
await context.close();
server.close();
