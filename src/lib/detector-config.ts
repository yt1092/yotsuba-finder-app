// 検出まわりの設定をまとめたファイル
// しきい値などの数値は内部でだけ使い、画面には表示しない（CLAUDE.md のルール1）

// ── モデルと実行環境 ──

// モデルの置き場所（public/models/ に置いたファイルを、自分のサイトから配る）
// v3（2026-10-23）: v2 に、三つ葉を四つ葉と間違えやすい写真（iNaturalist のカタバミ・シロツメクサ）を足して学習し直したもの
// v5mix = v3 と v4 の重みを混ぜたもの（v4 が 25%。training/mix_models.py。README の「v3 と v4 の重みを混ぜる」）
// v3 に戻すときは、README の「モデルを v3 に戻す」
export const MODEL_URL = '/models/yotsuba-v5mix.onnx';

// onnxruntime-web の wasm の置き場所（npm run dev / build の前に public/ort/<版>/ へコピーされる）
// 版をフォルダ名に入れるのは、onnxruntime-web を更新したときに URL が変わるようにするため
// （ブラウザやサービスワーカーに残った古い wasm が使われないように）
export const ORT_WASM_PATH = `/ort/${__ORT_VERSION__}/`;

// 使う検出器。'dummy' にするとモデルを使わないダミーになる（開発用）
// 開発中は URL に ?detector=dummy を付けても切り替えられる
export const DETECTOR_KIND: 'onnx' | 'dummy' = 'onnx';

// ── モデルの入出力 ──

export const INPUT_SIZE = 960;   // モデルに入れる画像の大きさ（960×960）
export const PAD_VALUE = 114;    // レターボックスの余白の色（灰色。学習時と同じ）
export const CLASS_LABELS = ['四つ葉', '三つ葉'] as const; // クラス番号 0, 1 の名前

// ── 後処理 ──

// これ未満のスコアの枠は捨てる。カメラは誤検出を減らすため高め、写真は見逃しを減らすため低め
// （あとで実機で調整する）
export const SCORE_THRESHOLD = { camera: 0.5, photo: 0.4 } as const;

export const NMS_IOU = 0.5;        // IoU がこの値を超えた枠は、同じ葉として 1 つにまとめる
// 小さいほうの枠に対する重なり（重なった面積 ÷ 小さいほうの面積）がこの値以上の枠も、同じ葉としてまとめる
// （タイルの境目で、同じ葉に「全体の枠」と「切れた一部の枠」が付くと、IoU は小さいがこちらは大きくなる）
export const NMS_SMALLER_OVERLAP = 0.6;
export const MAX_DETECTIONS = 100; // 1 回の検出で返す枠の最大数

// ── タイル検出（写真・群生地モード）──

// タイル 1 枚 = 元画像の幅・高さの 80%（拡大は 1.25 倍）
// 60%（拡大 1.67 倍）より、三つ葉を四つ葉と間違えることが減る（三つ葉だけの写真 100 枚で 520 → 412 個）。
// 本物の四つ葉は、ほとんど同じだけ見つかる（131 → 129 個）。2026-10-23 の測定（README の「写真から探す」の節）
export const TILE_FRAC = 0.8;

// ── 確認ステップ（写真から探すの結果・図鑑の詳細）──

// true: 四つ葉の枠をタップしたシートに「確かめる」を出し、写真から探したあとに、四つ葉の候補を自動で確かめる
//       （大きさを 3 通りに変えて判定し直す。src/lib/verify-crops.ts）
// false: 確かめない。検出した四つ葉を、そのまま四つ葉として出し、自動で保存する。
//        枠をタップすると、拡大して見せるだけにする（判定のことば・ボタンは出さない）
// v3 からは false（コードは残す）。v3 の学習に足した窓が「確かめる」の切り抜きと同じ作りなので、
// v3 で確かめると、本物の四つ葉まで落としてしまう（残るのが 73.3%。確かめなければ 96.2%）。README の「写真から探す」の節
// 以下は v2 での決め方と測定:
// 決め方: 本物の四つ葉の 85% 以上が「四つ葉のようです」に残り、誤検出の 30% 以上が「よく見て、確かめてください」に落ちること
// 測定（2026-10-22、yotsuba-v2、正解の四つ葉 199 個・写真 167 枚。v2 の学習に使っていない写真）:
//   3 回とも四つ葉   → 本物が残る 77.7%（101/130）、誤検出が落ちる 78.4%（87/111）。目安に届かない
//   3 回中 2 回以上 → 本物が残る 87.7%（114/130）、誤検出が落ちる 54.1%（60/111）。こちらを採用（README の「確かめる」の節）
export const VERIFY_STEP = false;

// （VERIFY_STEP が true のときだけ）写真から探したあと、四つ葉の候補を、自動で確かめる（スコアの高い順。src/lib/auto-verify.ts）
// 確かめて通ったものだけを「四つ葉」として出し、図鑑に自動で保存する。この時間を超えそうなら、残りは「候補」のままにする
// （WASM で 1 つ約 1.3 秒・WebGPU で約 0.25 秒。この PC での測定）
export const AUTO_VERIFY_BUDGET_MS = 10_000;

// （VERIFY_STEP が true のときだけ。v3 では使わない）四つ葉の候補がこの数を超える写真（カタバミが一面に生えた写真など、三つ葉を四つ葉と間違えやすい写真）では、
// 「確かめる」を厳しくする（3 回とも四つ葉のときだけ通す。src/lib/verify-crops.ts の VERIFY_NEEDED_STRICT）
export const MANY_CANDIDATES = 5;

// ── 確認のポップアップの「たしかさのめやす」（3 段階。数字は画面に出さない。src/lib/four-review.ts）──
// モデルのスコアは確率ではない（スコア 0.5〜0.6 の枠は、本物が 2 割ほど）。そのため、実測で境目を決めた
// training/calibrate.py（2026-10-27、yotsuba-v5mix、写真から探すと同じ処理。学習に使っていない写真 322 枚の、四つ葉の枠 239 個）:
// 写真の単位で半分に分け（v3 のときと同じ分け方。training/calibration/split.json）、較正用の半分で境目を選び、
// 評価用の半分で、本物の割合と 95% の下限（片側の Clopper-Pearson）を出した
//   high 以上       … 評価用で 14/16 が本物（下限 66%）  → ●●● 高め
//   mid 以上 high 未満 … 評価用で 37/68 が本物（下限 44%） → ●●○ ふつう（較正用では下限 50% だったが、評価用では届かなかった）
//   mid 未満         … 評価用で 11/37 が本物（上限 44%） → ●○○ 低め
// モデルを変えたら、python training/calibrate.py <モデル> --apply で測り直す（README の「たしかさのめやす」の節）
export const CONFIDENCE_LEVELS = { high: 0.875, mid: 0.687 } as const;

// ── カメラ（Scan 画面）──

// カメラの解像度は 1280×720 まで（src/lib/diag.ts の cameraSize。以前の 1920×1080 では、iPhone の Safari が強制終了した）

// カメラの検出の実行環境は WASM（2026-10-29 から。どの端末でも。WebGPU は、診断用の ?backend=webgpu のときだけ。src/lib/create-detector.ts）
// iPhone の Safari の実機（本番）での診断: WebGPU は、間隔 300ms（推論 約 25 回）でも 1000ms（約 9 回）でも、約 10 秒で強制終了した。
// 映像だけ（推論なし）は 60 秒、WASM は 75 秒（推論 31 回・1 回 391ms）で止まらなかった（docs/reports/2026-10-29-camera-wasm.md）
// 写真から探すは、WebGPU のまま（WebGPU が使えなければ WASM）

// 推論が終わってから、次の推論までの間（ミリ秒）。前の推論が終わるまでは、次のコマを作らない（src/pages/scan.ts）
// WebGPU（診断用）とダミーは 300ms。以前は「100ms ごとにコマを作る」で、iPhone で強制終了した
export const SCAN_INTERVAL_MS = { webgpu: 300, dummy: 300 } as const;

// WASM の間は、実測から決める（src/lib/scan-pace.ts の WASM_PACE。Node.js のテストから読めるように、そちらに置く）

// 群生地モード: true にすると、CLUSTER_TILE_EVERY 回に 1 回、タイル検出を混ぜる
export const CLUSTER_MODE = false;
export const CLUSTER_TILE_EVERY = 10;

// 四つ葉の確定: 直近 CONFIRM_WINDOW 回の検出のうち CONFIRM_HITS 回以上、
// ほぼ同じ位置（IoU が SAME_POSITION_IOU 以上）に四つ葉が出たら確定する
export const CONFIRM_WINDOW = 5;
export const CONFIRM_HITS = 3;
export const SAME_POSITION_IOU = 0.3;

// 保存したあと、次の保存までに最低限空ける時間（ミリ秒）
export const SAVE_COOLDOWN_MS = 5000;

// 保存したあと、四つ葉が続けてこの回数見えなくなったら「視界から外れた」とみなす
export const CLEAR_DETECTIONS = 3;
