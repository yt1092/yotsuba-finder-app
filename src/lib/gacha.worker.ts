// 「今日のよつば」の Web Worker: DiT（1 歩ぶんの ONNX）で、今日の形を作る
// - 1 つのワーカーで、モデルは 1 つだけ・セッションは 1 回だけ作る（iPhone で、2 つ目のモデルの読み込みが
//   「Out of memory」になったため。docs/reports/2026-10-28-gacha-bench2.md）
// - 推論は 1 つずつ・入力と出力のテンソルは毎回 dispose・できたら session.release() してから返事をする
//   （返事を受け取った画面は、すぐにワーカーを止める。src/lib/gacha-maker.ts）
// - バックエンドは WASM（WebGPU は使わない。作者の決定 2026-10-28）。wasm は検出と同じ /ort/<版>/ から読む
// - モデルは、画面の側が取って（キャッシュか、その場で通信して）、中身を渡す。ワーカーは、モデルを取りにいかない
//   （ワーカーの中の通信は、Safari で Service Worker を通らないことがあり、キャッシュに入らない・オフラインで読めないため）
import * as ort from 'onnxruntime-web/webgpu';
import { ORT_WASM_PATH } from './detector-config';
import { GACHA_BACKEND } from './gacha-config';
import { STEPS, dailyShape, eulerSample, noise } from './gacha-gen.ts';

// model: モデルの中身（ONNX）・seeds: 作り直しの番号 0〜8 の種（src/lib/gacha-seed.ts の mixSeed）
export type GachaWorkerRequest = { type: 'make'; model: ArrayBuffer; seeds: number[] };

export type GachaWorkerResponse =
  | { type: 'loaded' }
  // dit: 妥当な形と、その形を作ったときの、1 歩ごとの途中の形（4 つ。0〜1）
  | { type: 'done'; kind: 'dit'; mask: Uint8Array; steps: Float32Array[] }
  // 9 回作っても、妥当な形にならなかった
  | { type: 'done'; kind: 'none' }
  | { type: 'error'; stage: 'load' | 'generate'; message: string };

ort.env.wasm.wasmPaths = new URL(ORT_WASM_PATH, self.location.origin).href;
ort.env.wasm.numThreads = 1; // COOP/COEP を使わないので 1 スレッド

let started = false;

function reply(msg: GachaWorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer); // ワーカーの中の postMessage（型は Window のものになっているため）
}

self.onmessage = async (event: MessageEvent<GachaWorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== 'make' || started) return; // 1 つのワーカーで 1 回だけ
  started = true;

  let session: ort.InferenceSession;
  try {
    session = await ort.InferenceSession.create(new Uint8Array(msg.model), { executionProviders: [GACHA_BACKEND] });
  } catch (e) {
    reply({ type: 'error', stage: 'load', message: String(e) });
    return;
  }
  reply({ type: 'loaded' });

  // 1 歩ぶん: x と t から、向き v。使ったテンソルは、すぐ解放する
  const step = async (x: Float32Array, t: number): Promise<Float32Array> => {
    const xt = new ort.Tensor('float32', Float32Array.from(x), [1, 1, 64, 64]);
    const tt = new ort.Tensor('float32', Float32Array.of(t), [1]);
    try {
      const out = await session.run({ x: xt, t: tt });
      const v = Float32Array.from(out.v.data as Float32Array);
      out.v.dispose();
      return v;
    } finally {
      xt.dispose();
      tt.dispose();
    }
  };

  try {
    let lastSteps: Float32Array[] = [];
    const result = await dailyShape(k => msg.seeds[k], async seed => {
      const steps: Float32Array[] = [];
      const out = await eulerSample(step, noise(seed), STEPS, x => steps.push(x));
      lastSteps = steps; // 妥当な形が出たら、それが最後に作った形
      return out;
    });
    await session.release();
    if (result.kind === 'dit') {
      reply({ type: 'done', kind: 'dit', mask: result.mask, steps: lastSteps }, [result.mask.buffer, ...lastSteps.map(s => s.buffer)]);
    } else {
      reply({ type: 'done', kind: 'none' });
    }
  } catch (e) {
    await session.release().catch(() => undefined);
    reply({ type: 'error', stage: 'generate', message: String(e) });
  }
};
