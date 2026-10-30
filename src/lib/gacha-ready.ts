// 「今日のよつば」の準備ができた印（ホームの「今日のよつば」の行。src/pages/main.ts）
// 印を出すのは、DiT のモデルが、この端末で読み込める状態のときだけ（判定は readyFrom。tests/gacha-ready.test.ts）
//   1. モデルのファイルが、この端末のキャッシュにあり、終わりまで読める（大きさが合う・ONNX の始まりの印がある）
//   2. この端末で、そのモデルの読み込みに失敗していない（今日のよつばの画面で、読み込みの結果を残す。recordGachaLoad）
// ネットにつながっているかは、見ない（オフラインでも、キャッシュにあれば作れるため）
// 今日もう作ったかどうかにも、関係させない。読めないときは、印を出さないだけ（エラーにしない）
import { GACHA_MODEL_URL } from './gacha-config.ts'; // node のテストでそのまま読めるように、.ts を付ける

export const LOAD_RESULT_KEY = 'yotsuba-gacha-load'; // 最後に読み込んだ結果（localStorage。この端末だけ）
const ONNX_FIRST_BYTE = 0x08; // ONNX のファイルの始まり（ir_version の印）

export interface ModelFile {
  size: number;               // 読めた大きさ（バイト）
  expected: number | null;    // 取ったときの大きさ（Content-Length。分からなければ null）
  firstByte: number | null;
}
export interface LoadResult { url: string; ok: boolean; at: number }

export function readyFrom(file: ModelFile | null, last: LoadResult | null, url = GACHA_MODEL_URL): boolean {
  if (!file || file.size <= 0) return false;
  if (file.expected !== null && file.size !== file.expected) return false; // 途中までしか入っていない
  if (file.firstByte !== ONNX_FIRST_BYTE) return false;                    // モデルのファイルではない（こわれている）
  if (last && last.url === url && !last.ok) return false;                  // この端末で、読み込みに失敗した
  return true;
}

export function parseLoadResult(text: string | null): LoadResult | null {
  try {
    const v = JSON.parse(text ?? 'null');
    return v && typeof v.url === 'string' && typeof v.ok === 'boolean' ? { url: v.url, ok: v.ok, at: Number(v.at) || 0 } : null;
  } catch {
    return null;
  }
}

// 今日のよつばの画面から: モデルを読み込めたか（DiT の形ができた = 読めた。読み込みで失敗・時間切れ = 読めなかった）
export function recordGachaLoad(ok: boolean, now = Date.now()): void {
  try {
    localStorage.setItem(LOAD_RESULT_KEY, JSON.stringify({ url: GACHA_MODEL_URL, ok, at: now }));
  } catch { /* 残せなくても、作ることは続ける */ }
}

// キャッシュのモデルのファイルを確かめる（中身を全部はメモリに出さない。始まりの 1 バイトだけ読む）
async function cachedModel(): Promise<ModelFile | null> {
  if (typeof caches === 'undefined') return null;
  const res = await caches.match(GACHA_MODEL_URL);
  if (!res) return null;
  const blob = await res.blob();
  const len = Number(res.headers.get('content-length'));
  const head = new Uint8Array(await blob.slice(0, 1).arrayBuffer());
  return { size: blob.size, expected: Number.isFinite(len) && len > 0 ? len : null, firstByte: head.length ? head[0] : null };
}

export async function gachaReady(): Promise<boolean> {
  try {
    let last: LoadResult | null = null;
    try { last = parseLoadResult(localStorage.getItem(LOAD_RESULT_KEY)); } catch { /* 読めなければ、失敗の記録は無いとみなす */ }
    return readyFrom(await cachedModel(), last);
  } catch {
    return false;
  }
}
