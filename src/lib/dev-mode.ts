// デバッグ表示（原因を調べるため）: 枠ごとに、クラス・スコアの数字・追跡の回数を出す
// 開発用の版（ビルドの設定 VITE_DEBUG_OVERLAY=1、または Vercel の debug ブランチのプレビュー。vite.config.ts）にだけ入る。
// 本番のビルドでは __DEBUG_OVERLAY__ が false になり、これを使うところ（「DEBUG_BUILD && …」）は、ビルドで取りのぞかれる。
// 開発用の版の中でも、ふだんはオフ。設定のバージョンの表示を 5 回つづけて押すと、オン・オフが切りかわる
export const DEBUG_BUILD: boolean = __DEBUG_OVERLAY__;

const KEY = 'yotsuba-dev';

export function isDevMode(): boolean {
  if (!DEBUG_BUILD) return false;
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* 残せなくても、続ける */ }
}

// 短いあいだに n 回タップしたら、切りかえる
export function tapCounter(n: number, withinMs: number, onToggle: (on: boolean) => void): () => void {
  let taps: number[] = [];
  return () => {
    const now = Date.now();
    taps = [...taps.filter(t => now - t < withinMs), now];
    if (taps.length >= n) {
      taps = [];
      const on = !isDevMode();
      setDevMode(on);
      onToggle(on);
    }
  };
}
