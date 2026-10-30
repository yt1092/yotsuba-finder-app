// ONNX モデル（public/models/）を使う検出器
// 実際の計算は Web Worker（onnx-detector.worker.ts）で行い、ここでは順番の管理だけをする
import {
  FrameSkippedError,
  type Detection, type DetectMode, type DetectOptions, type DetectSource,
  type Detector, type DetectorBackend,
} from './detector';
import type { WorkerRequest, WorkerResponse } from './onnx-detector.worker';

// 検出 1 回分の依頼
interface Job {
  bitmap: ImageBitmap;
  mode: DetectMode;
  tiles: boolean;
  fourThreshold?: number;
  resolve: (detections: Detection[]) => void;
  reject: (error: Error) => void;
}

export class OnnxDetector implements Detector {
  private worker: Worker;
  private ready: Promise<'webgpu' | 'wasm'>;
  private running: Job | null = null; // Worker で検出中の依頼
  private waiting: Job | null = null; // 次に検出する依頼（最新の 1 件だけを待たせる）
  private nextId = 1;
  private jobs = new Map<number, Job>();

  // Worker を起動して、すぐにモデルの読み込みを始める
  // preferWebGPU を false にすると、WebGPU が使える端末でも WASM で動かす（診断用。src/lib/diag.ts）
  // modelUrl を渡すと、そのモデルを使う（診断用。ふだんは detector-config.ts の MODEL_URL）
  constructor({ preferWebGPU = true, modelUrl }: { preferWebGPU?: boolean; modelUrl?: string } = {}) {
    this.worker = new Worker(new URL('./onnx-detector.worker.ts', import.meta.url), { type: 'module' });

    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.type === 'ready') resolve(msg.backend);
        else if (msg.type === 'init-error') reject(new Error(msg.message));
        else this.finish(msg);
      };
    });
    // 開発者向けに、どの実行環境で動いているかをコンソールに出す（画面には出さない）
    // 失敗は detect() の呼び出し側に伝えるので、ここでは未処理エラーにしない
    this.ready.then(b => console.info(`検出器の実行環境: ${b}`), () => {});

    this.send({ type: 'init', preferWebGPU, modelUrl });
  }

  // モデルの読み込みが終わったら、使っている実行環境（webgpu / wasm）を返す
  backend(): Promise<DetectorBackend> {
    return this.ready;
  }

  // 画像を検出する
  // 検出中に次の依頼が来たら、それを待たせる。さらに新しい依頼が来たら、待っていた依頼は
  // FrameSkippedError で取りやめにして、いちばん新しい依頼だけを残す（カメラで古いフレームを溜めないため）
  async detect(source: DetectSource, options: DetectOptions = {}): Promise<Detection[]> {
    // 元の画像を Worker に渡すとこちらで使えなくなるので、コピーを作って渡す
    // （imageOrientation: 'from-image' で、写真の向き情報も反映する）
    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });

    return new Promise<Detection[]>((resolve, reject) => {
      const job: Job = { bitmap, mode: options.mode ?? 'photo', tiles: options.tiles ?? false, fourThreshold: options.fourThreshold, resolve, reject };
      if (!this.running) {
        this.start(job);
      } else {
        if (this.waiting) {
          this.waiting.bitmap.close();
          this.waiting.reject(new FrameSkippedError());
        }
        this.waiting = job;
      }
    });
  }

  // 依頼を Worker に送る（モデルの読み込みが終わるのを待ってから）
  private async start(job: Job) {
    this.running = job;
    try {
      await this.ready;
    } catch (e) {
      job.bitmap.close();
      job.reject(e as Error);
      this.startNext();
      return;
    }
    const id = this.nextId++;
    this.jobs.set(id, job);
    // bitmap は「移動」で渡す（コピーしないので速い）
    this.send({ type: 'detect', id, bitmap: job.bitmap, mode: job.mode, tiles: job.tiles, fourThreshold: job.fourThreshold }, [job.bitmap]);
  }

  // Worker から結果が届いたら、依頼主に返して、待っている依頼を始める
  private finish(msg: Extract<WorkerResponse, { type: 'result' | 'error' }>) {
    const job = this.jobs.get(msg.id);
    this.jobs.delete(msg.id);
    if (job) {
      if (msg.type === 'result') job.resolve(msg.detections);
      else job.reject(new Error(msg.message));
    }
    this.startNext();
  }

  // 待っている依頼があれば始める
  private startNext() {
    this.running = null;
    const next = this.waiting;
    this.waiting = null;
    if (next) this.start(next);
  }

  // Worker にメッセージを送る
  private send(message: WorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer);
  }
}
