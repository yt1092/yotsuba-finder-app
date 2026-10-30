// 日記カードのフォントの先読みを、手の空いたときに始める（ホームで呼ぶ）
// - 最初の画面が出たあと（load のあと）、ブラウザの手が空いたとき（requestIdleCallback。無ければ少し待って）に始める
// - ホームではモデルを読み込まないので、モデルの読み込みと競わない
// - データ節約の設定がオンのときは、先読みしない（カードを作るときに、その場で必要な分だけを読み込む）
// フォントの CSS は、ここでは読み込まない（先読みを始めるときに、diary-fonts.ts ごと読み込む）
export function prefetchDiaryFontsWhenIdle(): void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return;

  const start = () => {
    import('./diary-fonts')
      .then(m => m.prefetchDiaryFonts())
      .catch(() => { /* 先読みに失敗しても、カードを作るときに読み込む */ });
  };
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(start, { timeout: 5000 });
    else window.setTimeout(start, 1500); // iPhone の Safari など
  };
  // 初めて開いたときは、サービスワーカーがまだ画面を受け持っていないので、受け持つのを待ってから始める
  // （先に読み込むと、フォントがキャッシュに入らず、オフラインで使えないため）
  const afterLoad = () => whenServiceWorkerControls().then(whenIdle);
  if (document.readyState === 'complete') afterLoad();
  else window.addEventListener('load', afterLoad, { once: true });
}

// サービスワーカーが画面を受け持つまで待つ（使えないとき・開発中は、少し待ってから進む）
function whenServiceWorkerControls(timeoutMs = 10000): Promise<void> {
  const sw = navigator.serviceWorker;
  if (!sw || sw.controller) return Promise.resolve();
  return new Promise(resolve => {
    const timer = window.setTimeout(resolve, timeoutMs);
    sw.addEventListener('controllerchange', () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
}
