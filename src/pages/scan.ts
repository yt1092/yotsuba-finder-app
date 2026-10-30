// Scan（スキャン）画面: カメラ映像をリアルタイムで解析する
import '../lib/register-sw';
import { cropForRecord } from '../lib/crop-image';
import type { Crop } from '../lib/crop';
import { fourThresholdFor } from '../lib/tuning-db';
import { injectSvgDefs } from '../components/svg-defs';
import { createDetector } from '../lib/create-detector';
import { FrameSkippedError, type Detection } from '../lib/detector';
import { iou } from '../lib/box-utils';
import {
  SCAN_INTERVAL_MS, CLUSTER_MODE, CLUSTER_TILE_EVERY,
  CONFIRM_WINDOW, CONFIRM_HITS, SAME_POSITION_IOU, SAVE_COOLDOWN_MS, CLEAR_DETECTIONS,
} from '../lib/detector-config';
import { countRecords } from '../lib/db';
import { stashNotice } from '../lib/progress-db';
import { saveFourLeafRecord } from '../lib/save-four';
import { getSaveMode } from '../lib/save-mode';
import { saveAnswer } from '../lib/feedback-db';
import { drawScanOverlay } from '../components/scan-overlay';
import { DEBUG_BUILD, isDevMode } from '../lib/dev-mode';
import { CRASHES_TO_PHOTO, MIN_GAP_MS, cameraSize, crashSummary, createDiagBox, diag, readSession, writeSession } from '../lib/diag';
import { wasmGapMs } from '../lib/scan-pace';

injectSvgDefs();

const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const foundCard = document.getElementById('foundCard') as HTMLElement;
const badgeEl = document.getElementById('collectionBadge');
const statusEl = document.getElementById('scanStatus');
const toggleBtn = document.getElementById('scanToggle') as HTMLButtonElement;
const cameraHelp = document.getElementById('cameraHelp') as HTMLElement;

// 最後に保存した時刻を覚えておく場所（Found 画面から戻ってきても、同じ四つ葉を二重に保存しないため）
const LAST_SAVE_KEY = 'scanLastSavedAt';

type Box = Detection['bbox'];

// カメラは WASM で動かす（WebGPU は ?backend=webgpu のときだけ。iPhone で、WebGPU のときだけ約 10 秒で強制終了したため。detector-config.ts）
const detector = createDetector('camera');
// 推論が終わってから、次の推論までの間（実行環境が分かったら決め直す）
// WASM は、1 回ごとに実測から決め直す（直前の推論の時間の半分、最小 200ms。src/lib/scan-pace.ts）。WebGPU（診断用）は 300ms
// 前の推論が終わっていなければ、新しいコマは作らない（待ち行列をためない。iPhone で強制終了しないように）
let intervalMs: number = Math.max(MIN_GAP_MS, diag.intervalMs ?? SCAN_INTERVAL_MS.webgpu);
let adaptive = false;      // WASM で、間を実測から決める（?interval= が無いとき）
let fastestMs = 0;         // いちばん速かった推論の時間（熱くなって遅くなったかを見る）
let timerId = 0;
let busy = false;          // 推論している（このあいだは、次のコマを作らない）
let backendName = '';      // 使っている方式（診断の表示用）
const stats = { start: 0, infer: 0, ms: 0 }; // 経過・推論の回数・直近の推論の時間（診断の表示と、異常終了の見張り）
let paused = false;      // 四つ葉を保存したら一時停止する（確認のポップアップのあいだ）
// 使う人が止めた（上の「自動で探しています」を押した）・自動でお休みした・画面が見えない・カメラが止まった
let stopped: 'none' | 'user' | 'sleep' | 'hidden' | 'camera' = 'none';
const IDLE_SLEEP_MS = 90_000; // 動きがないと、自動でお休みするまでの時間
let lastActivity = Date.now(); // 最後に動きがあった時刻（画面を触った・四つ葉の候補を追った）
let detectCount = 0;     // 検出を頼んだ回数（群生地モードでタイル検出を混ぜるタイミングに使う）
let lastFrame: ImageBitmap | null = null; // 直近の検出に使ったフレーム（保存用に取っておく）
// 四つ葉のしきい値（使う人に合わせて少しだけ動かしたもの。確認のポップアップで選ぶたびに読み直す。src/lib/tuning.ts）
let fourThreshold: number | undefined;
const loadFourThreshold = () => fourThresholdFor('camera').then(t => { fourThreshold = t; }).catch(() => undefined);
loadFourThreshold();

// 直近の検出で見つかった四つ葉の位置（見つからなかった回は null）
const history: (Box | null)[] = [];

// 二重保存を防ぐための状態
const lastSavedAt = Number(sessionStorage.getItem(LAST_SAVE_KEY) ?? 0);
let cooldownUntil = lastSavedAt + SAVE_COOLDOWN_MS; // この時刻までは保存しない
let awaitingClear = lastSavedAt > 0; // true の間は、四つ葉が一度視界から外れるまで保存しない
let clearStreak = 0;                 // 四つ葉が続けて見えなかった回数

// カメラを起動して、検出を始める
// カメラの許可は、このページで 1 回だけ求める（Permission 画面では求めない。続けて 2 回きかれないように）
// 画面を離れても、トラックは止めない（iPhone の Safari は、もう一度 getUserMedia を呼ぶと、また許可をきくため）
async function startCamera() {
  cameraHelp.hidden = true;
  const old = video.srcObject as MediaStream | null;
  if (old && old.getVideoTracks().some(t => t.readyState === 'live')) {
    await video.play().catch(() => undefined);
    resumeFrom('camera');
    return;
  }
  try {
    // 解像度は 1280×720 まで（?res=640 なら 640×480。src/lib/diag.ts）。大きい映像は、iPhone のメモリを使いすぎる
    const size = cameraSize();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: size.width, max: size.width },
        height: { ideal: size.height, max: size.height },
      },
    });
    video.srcObject = stream;
    // カメラが止まったら（ほかのアプリが使った・OS が止めた など）、案内と「カメラを つかう」を出す
    for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => showCameraHelp('ended'));
    await video.play();
    resizeCanvas();
  } catch (e) {
    showCameraHelp((e as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'error');
    return;
  }
  const wasStopped = stopped === 'camera';
  if (wasStopped) { stopped = 'none'; showStatus(); }

  startWatch();
  if (!diag.infer) return; // ?infer=0: 検出を止めて、映像だけを出す（診断用）

  // 実行環境に合わせて、推論のあとの間を決める（WASM は遅いので、長めにあける）
  try {
    const backend = await detector.backend();
    backendName = backend;
    adaptive = backend === 'wasm' && diag.intervalMs === undefined;
    intervalMs = diag.intervalMs ?? (backend === 'wasm' ? wasmGapMs(0, 0) : SCAN_INTERVAL_MS[backend]);
  } catch (e) {
    console.error('検出器の準備に失敗しました', e);
    return;
  }
  tick();
}

// canvas サイズをビデオ解像度に合わせる
// canvas は画面の大きさ（× 画素の細かさ）にする。枠は、映像を cover で出したときの位置に描く（src/components/scan-overlay.ts）
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 今のコマを 1 つ検出に回す。推論が終わってから intervalMs あけて、次のコマ（1 つずつ。待ち行列をためない）
async function tick() {
  if (paused || stopped !== 'none' || busy || !diag.infer) return;
  if (video.srcObject && !cameraLive()) {
    showCameraHelp('ended');
    return;
  }
  if (video.readyState < 2) {
    timerId = window.setTimeout(tick, intervalMs);
    return;
  }
  busy = true;
  clearTimeout(timerId);
  let frame: ImageBitmap | null = null;
  const t0 = performance.now();
  try {
    frame = await createImageBitmap(video);
    detectCount++;
    const tiles = CLUSTER_MODE && detectCount % CLUSTER_TILE_EVERY === 0;
    const detections = await detector.detect(frame, { mode: 'camera', tiles, fourThreshold });
    stats.infer++;
    stats.ms = Math.round(performance.now() - t0);
    if (adaptive) {
      intervalMs = wasmGapMs(stats.ms, fastestMs);
      // いちばん速かった時間は、はじめの 1 回（準備の時間が入る）を数えない
      if (stats.infer > 1) fastestMs = fastestMs ? Math.min(fastestMs, stats.ms) : stats.ms;
    }
    const f = frame;
    frame = null; // ここからは onResult が持つ（lastFrame として取っておくか、close する）
    await onResult(detections, f);
  } catch (e) {
    if (!(e instanceof FrameSkippedError)) console.error(e);
  } finally {
    frame?.close(); // 使わなかったコマは、必ず閉じる
    busy = false;
    if (!paused && stopped === 'none') timerId = window.setTimeout(tick, intervalMs);
  }
}

// 検出結果が届いたときの処理
async function onResult(detections: Detection[], frame: ImageBitmap) {
  if (paused || stopped !== 'none') {
    frame.close(); // 一時停止のあとに届いた結果は使わない
    return;
  }
  lastFrame?.close();
  lastFrame = frame;

  // いちばん自信の高い四つ葉を 1 つ選ぶ（これを追う）
  const four = detections
    .filter(d => d.label === '四つ葉')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

  updateClearState(four != null);

  history.push(four ? four.bbox : null);
  if (history.length > CONFIRM_WINDOW) history.shift();

  const hits = four ? trackHits(four.bbox) : 0;
  if (four) lastActivity = Date.now(); // 四つ葉の候補を追っているあいだは、お休みしない
  const stable = four != null && hits >= CONFIRM_HITS && canSave();
  if (diag.boxes) drawOverlay(detections, four, hits, stable); // ?boxes=0: 枠を描かない（診断用）
  if (four && stable) {
    await confirmFound(frame, four, detections);
  }
}

// 直近の検出のうち、ほぼ同じ位置に四つ葉が出た回数（CONFIRM_HITS 回以上で確定）
function trackHits(latest: Box): number {
  return history.filter(b => b && iou(b, latest) >= SAME_POSITION_IOU).length;
}

// 保存してよいか（クールダウンが過ぎていて、前の四つ葉が一度視界から外れている）
function canSave(): boolean {
  return !awaitingClear && Date.now() >= cooldownUntil;
}

// 保存したあと、四つ葉が続けて CLEAR_DETECTIONS 回見えなければ「視界から外れた」とみなす
function updateClearState(fourVisible: boolean) {
  if (!awaitingClear) return;
  clearStreak = fourVisible ? 0 : clearStreak + 1;
  if (clearStreak >= CLEAR_DETECTIONS) {
    awaitingClear = false;
    clearStreak = 0;
  }
}

// 四つ葉が確定したときの処理: スキャンを止め、そのフレームを保存して、検出カードを出す
// 「確認してから入れる」（既定）のときは、確認のポップアップで「図鑑に入れる」を選んだときだけ保存する。
// 「入れない」なら、保存せず、まちがいの記録に足して、スキャンを再開する（同じ葉が一度視界から外れるまでは、もう出さない）
async function confirmFound(frame: ImageBitmap, four: Detection, detections: Detection[]) {
  paused = true;
  clearTimeout(timerId);
  showStatus();

  // 図鑑に入れる写真は、四つ葉の枠のまわりで切り抜く（src/lib/crop.ts。まちがいの記録には、フレーム全体を使う）
  const saved = await cropForRecord(frame, frameToDataUrl(frame), [four.bbox]);
  const dataUrl = saved.imageDataUrl;
  const now = Date.now();
  sessionStorage.setItem(LAST_SAVE_KEY, String(now));
  cooldownUntil = now + SAVE_COOLDOWN_MS;
  awaitingClear = true;
  history.length = 0;

  if (getSaveMode() === 'confirm') {
    const { openFourConfirm } = await import('../components/four-confirm');
    const summary = await openFourConfirm({
      photo: frame,
      candidates: [four],
      onDone: async s => {
        if (s.kept.length > 0) {
          await saveFound(dataUrl, saved.crop);
          showFoundCard(dataUrl);
          await updateBadge();
        } else if (s.skipped.length > 0) {
          await saveAnswer(`camera:${now}`, frame, detections, { kind: 'not-four', index: detections.indexOf(four), bbox: four.bbox })
            .catch(e => console.error(e));
        }
      },
    });
    loadFourThreshold(); // 選んだ記録が増えたので、しきい値を読み直す
    if (summary.kept.length === 0) resumeScan();
    return;
  }

  await saveFound(dataUrl, saved.crop);
  showFoundCard(dataUrl);
  await updateBadge();
}

// スキャンを再開する（確認のポップアップで「入れない」を選んだとき・とじたとき）
function resumeScan() {
  paused = false;
  lastActivity = Date.now();
  showStatus();
  tick();
}

// 上の表示: 探しているか、止まっているか（押すと、一時停止・再開）
function showStatus() {
  const text = paused || stopped === 'user' ? '一時停止中'
    : stopped === 'sleep' ? 'お休み中'
    : stopped === 'camera' ? 'カメラが 止まっています'
    : '自動で探しています';
  if (statusEl) statusEl.textContent = text;
  const resting = stopped === 'user' || stopped === 'sleep';
  toggleBtn.setAttribute('aria-pressed', String(resting));
  toggleBtn.setAttribute('aria-label', resting ? `${text}。押すと、また探します` : `${text}。押すと、一時停止します`);
}

// 止める（使う人が押した・自動でお休み・画面が見えない・カメラが止まった）。カメラのトラックは止めない
function stopScan(why: Exclude<typeof stopped, 'none'>) {
  stopped = why;
  clearTimeout(timerId);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  history.length = 0;
  if (why === 'user' || why === 'sleep') video.pause(); // 映像を止めて、電池を減らさない（トラックはそのまま）
  showStatus();
}

// カメラのトラックが生きているか（'ended' のイベントが来ないまま止まることもあるので、再開の前に確かめる）
function cameraLive(): boolean {
  const stream = video.srcObject as MediaStream | null;
  return !!stream?.getVideoTracks().some(t => t.readyState === 'live');
}

// 止めた理由が why のときだけ、再開する。カメラが止まっていたら、案内と「カメラを つかう」を出す
function resumeFrom(why: Exclude<typeof stopped, 'none'>) {
  if (stopped !== why) return;
  if (why !== 'camera' && !cameraLive()) {
    showCameraHelp('ended');
    return;
  }
  stopped = 'none';
  lastActivity = Date.now();
  video.play().catch(() => undefined);
  showStatus();
  if (!paused) tick();
}

toggleBtn.addEventListener('click', () => {
  if (paused) return; // 確認のポップアップのあいだは、そちらで決める
  if (stopped === 'user' || stopped === 'sleep') resumeFrom(stopped);
  else if (stopped === 'none') stopScan('user');
});

// 90 秒、動きがない（画面を触っていない・四つ葉の候補を追っていない）と、自動でお休み
document.addEventListener('pointerdown', () => { lastActivity = Date.now(); }, { passive: true });
// ?diag=1&sleep=0 のときは、お休みしない（3 分続けて動かす診断のため。src/lib/diag.ts）
window.setInterval(() => {
  if (diag.sleep && stopped === 'none' && !paused && Date.now() - lastActivity >= IDLE_SLEEP_MS) stopScan('sleep');
}, 5000);

// カメラが使えない・止まったときの案内
function showCameraHelp(why: 'denied' | 'ended' | 'error') {
  stopScan('camera');
  document.getElementById('cameraHelpTitle')!.textContent = why === 'denied' ? 'カメラが 使えません' : 'カメラが 止まっています';
  document.getElementById('cameraHelpText')!.textContent = why === 'denied'
    ? 'カメラの 使用が 許可されていません。「カメラを つかう」を押して、許可してください。'
    : 'ほかのアプリが カメラを 使ったか、画面を 離れたため、止まりました。「カメラを つかう」を押すと、また 探します。';
  cameraHelp.hidden = false;
}
document.getElementById('cameraRetry')!.addEventListener('click', () => startCamera());

// canvas に検出の枠を描く（見た目は src/components/scan-overlay.ts）。上のバーと下のボタンの範囲には描かない
function drawOverlay(detections: Detection[], tracked: Detection | undefined, hits: number, stable: boolean) {
  const view = { w: canvas.clientWidth, h: canvas.clientHeight };
  const top = Math.max(...['scanTop', 'scanLegend'].map(id => document.getElementById(id)?.getBoundingClientRect().bottom ?? 0)) + 4;
  const bottom = (document.getElementById('scanBottom')?.getBoundingClientRect().top ?? view.h) - 4;
  drawScanOverlay(ctx, {
    detections, video: { w: video.videoWidth || view.w, h: video.videoHeight || view.h }, view,
    area: { top, bottom }, tracked, hits, needed: CONFIRM_HITS, stable, dev: DEBUG_BUILD && isDevMode(), rings: diag.rings,
  });
}

// 検出に使ったフレームを JPEG にする（切り抜けなかったときに、全体を保存する）
function frameToDataUrl(frame: ImageBitmap): string {
  const c = document.createElement('canvas');
  c.width = frame.width;
  c.height = frame.height;
  c.getContext('2d')!.drawImage(frame, 0, 0);
  return c.toDataURL('image/jpeg', 0.8);
}

// IndexedDB に四つ葉として保存し、Found 画面に ID を渡す
async function saveFound(dataUrl: string, crop?: Crop) {
  // 保存と、四つ葉の経験値（1 つ 100 点。Found 画面で知らせる）は、src/lib/save-four.ts で
  const { id, progress } = await saveFourLeafRecord({
    date: Date.now(),
    imageDataUrl: dataUrl,
    label: '四つ葉',
    source: 'camera',
    ...(crop ? { crop } : {}),
  }, { count: 1 });
  sessionStorage.setItem('lastFoundId', String(id));
  stashNotice(progress);
}

// 検出カードをアニメーション付きで表示する
function showFoundCard(dataUrl: string) {
  const thumb = foundCard.querySelector('.found-thumb') as HTMLImageElement | null;
  if (thumb) thumb.src = dataUrl;
  foundCard.hidden = false;
  foundCard.classList.add('slide-up');
}

// ナビのコレクションバッジを更新する
async function updateBadge() {
  const n = await countRecords();
  if (badgeEl) badgeEl.textContent = String(n);
}

// ページ離脱時にカメラストリームを止める（バッテリー消費を防ぐ）
// 画面が見えないあいだは、検出を止める（カメラのトラックは止めない。止めると、戻ったときに、また許可をきかれるため）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    endWatch();
    if (stopped === 'none') stopScan('hidden');
  } else {
    if (stats.start) startWatch();
    resumeFrom('hidden');
  }
});
window.addEventListener('pagehide', () => {
  endWatch(); // きれいに終わった（次に開いたときは、ふつうに始める）
  if (stopped === 'none') stopScan('hidden');
});
// 「戻る」でキャッシュから表示されたとき: トラックが生きていれば、そのまま続ける。止まっていれば、案内と「カメラを つかう」
window.addEventListener('pageshow', e => {
  if (!e.persisted) return;
  const stream = video.srcObject as MediaStream | null;
  if (stream?.getVideoTracks().some(t => t.readyState === 'live')) resumeFrom('hidden');
  else showCameraHelp('ended');
});

window.addEventListener('resize', resizeCanvas);

// 枠の見方（凡例）: 初めて見たあとは、小さくする
try {
  if (localStorage.getItem('yotsuba-legend-seen') === '1') document.getElementById('scanLegend')?.classList.add('scan-legend--small');
  else localStorage.setItem('yotsuba-legend-seen', '1');
} catch { /* 覚えられなくても、ふつうの大きさで出す */ }

// ── 異常終了の見張りと、診断の表示（src/lib/diag.ts）──
// 1 秒ごとに、経過した秒数・推論の回数・直近の推論の時間・映像の大きさ・待ち・方式を localStorage に書く（alive: true）。
// きれいに終わったら（画面を離れた・見えなくなった）alive: false にする。次に開いたとき alive が true のままなら、
// 前回は強制終了したとみなし、カメラと検出を自動で始めない（案内と「カメラを つかう」を出す。くり返しの強制終了を防ぐ）。
// 続けて CRASHES_TO_PHOTO 回 強制終了したら、写真から探すに切り替える（理由の文を出す。?diag=1 のときは切り替えない）
let watchTimer = 0;
let crashes = 0; // 続けて強制終了した回数（このあと、また強制終了したら +1 される）
const diagBox = __DIAG__ && diag.on ? createDiagBox(document.querySelector('.app--scan')) : null;
function snapshot(alive: boolean) {
  writeSession({
    alive, sec: stats.start ? Math.round((Date.now() - stats.start) / 1000) : 0, infer: stats.infer, ms: stats.ms, gap: intervalMs,
    frameW: video.videoWidth || undefined, frameH: video.videoHeight || undefined,
    crashes: alive ? crashes : 0, // きれいに終わったら、数え直す
    queue: busy ? 1 : 0, backend: backendName || 'loading', model: diag.model, res: diag.res, at: Date.now(),
  });
}
function showDiag(text: string) {
  if (!__DIAG__ || !diagBox) return;
  diagBox.textContent = text;
}
function startWatch() {
  if (!stats.start) stats.start = Date.now();
  clearInterval(watchTimer);
  snapshot(true);
  watchTimer = window.setInterval(() => {
    snapshot(true);
    const s = __DIAG__ && diagBox ? readSession() : null;
    if (s) showDiag(`${s.sec}秒・推論${s.infer}回・${s.ms}ms・間${s.gap ?? '?'}ms${diag.sleep ? '' : '・お休みなし'}・映像${s.frameW ?? '?'}×${s.frameH ?? '?'}・待ち${s.queue}・${s.backend}・${s.model}・${s.res}`);
  }, 1000);
}
function endWatch() {
  clearInterval(watchTimer);
  if (stats.start) snapshot(false);
}

const previous = readSession();
const crashed = previous?.alive === true;
if (crashed) crashes = (previous!.crashes ?? 0) + 1;
if (__DIAG__ && diagBox) showDiag(crashed ? crashSummary({ ...previous!, crashes }) : '診断中');

if (crashed && crashes >= CRASHES_TO_PHOTO && !diag.on) {
  // 続けて強制終了した: 写真から探すに切り替える（理由の文は、写真から探すの画面に出す。次にカメラを開いたときは、ふつうに始める）
  writeSession({ ...previous!, alive: false, crashes: 0 });
  location.replace('photo-pick.html?from=camera');
} else if (crashed) {
  // 前回は、きれいに終わらなかった: 自動では始めない
  stopped = 'camera';
  showStatus();
  document.getElementById('cameraHelpTitle')!.textContent = 'カメラが、止まってしまいました';
  document.getElementById('cameraHelpText')!.textContent = 'もう一度、ためしてください。「カメラを つかう」を押すと、始まります。';
  cameraHelp.hidden = false;
  writeSession({ ...previous!, alive: false, crashes }); // 案内を出したら、次は、ふつうに始める（続けて落ちた回数は覚えておく）
} else {
  startCamera();
}
updateBadge();
