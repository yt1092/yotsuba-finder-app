// 検出用の Web Worker
// 画面の処理と別のスレッドでモデルを動かすので、検出中もカメラの映像や操作が止まらない
import * as ort from 'onnxruntime-web/webgpu';
import {
  MODEL_URL, ORT_WASM_PATH, INPUT_SIZE, PAD_VALUE, CLASS_LABELS,
  SCORE_THRESHOLD, NMS_IOU, NMS_SMALLER_OVERLAP, MAX_DETECTIONS, TILE_FRAC,
} from './detector-config';
import type { Detection, DetectMode } from './detector';
import { mergeOverlapping } from './box-utils';

// ── 画面側とやりとりするメッセージの形 ──

export type WorkerRequest =
  | { type: 'init'; preferWebGPU: boolean; modelUrl?: string }
  | { type: 'detect'; id: number; bitmap: ImageBitmap; mode: DetectMode; tiles: boolean; fourThreshold?: number };

export type WorkerResponse =
  | { type: 'ready'; backend: 'webgpu' | 'wasm' }
  | { type: 'init-error'; message: string }
  | { type: 'result'; id: number; detections: Detection[] }
  | { type: 'error'; id: number; message: string };

// 画像の中の範囲（元画像のピクセル座標）
interface Region { x: number; y: number; w: number; h: number }

// レターボックスで縮めたときの情報（元の座標に戻すときに使う）
interface Letterbox { region: Region; scale: number; padX: number; padY: number }

// ── onnxruntime-web の設定 ──

// wasm は自分のサイトの /ort/ から読む（外部通信しない）
// 「https://…/ort/」のような完全な URL にしている理由: 「/ort/」のままだと、開発サーバー（Vite）が
// import の URL に ?import を付け足してしまい、public/ のファイルを読み込めなくなるため
ort.env.wasm.wasmPaths = new URL(ORT_WASM_PATH, self.location.origin).href;
ort.env.wasm.numThreads = 1;            // COOP/COEP を使わないので 1 スレッド

let session: ort.InferenceSession | null = null;

// 前処理で使い回す、キャンバスと入力用の配列（毎回作るとメモリを無駄に使うため）
const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
const inputData = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);

// 画面側にメッセージを送る
function reply(message: WorkerResponse) {
  self.postMessage(message);
}

// WebGPU が使えるかを調べる（ブラウザが対応していて、GPU を借りられるか）
async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) {
    console.info('このブラウザは WebGPU に対応していないため、WASM で動かします');
    return false;
  }
  try {
    if ((await gpu.requestAdapter()) != null) return true;
    console.info('WebGPU のアダプターを取得できなかったため、WASM で動かします');
  } catch (e) {
    console.info('WebGPU のアダプターの取得に失敗したため、WASM で動かします', e);
  }
  return false;
}

// モデルを読み込む。WebGPU を優先し、だめなら WASM で読み込み直す
// （preferWebGPU が false なら、最初から WASM を使う。開発中の確認用）
async function init(preferWebGPU: boolean, modelUrl = MODEL_URL) {
  if (preferWebGPU && (await hasWebGPU())) {
    try {
      session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['webgpu'] });
      reply({ type: 'ready', backend: 'webgpu' });
      return;
    } catch (e) {
      console.warn('WebGPU でモデルを読み込めなかったため、WASM で動かします', e);
    }
  }
  session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  reply({ type: 'ready', backend: 'wasm' });
}

// 前処理: 画像の一部（region）を、縦横比を保ったまま 960×960 に収め（余白は灰色）、
// RGB の順に 0〜1 の数にして、NCHW（色ごとに面を分けた並び）の配列に詰める
function preprocess(bitmap: ImageBitmap, region: Region): Letterbox {
  const scale = Math.min(INPUT_SIZE / region.w, INPUT_SIZE / region.h);
  const drawW = Math.round(region.w * scale);
  const drawH = Math.round(region.h * scale);
  const padX = Math.floor((INPUT_SIZE - drawW) / 2);
  const padY = Math.floor((INPUT_SIZE - drawH) / 2);

  ctx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(bitmap, region.x, region.y, region.w, region.h, padX, padY, drawW, drawH);

  const pixels = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data; // RGBA の順に並んだ配列
  const area = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < area; i++) {
    inputData[i] = pixels[i * 4] / 255;                // R の面
    inputData[area + i] = pixels[i * 4 + 1] / 255;     // G の面
    inputData[2 * area + i] = pixels[i * 4 + 2] / 255; // B の面
  }
  return { region, scale, padX, padY };
}

// 後処理: 出力 [1, 6, 18900] を読み、しきい値以上の候補を元画像の座標の枠にする
// 6 の内訳は「中心x, 中心y, 幅, 高さ（960px の入力上）, 四つ葉のスコア, 三つ葉のスコア」
// しきい値は、四つ葉と三つ葉で別（四つ葉だけ、使う人に合わせて少し動かす。src/lib/tuning.ts）
interface Thresholds { four: number; other: number }
function decode(output: ort.Tensor, lb: Letterbox, threshold: Thresholds, imageW: number, imageH: number): Detection[] {
  const [, channels, count] = output.dims as number[];
  const data = output.data as Float32Array;
  const classCount = channels - 4;
  const found: Detection[] = [];

  for (let i = 0; i < count; i++) {
    // いちばんスコアの高いクラスを選ぶ
    let score = 0;
    let cls = -1;
    for (let c = 0; c < classCount; c++) {
      const s = data[(4 + c) * count + i];
      if (s > score) { score = s; cls = c; }
    }
    if (cls < 0 || score < (CLASS_LABELS[cls] === '四つ葉' ? threshold.four : threshold.other)) continue;

    // 入力画像（960px）上の座標 → 余白を引いて縮小を戻す → タイルの位置を足して元画像の座標へ
    const cx = data[i], cy = data[count + i], w = data[2 * count + i], h = data[3 * count + i];
    const x0 = lb.region.x + (cx - w / 2 - lb.padX) / lb.scale;
    const y0 = lb.region.y + (cy - h / 2 - lb.padY) / lb.scale;
    const x1 = lb.region.x + (cx + w / 2 - lb.padX) / lb.scale;
    const y1 = lb.region.y + (cy + h / 2 - lb.padY) / lb.scale;

    // 画像の外にはみ出した分は切り取る
    const left = Math.max(0, x0), top = Math.max(0, y0);
    const right = Math.min(imageW, x1), bottom = Math.min(imageH, y1);
    if (right <= left || bottom <= top) continue;

    found.push({
      bbox: { x: left, y: top, w: right - left, h: bottom - top },
      label: CLASS_LABELS[cls],
      score,
    });
  }
  return found;
}

// NMS: 同じ物とみなした枠を 1 つにまとめる（スコアの高いほうを残す。クラスが違っても同様）
// 同じ物とみなすのは、IoU が NMS_IOU を超えるときと、
// 小さいほうの枠に対する重なりが NMS_SMALLER_OVERLAP 以上のとき（タイルの境目で、同じ葉に枠が 2 つ付くのを防ぐ）
function nms(detections: Detection[]): Detection[] {
  return mergeOverlapping(detections, { iou: NMS_IOU, smallerOverlap: NMS_SMALLER_OVERLAP, maxCount: MAX_DETECTIONS });
}

// 2×2 のタイルの範囲を返す。各タイルは元画像の TILE_FRAC（60%）で、重なりは 20% 以上
// （幅は切り上げて、重なりが 20% を下回らないようにする）
function tileRegions(width: number, height: number): Region[] {
  const tw = Math.ceil(width * TILE_FRAC);
  const th = Math.ceil(height * TILE_FRAC);
  const xs = [0, width - tw];
  const ys = [0, height - th];
  return ys.flatMap(y => xs.map(x => ({ x, y, w: tw, h: th })));
}

// 画像の 1 つの範囲について、前処理 → 推論 → 後処理 を行う
// 入力と出力の Tensor は、使い終わったら必ず dispose する（WebGPU では、端末のメモリを持ったままになるため）
async function detectRegion(bitmap: ImageBitmap, region: Region, threshold: Thresholds): Promise<Detection[]> {
  const lb = preprocess(bitmap, region);
  const input = new ort.Tensor('float32', inputData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  let outputs: ort.InferenceSession.OnnxValueMapType | null = null;
  try {
    outputs = await session!.run({ [session!.inputNames[0]]: input });
    return decode(outputs[session!.outputNames[0]] as ort.Tensor, lb, threshold, bitmap.width, bitmap.height);
  } finally {
    input.dispose();
    if (outputs) for (const t of Object.values(outputs)) (t as ort.Tensor).dispose?.();
  }
}

// 1 枚の画像を検出する。tiles なら、全体とタイル 4 枚の結果を合わせてから NMS でまとめる
async function detect(bitmap: ImageBitmap, mode: DetectMode, tiles: boolean, fourThreshold?: number): Promise<Detection[]> {
  const threshold: Thresholds = { four: fourThreshold ?? SCORE_THRESHOLD[mode], other: SCORE_THRESHOLD[mode] };
  const full: Region = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  const regions = tiles ? [full, ...tileRegions(bitmap.width, bitmap.height)] : [full];

  const all: Detection[] = [];
  for (const region of regions) {
    all.push(...(await detectRegion(bitmap, region, threshold)));
  }
  return nms(all);
}

// 画面側からのメッセージを受け取る
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    try {
      await init(msg.preferWebGPU, msg.modelUrl);
    } catch (e) {
      reply({ type: 'init-error', message: String(e) });
    }
    return;
  }

  if (msg.type === 'detect') {
    try {
      if (!session) throw new Error('モデルが読み込まれていません');
      const detections = await detect(msg.bitmap, msg.mode, msg.tiles, msg.fourThreshold);
      reply({ type: 'result', id: msg.id, detections });
    } catch (e) {
      reply({ type: 'error', id: msg.id, message: String(e) });
    } finally {
      msg.bitmap.close(); // 使い終わった画像のメモリを解放する
    }
  }
};
