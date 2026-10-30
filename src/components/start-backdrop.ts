// スタート画面の背景（動く野原）。CSS と SVG だけで作る（軽く、オフラインでも動き、電池を使いすぎないため）
// ゆっくり漂う光・ゆれる四つ葉のシルエット・きらめき。動きは transform と opacity だけ（端末の得意な描き方）
// - 画面が見えないとき（別のアプリに切り替えたとき）は止める
// - OS の「視差効果を減らす」がオンのときは動かさない（CSS の prefers-reduced-motion）
// - あとで、野原で撮った映像に差し替えるときは、この部品の中身（mountStartBackdrop）だけを変える
export interface StartBackdrop {
  remove: () => void; // 背景を取りのぞき、止める（「はじめる」を押したあと）
}

// 四つ葉のシルエット（ゆれる）: [左 %, 上 %, 大きさ px, 回転の度, ゆれの長さ 秒, 遅れ 秒]
const CLOVERS: [number, number, number, number, number, number][] = [
  [8, 14, 64, -12, 9, 0], [78, 9, 52, 18, 11, -3], [86, 42, 76, -8, 10, -6],
  [4, 58, 58, 24, 12, -2], [70, 74, 66, -20, 9.5, -5], [18, 86, 48, 10, 11.5, -7],
];
// ゆっくり漂う光: [左 %, 上 %, 大きさ px, 漂う長さ 秒, 遅れ 秒]
const LIGHTS: [number, number, number, number, number][] = [
  [-10, 2, 300, 22, 0], [55, 20, 260, 26, -8], [10, 62, 280, 24, -14], [62, 70, 240, 28, -4],
];
// きらめき: [左 %, 上 %, 大きさ px, 長さ 秒, 遅れ 秒]
const SPARKLES: [number, number, number, number, number][] = [
  [22, 24, 14, 4.2, 0], [64, 30, 10, 3.6, -1.2], [40, 52, 12, 5, -2.5], [82, 60, 14, 4.6, -0.8], [30, 76, 10, 3.9, -3.1], [58, 88, 12, 4.4, -1.9],
];

export function mountStartBackdrop(container: HTMLElement): StartBackdrop {
  const root = document.createElement('div');
  root.className = 'start-bg';
  root.setAttribute('aria-hidden', 'true');
  const leaf = 'M0 0 C-14 -6 -12 -26 0 -18 C12 -26 14 -6 0 0Z';
  root.innerHTML = LIGHTS.map(([l, t, s, d, delay]) =>
    `<span class="start-bg-light" style="left:${l}%;top:${t}%;width:${s}px;height:${s}px;animation-duration:${d}s;animation-delay:${delay}s"></span>`).join('')
    + CLOVERS.map(([l, t, s, r, d, delay]) =>
      `<svg class="start-bg-clover" viewBox="-30 -30 60 60" style="left:${l}%;top:${t}%;width:${s}px;height:${s}px;--r:${r}deg;animation-duration:${d}s;animation-delay:${delay}s">`
      + [0, 90, 180, 270].map(a => `<path d="${leaf}" transform="rotate(${a + 45})"/>`).join('')
      + `<path d="M0 0 Q4 14 2 26" fill="none" stroke-width="3" stroke-linecap="round"/></svg>`).join('')
    + SPARKLES.map(([l, t, s, d, delay]) =>
      `<svg class="start-bg-sparkle" viewBox="-10 -10 20 20" style="left:${l}%;top:${t}%;width:${s}px;height:${s}px;animation-duration:${d}s;animation-delay:${delay}s"><path d="M0 -10 L2 -2 L10 0 L2 2 L0 10 L-2 2 L-10 0 L-2 -2Z"/></svg>`).join('');
  container.prepend(root);

  // 画面が見えないあいだは止める
  const onVisibility = () => root.classList.toggle('start-bg--paused', document.hidden);
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  return {
    remove: () => {
      document.removeEventListener('visibilitychange', onVisibility);
      root.remove();
    },
  };
}
