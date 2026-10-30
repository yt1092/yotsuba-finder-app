// カメラの診断用の URL パラメータ（iPhone の実機で、強制終了の原因を絞り込むため）
// プレビューと手元のビルドにだけ入る（__DIAG__。vite.config.ts）。本番のビルドでは、パラメータを読まず、診断の表示のコードも入らない
// パラメータが無いときは、ふだんの動きのまま。画面に数字を出すのは ?diag=1 のときだけ
// 落ちたあとの見張り（readSession・writeSession・CRASHES_TO_PHOTO）は、本番でも動く
//   ?diag=1            … 画面の端に、1 秒ごとに、経過した秒数・推論の回数・1 回の推論の時間（ms）・次までの間・映像の大きさ・待ち・方式を出す。
//                        前回が強制終了なら「前回は◯秒で止まりました。そのときの推論は…」を出す（数字が出るのは ?diag=1 のときだけ）
//   ?backend=webgpu|wasm … カメラは、ふだん WASM。webgpu にすると、WebGPU で動かす（診断用）。写真から探すは、ふだん WebGPU
//   ?interval=300      … 推論が終わってから、次の推論までの間（ms。300 より短くはしない。無ければ、WASM は実測から決める。src/lib/scan-pace.ts）
//   ?sleep=0           … 90 秒の自動のお休みをしない（3 分続けて動かす診断のため。?diag=1 のときだけ効く）
//   ?repeat=10         … 写真から探すで、選んだ写真を、続けて 10 回検出する（1〜20。?diag=1 のときだけ。結果の画面には進まず、記録もしない）
//   ?res=640|1280      … カメラの解像度の上限（640 = 640×480・1280 = 1280×720。既定は 1280）
//   ?boxes=0           … 枠を描かない
//   ?rings=0           … 進み具合の輪を描かない
//   ?infer=0           … 検出を止めて、映像だけを出す
//   ?model=v3|mix|fp16 … モデル（mix = 今のモデル。v3・fp16 は public/models/diag/）
import { MODEL_URL } from './detector-config';

const p = (() => {
  if (!__DIAG__) return new URLSearchParams(); // 本番: パラメータを読まない（いつも、ふだんの動き）
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
})();

const num = (name: string): number | undefined => {
  const v = Number(p.get(name));
  return p.has(name) && Number.isFinite(v) && v > 0 ? v : undefined;
};

export const MIN_GAP_MS = 300; // 推論が終わってから、次の推論まで、最低これだけあける

const MODELS: Record<string, string> = __DIAG__ ? {
  mix: MODEL_URL,
  v3: '/models/diag/yotsuba-v3.onnx',
  fp16: '/models/diag/yotsuba-v5mix-fp16.onnx',
} : {};

export const diag = {
  on: __DIAG__ && p.get('diag') === '1',
  backend: p.get('backend') === 'wasm' || p.get('backend') === 'webgpu' ? (p.get('backend') as 'wasm' | 'webgpu') : undefined,
  intervalMs: num('interval') !== undefined ? Math.max(MIN_GAP_MS, num('interval')!) : undefined,
  res: p.get('res') === '640' ? 640 : 1280,
  boxes: p.get('boxes') !== '0',
  rings: p.get('rings') !== '0',
  infer: p.get('infer') !== '0',
  sleep: !(p.get('diag') === '1' && p.get('sleep') === '0'),
  repeat: p.get('diag') === '1' && num('repeat') !== undefined ? Math.min(20, Math.floor(num('repeat')!)) : 0,
  model: p.get('model') ?? 'mix',
  modelUrl: MODELS[p.get('model') ?? ''] ?? MODEL_URL,
};

// カメラの解像度（上限）。iPhone のメモリを使いすぎないように、1280×720 まで
export const cameraSize = (): { width: number; height: number } =>
  diag.res === 640 ? { width: 640, height: 480 } : { width: 1280, height: 720 };

// ── 異常終了の見張り（前回、きれいに終わらなかったら、次は自動で始めない）──

const SESSION_KEY = 'yotsuba-scan-session';

// 1 秒ごとに書く（落ちる前の状態を、あとから読めるように）
export interface ScanSession {
  alive: boolean;   // 動いている（きれいに終わったら false）
  sec: number;      // 経過した秒数
  infer: number;    // 推論の回数
  ms: number;       // 直近の 1 回の推論の時間（ms）
  gap?: number;     // 次の推論までの間（ms）
  frameW?: number;  // 映像の 1 コマの大きさ（video.videoWidth × videoHeight）
  frameH?: number;
  crashes?: number; // 続けて強制終了した回数（2 回目で、写真から探すに切り替える）
  queue: number;    // 待ち（今は 0 か 1）
  backend: string;  // 方式
  model: string;
  res: number;
  at: number;       // 書いた時刻
}

export function readSession(): ScanSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as ScanSession) : null;
  } catch {
    return null;
  }
}

export function writeSession(s: ScanSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch { /* 書けなくても、続ける */ }
}

// 続けて強制終了したら、写真から探すに切り替える回数（1 回目は「カメラを つかう」の案内。2 回目で切り替える）
export const CRASHES_TO_PHOTO = 2;
// 写真から探すに切り替えたことを、写真から探すの画面に伝える（?from=camera）
export const PHOTO_FALLBACK_TEXT = 'カメラが 不安定なので、写真から探すに 切り替えました。写真を 1枚 えらぶと、四つ葉を 探します。';

// 前回の強制終了のようす（?diag=1 のときだけ画面に出す）
export function crashSummary(s: ScanSession): string {
  const frame = s.frameW && s.frameH ? `・映像 ${s.frameW}×${s.frameH}` : '';
  const gap = s.gap ? `・間 ${s.gap}ms` : '';
  return `前回は ${s.sec}秒で 止まりました。そのときの推論は ${s.infer}回・直近 ${s.ms}ms${gap}${frame}・${s.backend}・${s.model}（続けて ${s.crashes ?? 1}回目）`;
}

// 診断の表示の箱（画面の左下。?diag=1 のときだけ作る）
export function createDiagBox(parent: Element | null): HTMLElement {
  const box = document.createElement('div');
  box.className = 'diag-box';
  Object.assign(box.style, {
    position: 'fixed', left: '8px', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 4px)', zIndex: '30',
    padding: '2px 6px', borderRadius: '6px', font: '12px monospace', color: '#fff',
    background: 'rgba(0,0,0,0.55)', pointerEvents: 'none', whiteSpace: 'pre-wrap', maxWidth: 'calc(100% - 16px)',
  });
  parent?.append(box);
  return box;
}

// ── 写真から探すを、同じ写真で続けて検出する診断（?diag=1&repeat=10。src/pages/photo-pick.ts）──
// 1 回終わるごとに書く。途中で強制終了したら、次に開いたとき「前回は◯回目で止まりました」を出す

const REPEAT_KEY = 'yotsuba-photo-repeat';

export interface PhotoRepeat {
  alive: boolean;   // 続けている（終わったら false）
  done: number;     // 終わった回数
  total: number;    // 続ける回数
  ms: number[];     // 1 回ごとの時間（ms。全体とタイルをまとめた 1 回の検出）
  backend: string;
  at: number;
}

export function readRepeat(): PhotoRepeat | null {
  try {
    const raw = localStorage.getItem(REPEAT_KEY);
    return raw ? (JSON.parse(raw) as PhotoRepeat) : null;
  } catch {
    return null;
  }
}

export function writeRepeat(r: PhotoRepeat): void {
  try {
    localStorage.setItem(REPEAT_KEY, JSON.stringify(r));
  } catch { /* 書けなくても、続ける */ }
}

// 続けて検出したようす（?diag=1 のときだけ画面に出す）
export function repeatSummary(r: PhotoRepeat, previous = false): string {
  const avg = r.ms.length ? Math.round(r.ms.reduce((a, b) => a + b, 0) / r.ms.length) : 0;
  const times = `1回ごと ${r.ms.join('・')}ms（平均 ${avg}ms）・${r.backend}`;
  if (previous && r.alive) return `前回は ${r.done + 1}回目の 途中で 止まりました（${r.total}回のうち ${r.done}回 終わっていた）。${times}`;
  if (r.alive) return `同じ写真で ${r.done}/${r.total}回・${times}`;
  return `${r.total}回 続けて 終わりました（落ちませんでした）。${times}`;
}
