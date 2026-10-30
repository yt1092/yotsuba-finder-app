// 「今日のよつば」の設定（作者の決定 2026-10-28。iPhone で測った結果: docs/reports/2026-10-28-gacha-bench2.md）
// - モデル: 仕上げ前（数式で作った形だけで学習したもの）・FP32・4 歩・CFG なし（training/gacha_export_onnx.py）
// - バックエンド: WASM（WebGPU は使わない）
// - モデルが端末に無ければ、ひいたときに、その場で取る。通信できない・取れない・読み込みや推論の失敗・
//   9 回作っても妥当にならない・時間切れのときだけ、あらかじめ作った 60 枚から、種で 1 枚
// モデルを変えたら、ファイル名を変える（Service Worker が、モデル用キャッシュの古い版を消す。sw/sw.js）

export const GACHA_MODEL_URL = '/models/gacha-pretrain-fp32.onnx';
export const GACHA_BACKEND = 'wasm' as const;
export const DOWNLOAD_TIMEOUT_MS = 60_000; // モデルが端末に無いときに、その場で取る時間（16MB。決めた 20 秒・5 秒とは別に足した）
export const LOAD_TIMEOUT_MS = 20_000;     // ワーカーを作ってから、モデルを読み込み終わるまで
export const GENERATE_TIMEOUT_MS = 5_000;  // 読み込んでから、作り直しをふくめて、形ができるまで
export const STEP_SHOW_MS = 500;           // 「つくっている間」に、途中の形を 1 つ見せる時間（4 つで 約 2 秒）

// モデルが、この端末のキャッシュにあるか（Service Worker のモデル用キャッシュ。設定の画面の「今日のよつばのモデル」）
export async function gachaModelReady(): Promise<boolean> {
  try {
    return typeof caches !== 'undefined' && !!(await caches.match(GACHA_MODEL_URL));
  } catch {
    return false;
  }
}
