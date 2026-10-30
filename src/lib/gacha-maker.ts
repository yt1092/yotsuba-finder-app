// 「今日のよつば」: ワーカー（src/lib/gacha.worker.ts）で、今日の形を作る（画面の側）
// - 画面ごとに、ワーカー 1 つ・セッション 1 つ。形ができたら（失敗しても）、すぐにワーカーを止める
// - モデルは、画面の側が取って、中身をワーカーに渡す（作者の決定 2026-10-28）
//   1. Service Worker のモデル用キャッシュにあれば、それを使う（オフラインでも作れる）
//   2. 無くて、通信できれば、その場で取る（「準備しています」。取ったモデルは Service Worker がキャッシュに入れる）
//   3. 通信できない・取れない・時間切れのときだけ、60 枚から出す
// - 時間切れ: モデルを取る DOWNLOAD_TIMEOUT_MS・読み込み LOAD_TIMEOUT_MS・生成 GENERATE_TIMEOUT_MS
// - 読み込みに失敗しても、同じページで、別のモデルを読み直さない（呼ぶ側も、1 回の表示で 1 回だけ呼ぶ）
import { DOWNLOAD_TIMEOUT_MS, GACHA_MODEL_URL, GENERATE_TIMEOUT_MS, LOAD_TIMEOUT_MS } from './gacha-config';
import type { GachaWorkerResponse } from './gacha.worker';

export type MakeResult =
  | { kind: 'dit'; mask: Uint8Array; steps: Float32Array[] }
  // preset に切り替える理由（開発の確認用。画面には出さない）
  | { kind: 'preset'; why: 'offline' | 'download' | 'timeout-download' | 'load' | 'generate' | 'invalid' | 'timeout-load' | 'timeout-generate' };

// 「準備しています」（モデルを取っている）→「つくっています」（読み込みと生成）
export type MakeStage = 'preparing' | 'making';

let current: { cancel: () => void } | null = null;
let epoch = 0; // stopMaking のたびに増える（待っているあいだに止められたかを見る）

// 作っている途中なら止める（画面を離れるとき・形ができたとき）。止めたあとの返事は、使わない
export function stopMaking(): void {
  epoch++;
  const c = current;
  current = null;
  c?.cancel(); // モデルを取っている途中なら通信を止め、ワーカーがあれば terminate する
}

// モデルの中身: キャッシュにあればそれ、無ければ（通信できれば）その場で取る。取れなければ、理由
async function modelBytes(onStage: (s: MakeStage) => void, mine: number): Promise<ArrayBuffer | MakeResult | null> {
  try {
    const hit = typeof caches !== 'undefined' ? await caches.match(GACHA_MODEL_URL) : undefined;
    if (hit) return await hit.arrayBuffer();
  } catch { /* キャッシュが読めない → 取りにいく */ }
  if (mine !== epoch) return null;
  if (navigator.onLine === false) return { kind: 'preset', why: 'offline' };

  onStage('preparing');
  const abort = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; abort.abort(); }, DOWNLOAD_TIMEOUT_MS);
  current = { cancel: () => abort.abort() };
  try {
    // 自分のサイトから取る（Service Worker を通るので、取ったものはモデル用キャッシュに入る。sw/sw.js）
    const res = await fetch(GACHA_MODEL_URL, { signal: abort.signal });
    if (!res.ok) return { kind: 'preset', why: 'download' };
    return await res.arrayBuffer();
  } catch {
    if (mine !== epoch) return null; // 画面を離れて、止めた
    return { kind: 'preset', why: timedOut ? 'timeout-download' : 'download' };
  } finally {
    clearTimeout(timer);
    if (current && mine === epoch) current = null;
  }
}

// 今日の形を作る。seeds は、作り直しの番号 0〜8 の種。止められたら null
export async function makeToday(seeds: number[], onStage: (s: MakeStage) => void = () => {}): Promise<MakeResult | null> {
  stopMaking();
  const mine = epoch;
  const model = await modelBytes(onStage, mine);
  if (mine !== epoch || model === null) return null; // 待っているあいだに、画面を離れた（ワーカーは作らない）
  if (!(model instanceof ArrayBuffer)) return model;
  onStage('making');

  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./gacha.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve({ kind: 'preset', why: 'load' });
      return;
    }
    let timer = 0;
    let settled = false;
    const finish = (r: MakeResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate(); // できたら、すぐに止める（セッションは、ワーカーの中で解放ずみ）
      if (current === me) current = null;
      resolve(r);
    };
    const me = { cancel: () => finish(null) };
    current = me;
    timer = window.setTimeout(() => finish({ kind: 'preset', why: 'timeout-load' }), LOAD_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent<GachaWorkerResponse>) => {
      const m = e.data;
      if (m.type === 'loaded') {
        clearTimeout(timer);
        timer = window.setTimeout(() => finish({ kind: 'preset', why: 'timeout-generate' }), GENERATE_TIMEOUT_MS);
      } else if (m.type === 'done') {
        finish(m.kind === 'dit' ? { kind: 'dit', mask: m.mask, steps: m.steps } : { kind: 'preset', why: 'invalid' });
      } else {
        console.warn('今日のよつば: 形を作れませんでした', m.stage, m.message);
        finish({ kind: 'preset', why: m.stage });
      }
    };
    worker.onerror = e => {
      console.warn('今日のよつば: ワーカーが止まりました', e.message);
      finish({ kind: 'preset', why: 'load' });
    };
    worker.postMessage({ type: 'make', model, seeds }, [model]); // モデルの中身は、ワーカーへ移す（画面の側には残さない）
  });
}
