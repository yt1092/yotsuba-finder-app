// 初めて開いたときの説明（チュートリアル）。全画面で、横になぞると 4 枚を見られる
// - 横の移動は CSS の scroll-snap（ライブラリは使わない）。下に位置の点と「スキップ」「つぎへ」（最後は「はじめる」）
// - 背景はスライドごとの絵。切り替わるときに、ゆっくり重ねて替え（約 0.4 秒）、見ているあいだ、ゆっくり大きくする（1.0→1.05）
//   「視差効果を減らす」がオンのときは、動かさない
// - 背景は、キャラクターが見出しとカードに隠れないように置く（src/lib/tutorial.ts の fitBackground）
// - カメラの許可は、ここでは求めない
// - 「見た」という印は、localStorage と IndexedDB（progress の入れ物の id: 'tutorial'。きろくを消しても残る）に残す
import '../styles/tutorial.css';
import { openDb, PROGRESS_STORE } from '../lib/db';
import { requestPersist } from '../lib/persist';
import { TUTORIAL_IMAGES, fitBackground, homeScreenGuide, markTutorialSeen, shouldShowTutorial, type HomeScreenGuide, type SeenStore, type TutorialSession } from '../lib/tutorial';

const LOCAL_KEY = 'yotsuba-tutorial-seen';
const SESSION_KEY = 'yotsuba-tutorial-shown';

const localStore: SeenStore = {
  get: async () => localStorage.getItem(LOCAL_KEY) === '1',
  set: async () => localStorage.setItem(LOCAL_KEY, '1'),
};
const idbStore: SeenStore = {
  get: async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(PROGRESS_STORE, 'readonly').objectStore(PROGRESS_STORE).get('tutorial');
      req.onsuccess = () => resolve(Boolean(req.result?.seen));
      req.onerror = () => reject(req.error);
    });
  },
  set: async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PROGRESS_STORE, 'readwrite');
      tx.objectStore(PROGRESS_STORE).put({ id: 'tutorial', seen: true, at: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};
// この回に出したか（ページを移っても、同じタブのあいだは覚えておく）
const session: TutorialSession = {
  get shown() { try { return sessionStorage.getItem(SESSION_KEY) === '1' || memoryShown; } catch { return memoryShown; } },
  set shown(v: boolean) { memoryShown = v; try { if (v) sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* 覚えられなくても続ける */ } },
};
let memoryShown = false;

export const needsTutorial = (): Promise<boolean> => shouldShowTutorial([localStore, idbStore], session);

// 小さな図（説明のための絵。読み上げない）
const clover = (size: number) => `<svg width="${size}" height="${size}" viewBox="-42 -42 84 84" aria-hidden="true"><use href="#cH" transform="rotate(8)"/></svg>`;
const FIGURES = [
  '',
  `<div class="tut-fig tut-fig-popup" aria-hidden="true">
     <span class="tut-fig-photo">${clover(40)}</span>
     <span class="tut-fig-col">
       <span class="tut-fig-guide"><span class="tut-fig-dots">●●●</span> 高め</span>
       <span class="tut-fig-btns"><span class="tut-fig-keep">入れる</span><span class="tut-fig-skip">入れない</span></span>
     </span>
   </div>`,
  `<div class="tut-fig tut-fig-btns tut-fig-btns--big" aria-hidden="true"><span class="tut-fig-keep">入れる</span><span class="tut-fig-skip">入れない</span></div>`,
  `<div class="tut-fig tut-fig-row" aria-hidden="true">
     <span class="tut-fig-level"><span class="tut-fig-lv">Lv.2</span> わかば<span class="tut-fig-bar"><span></span></span></span>
     <span class="tut-fig-diary">${clover(30)}<span>ひとこと</span></span>
   </div>`,
];

const SLIDES = [
  { kicker: 'ようこそ', title: '四つ葉を さがそう', text: ['写真を えらぶか、カメラで、さがせます。'] },
  { kicker: '', title: '見つけたら、たしかめよう', text: ['金色の 枠は、四つ葉の こうほです。見つかったら、自分の 目で 見て、「図鑑に入れる」か「入れない」を えらびます。', '●●● は、AI の たしかさの めやすです。'] },
  { kicker: '', title: 'まちがいは、おしえてね', text: ['AI は、まだ、まちがえることが あります。「入れない」を えらぶと、あなたの 端末の 中だけで、調整されます。', 'オフラインでも うごき、写真は、端末の 外に 出ません。'] },
  { kicker: '', title: '図鑑と、日記', text: ['見つけた 四つ葉で、レベルが 上がります。', '日記カードに、ひとこと 書けます。'] },
];

// 最後のスライドの「ホーム画面に追加」の案内（ホーム画面から開いたときは出さない。src/lib/tutorial.ts の homeScreenGuide）
// 共有のアイコンは、図鑑の詳細の「共有する」と同じ形
const SHARE_ICON = '<svg class="tut-home-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="共有"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>';
function currentGuide(): HomeScreenGuide {
  let standalone = false;
  try {
    standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { /* 分からなければ、ブラウザで開いているとみなす */ }
  return homeScreenGuide({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, standalone });
}
function homeGuideHtml(guide: HomeScreenGuide): string {
  if (guide === 'none') return '';
  const body = guide === 'ios-safari'
    ? `<ol class="tut-home-steps"><li>下の ${SHARE_ICON}（共有）を 押す</li><li>「ホーム画面に追加」を 押す</li></ol>`
    : guide === 'ios-other'
      ? '<p>Safari で 開いてください。Safari の 共有から、ホーム画面に 追加できます。</p>'
      : '<p>ブラウザの メニューから「ホーム画面に追加」を えらんでください。</p>';
  return `<div class="tut-home" data-home-guide="${guide}"><p class="tut-home-title">ホーム画面に 追加すると、アプリのように 使えます</p>${body}</div>`;
}

export function openTutorial(onClose?: () => void): void {
  const homeGuide = homeGuideHtml(currentGuide());
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.createElement('div');
  root.className = 'tut';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'つかいかた');
  root.innerHTML = `
    <div class="tut-bgs" aria-hidden="true">
      ${TUTORIAL_IMAGES.map((img, i) => `<div class="tut-bg${i === 0 ? ' is-active' : ''}"><img alt="" decoding="async" ${i === 0 ? 'fetchpriority="high"' : ''}
        srcset="${img.small} 640w, ${img.src} ${img.width}w" sizes="100vw" src="${img.small}" width="${img.width}" height="${img.height}"></div>`).join('')}
    </div>
    <div class="tut-track">
      ${SLIDES.map((s, i) => `
        <section class="tut-slide" aria-roledescription="スライド" aria-label="${i + 1} / ${SLIDES.length}">
          <div class="tut-head">
            ${s.kicker ? `<p class="tut-kicker">${s.kicker}</p>` : ''}
            <h2 class="tut-title">${s.title}</h2>
          </div>
          <div class="tut-card">
            ${s.text.map(t => `<p>${t}</p>`).join('')}
            ${i === SLIDES.length - 1 && homeGuide ? homeGuide : FIGURES[i]}
          </div>
        </section>`).join('')}
    </div>
    <div class="tut-controls">
      <button type="button" class="btn-text-link tut-skip" data-skip>スキップ</button>
      <span class="tut-dots" aria-hidden="true">${SLIDES.map(() => '<span></span>').join('')}</span>
      <button type="button" class="btn-primary tut-next" data-next>つぎへ</button>
    </div>`;
  const track = root.querySelector('.tut-track') as HTMLElement;
  const slides = [...root.querySelectorAll<HTMLElement>('.tut-slide')];
  const bgs = [...root.querySelectorAll<HTMLElement>('.tut-bg')];
  const dots = [...root.querySelectorAll<HTMLElement>('.tut-dots span')];
  const next = root.querySelector('[data-next]') as HTMLButtonElement;
  let index = -1;

  // 背景を、キャラクターが見出しとカードのあいだに来るように置く
  const place = () => {
    const vw = root.clientWidth, vh = root.clientHeight;
    slides.forEach((slide, i) => {
      const top = (slide.querySelector('.tut-head') as HTMLElement).getBoundingClientRect().bottom - root.getBoundingClientRect().top;
      const bottom = (slide.querySelector('.tut-card') as HTMLElement).getBoundingClientRect().top - root.getBoundingClientRect().top;
      const img = TUTORIAL_IMAGES[i];
      const f = fitBackground(vw, vh, img, top, bottom);
      const el = bgs[i].querySelector('img') as HTMLImageElement;
      el.style.width = `${img.width * f.scale}px`;
      el.style.height = `${img.height * f.scale}px`;
      el.style.transform = `translate(${f.x}px, ${f.y}px)`;
      bgs[i].style.transformOrigin = `${f.x + img.face[0] * img.width * f.scale}px ${f.y + img.face[1] * img.height * f.scale}px`;
      bgs[i].dataset.fit = JSON.stringify({ faceVisible: f.faceVisible, bandVisible: f.bandVisible, sideCut: Math.round(f.sideCut * 100) / 100 });
    });
  };

  const show = (i: number) => {
    if (i === index) return;
    index = i;
    bgs.forEach((b, k) => b.classList.toggle('is-active', k === i));
    dots.forEach((d, k) => d.classList.toggle('is-active', k === i));
    slides.forEach((s, k) => s.setAttribute('aria-hidden', String(k !== i)));
    next.textContent = i === SLIDES.length - 1 ? 'はじめる' : 'つぎへ';
  };
  const go = (i: number) => track.scrollTo({ left: i * track.clientWidth, behavior: reduce ? 'auto' : 'smooth' });

  const close = async () => {
    await markTutorialSeen([localStore, idbStore], session);
    void requestPersist({ once: true }); // チュートリアルのあと: 記録が勝手に消されにくくするように頼む（src/lib/persist.ts）
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey);
    root.remove();
    document.documentElement.classList.remove('tut-open');
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(Math.min(SLIDES.length - 1, index + 1));
    else if (e.key === 'ArrowLeft') go(Math.max(0, index - 1));
    else if (e.key === 'Escape') close();
  };

  track.addEventListener('scroll', () => show(Math.round(track.scrollLeft / Math.max(1, track.clientWidth))), { passive: true });
  next.addEventListener('click', () => (index === SLIDES.length - 1 ? close() : go(index + 1)));
  root.querySelector('[data-skip]')!.addEventListener('click', () => close());
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey);

  document.documentElement.classList.add('tut-open');
  document.body.append(root);
  session.shown = true;
  show(0);
  place();
  // フォントが届くと、見出しとカードの高さが変わるので、置き直す
  document.fonts?.ready.then(place).catch(() => undefined);
  next.focus();
}
