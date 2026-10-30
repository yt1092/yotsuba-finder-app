// Main（ホーム）画面の初期化
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';
import { HeroCarousel } from '../components/hero-carousel';
import { getAllRecords, countRecords } from '../lib/db';
import type { CloverRecord } from '../lib/db';
import { buildHeroSlides } from '../lib/hero-slides';
import { prefetchDiaryFontsWhenIdle } from '../lib/diary-fonts-prefetch';
import { prefetchGachaModelWhenIdle } from '../lib/gacha-prefetch';
import { mountStartBackdrop } from '../components/start-backdrop';
import { getProgress } from '../lib/progress-db';
import { levelInfo, formatCount } from '../lib/progress';
import { gachaReady } from '../lib/gacha-ready';

injectSvgDefs();

// 大きな画像の切り替え
const hero = new HeroCarousel(
  document.getElementById('heroMedia')!,
  document.getElementById('heroIllustration')!,
  document.getElementById('heroDots')!,
);

// スタート画面の「はじめる」: ホームに進む
// スタート画面は同じページの中にあるので、履歴は増えない（ホームで戻る操作をしても、スタート画面には戻らない）
const startScreen = document.getElementById('startScreen');
const backdrop = startScreen && document.documentElement.hasAttribute('data-start') ? mountStartBackdrop(startScreen) : null;
document.getElementById('startBtn')?.addEventListener('click', () => {
  try { sessionStorage.setItem('yotsuba-started', '1'); } catch { /* 保存できなくても進む */ }
  document.documentElement.removeAttribute('data-start');
  backdrop?.remove(); // 背景の動きを止めて、取りのぞく
  window.scrollTo(0, 0);
  showTutorialIfFirst();
});

// 初めて開いたときの説明（初回だけ。設定の「つかいかたを、もういちど見る」からは #tutorial で開く）
// URL に画面の指定や開発用の指定があるときは、自動では出さない（スタート画面と同じ）
async function showTutorialIfFirst(force = false) {
  const { needsTutorial, openTutorial } = await import('../components/tutorial');
  if (force || await needsTutorial()) openTutorial();
}
if (location.hash === '#tutorial') {
  document.documentElement.removeAttribute('data-start');
  history.replaceState(null, '', location.pathname);
  showTutorialIfFirst(true);
} else if (!document.documentElement.hasAttribute('data-start') && !location.hash && !location.search) {
  showTutorialIfFirst();
}

async function init() {
  // 「今日のよつば」（試作。数式で作った形）は、見つけた四つ葉ではないので、ここでは数えない・出さない
  const [all, total] = await Promise.all([getAllRecords(), countRecords()]);
  const records = all.filter(r => r.source !== 'gacha');
  const count = total - (all.length - records.length);

  // 発見件数を表示
  const countEl = document.getElementById('cloverCount');
  if (countEl) countEl.textContent = String(count);

  // 大きな画像（イラスト＋見つけた四つ葉の写真）
  hero.setSlides(buildHeroSlides(records));

  // 最近の発見（最新3件）
  renderRecent(records.slice(0, 3));
  renderLevel().catch(e => console.warn('レベルを読めませんでした', e));
}

// レベルのカード（「Lv.3 めばえ」・次までの進み具合の棒・「次まで あと 40」）
async function renderLevel() {
  const info = levelInfo((await getProgress()).xp);
  document.getElementById('levelLv')!.textContent = `Lv.${info.level}`;
  document.getElementById('levelRank')!.textContent = info.rank;
  document.getElementById('levelNext')!.textContent = `次まで あと ${formatCount(info.toNext)}`;
  (document.getElementById('levelBar') as HTMLElement).style.width = `${(info.into / info.need) * 100}%`;
}

function renderRecent(records: CloverRecord[]) {
  const container = document.getElementById('recentGrid');
  if (!container) return;

  if (records.length === 0) {
    container.innerHTML = '<p class="empty-msg">まだ発見がありません</p>';
    return;
  }

  container.innerHTML = records.map(r => {
    const d = new Date(r.date);
    const label = `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
    return `
      <a href="detail.html?id=${r.id}" aria-label="${label}の${r.label}" class="recent-thumb">
        <img src="${r.imageDataUrl}" alt="" loading="lazy">
        <span class="date-chip">${label}</span>
      </a>`;
  }).join('');
}

// 別の画面から戻ってきたとき（ブラウザがこの画面を残しておいた場合も）、新しく保存された四つ葉をすぐに反映する
// 離れるときは、写真の URL を解放しておく
window.addEventListener('pagehide', () => hero.dispose());
window.addEventListener('pageshow', e => { if (e.persisted) init(); });

init();

// 「今日のよつば」の行の、準備ができた印（モデルが読めるときだけ出す。読めなければ、出さないだけ）
// 開いたとき・戻ってきたとき・Service Worker がモデルを入れ終えたとき（sw/sw.js の prefetchGachaModel）に、確かめ直す
async function showGachaReady() {
  const mark = document.getElementById('gachaReady');
  if (!mark) return;
  mark.hidden = !(await gachaReady());
  mark.parentElement?.setAttribute('data-ready-checked', '');
}
showGachaReady();
window.addEventListener('pageshow', e => { if (e.persisted) showGachaReady(); });
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'gacha-model-cached') showGachaReady(); });

// 日記カードのフォントを、手の空いたときに先読みしておく（オフラインでもカードを作れるように）
prefetchDiaryFontsWhenIdle();
prefetchGachaModelWhenIdle(); // 今日のよつばのモデルを、背景で入れる（検出のモデルを取ったあと。ホームでだけ頼む）
