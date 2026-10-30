// 今日のよつばのモデルを、背景で入れるよう、Service Worker に頼む（ホームの画面から。sw/sw.js の prefetchGachaModel）
// 頼むのは、検出のモデルがもうキャッシュにあり（アプリの主なモデルを取ったあと）、今日のよつばのモデルがまだ無いときだけ。
// 手の空いたときに頼む（ホームの表示を遅らせない）。カメラの画面（scan.html）では頼まない（カメラの負担を増やさないため）
import { MODEL_URL } from './detector-config';
import { gachaModelReady } from './gacha-config';

const DELAY_MS = 3000;

async function ask(): Promise<void> {
  const sw = navigator.serviceWorker?.controller;
  if (!sw || typeof caches === 'undefined') return;
  if (!(await caches.match(MODEL_URL)) || (await gachaModelReady())) return;
  sw.postMessage({ type: 'prefetch-gacha' });
}

export function prefetchGachaModelWhenIdle(): void {
  const run = () => { ask().catch(() => undefined); };
  window.setTimeout(() => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 5000 });
    else run();
  }, DELAY_MS);
}
