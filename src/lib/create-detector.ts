// 設定に合わせて、使う検出器（ONNX かダミー）を作る
import { DETECTOR_KIND } from './detector-config';
import { DummyDetector, type Detector } from './detector';
import { OnnxDetector } from './onnx-detector';
import { diag } from './diag';

// 開発中（npm run dev）だけ、URL のパラメータで切り替えられるようにする
//   ?detector=dummy … ダミーの検出器を使う
function devParam(name: string): string | null {
  return import.meta.env.DEV ? new URLSearchParams(location.search).get(name) : null;
}

// 検出器を作る。ONNX の場合は、この時点でモデルの読み込みが始まる
// use: 'camera'（カメラ。WASM で動かす。WebGPU は ?backend=webgpu のときだけ。detector-config.ts の「カメラ」の節）
//      'photo'（写真から探す。WebGPU を優先し、使えなければ WASM。?backend=wasm なら WASM）
// 診断用の ?backend=wasm|webgpu・?model=v3|mix|fp16 は、プレビューと手元のビルドでだけ効く（src/lib/diag.ts。本番とパラメータが無いときは、ふだんどおり）
export function createDetector(use: 'camera' | 'photo'): Detector {
  const kind = devParam('detector') ?? DETECTOR_KIND;
  if (kind === 'dummy') return new DummyDetector();
  const preferWebGPU = use === 'camera' ? diag.backend === 'webgpu' : diag.backend !== 'wasm';
  return new OnnxDetector({ preferWebGPU, modelUrl: diag.modelUrl });
}
