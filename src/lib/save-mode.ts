// 保存のしかた（設定）: 「確認してから入れる」（既定）か「自動で入れる」か
// この端末のブラウザ（localStorage）にだけ残す。読めないときは、既定（確認する）
export type SaveMode = 'confirm' | 'auto';

const KEY = 'yotsuba-save-mode';

export function getSaveMode(): SaveMode {
  try {
    return localStorage.getItem(KEY) === 'auto' ? 'auto' : 'confirm';
  } catch {
    return 'confirm';
  }
}

export function setSaveMode(mode: SaveMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch { /* 残せなくても、この画面の中では選んだとおりにする */ }
}
