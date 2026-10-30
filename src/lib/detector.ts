// 検出結果の1件を表す型
export interface Detection {
  bbox: { x: number; y: number; w: number; h: number }; // 元画像内の座標（px）
  label: '四つ葉' | '三つ葉';
  score?: number; // モデルの自信の度合い（内部の判定用。画面には表示しない）
  // 四つ葉の「候補」（写真から探したとき、時間の上限で、まだ確かめていないもの）。
  // 確かめて通ったら外す。この印が無い四つ葉は、確かめて通ったもの（または、前のアプリで保存したもの）
  candidate?: boolean;
}

// 検出する場面。しきい値の選び方が変わる
export type DetectMode = 'camera' | 'photo';

// 検出のオプション
export interface DetectOptions {
  mode?: DetectMode; // 省略時は 'photo'
  tiles?: boolean;   // true なら、全体に加えて 2×2 のタイルでも検出し、結果をまとめる
  fourThreshold?: number; // 四つ葉だけのしきい値（使う人に合わせた調整。src/lib/tuning.ts）。省略時は場面ごとの値
}

// 検出に渡せる画像の種類
export type DetectSource = HTMLVideoElement | HTMLImageElement | ImageBitmap;

// 検出器がどの方法で動いているか（画面には出さない）
export type DetectorBackend = 'webgpu' | 'wasm' | 'dummy';

// 検出器のインターフェース（DummyDetector と OnnxDetector を差し替えられる）
export interface Detector {
  detect(source: DetectSource, options?: DetectOptions): Promise<Detection[]>;
  backend(): Promise<DetectorBackend>; // 準備ができたら、使っている実行環境を返す
}

// カメラの検出で、より新しいフレームに順番を譲ったときのエラー（無視してよい）
export class FrameSkippedError extends Error {
  constructor() {
    super('より新しいフレームを優先したため、このフレームの検出は取りやめました');
    this.name = 'FrameSkippedError';
  }
}

// 画像の幅と高さを取り出す（種類ごとに、持っているプロパティが違う）
export function sourceSize(source: DetectSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
  if (source instanceof HTMLImageElement) return { w: source.naturalWidth, h: source.naturalHeight };
  return { w: source.width, h: source.height };
}

// ダミー実装（ランダムな結果を返す。モデルなしで画面の動きを確かめる開発用）
export class DummyDetector implements Detector {
  private frameCount = 0;

  async backend(): Promise<DetectorBackend> {
    return 'dummy';
  }

  async detect(source: DetectSource, options: DetectOptions = {}): Promise<Detection[]> {
    this.frameCount++;
    const { w, h } = sourceSize(source);

    if ((options.mode ?? 'photo') === 'photo') {
      // 写真解析：800ms 待機して結果を返す演出
      await new Promise<void>(r => setTimeout(r, 800));
      // 50% で四つ葉あり
      return this.makeResult(w, h, Math.random() > 0.5);
    }

    // カメラ：最初の 90 回（約3秒）は何も返さない
    if (this.frameCount < 90) return [];

    // 四つ葉は一度出たら 10 回続けて同じ位置に出す（確定の流れを確かめられるように）
    const rand = Math.random();
    if (this.frameCount % 200 < 10) return this.makeResult(w, h, true);
    if (rand < 0.2) return this.makeResult(w, h, false); // 20% で三つ葉のみ
    return [];
  }

  // 四つ葉（あれば）と、1〜2 個の三つ葉の結果を作る
  private makeResult(w: number, h: number, includeFour: boolean): Detection[] {
    const result: Detection[] = [];
    if (includeFour) {
      result.push({
        bbox: { x: w * 0.35, y: h * 0.30, w: w * 0.30, h: h * 0.30 },
        label: '四つ葉',
        score: 0.9,
      });
    }
    const n = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < n; i++) {
      result.push({
        bbox: {
          x: Math.random() * w * 0.5 + w * 0.05,
          y: Math.random() * h * 0.4 + h * 0.05,
          w: w * 0.18,
          h: h * 0.18,
        },
        label: '三つ葉',
        score: 0.6,
      });
    }
    return result;
  }
}
