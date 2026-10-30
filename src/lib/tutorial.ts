// 初めて開いたときの説明（チュートリアル）の、画面に頼らない計算（tests/tutorial.test.ts）
// - 背景の画像を、キャラクターが見出しと説明のカードに隠れないように置く
// - 「見た」という印（localStorage と IndexedDB の両方に残す。どちらも使えなければ、その回だけ出さない）

// 背景の画像ごとの、キャラクターのいる高さ（画像の高さに対する割合）と、まん中のキャラクターの顔の位置
export interface TutorialImage {
  src: string;        // 元の幅の版
  small: string;      // 幅 640px の版
  width: number;
  height: number;
  band: [number, number];   // キャラクターのいる高さ（上・下）
  face: [number, number];   // まん中のキャラクターの顔（横・高さ）
  sides: [number, number];  // 端のキャラクターの、外側の端（左・右。画像の幅に対する割合）
}

export const TUTORIAL_IMAGES: TutorialImage[] = [
  { src: '/images/tutorial-1.webp', small: '/images/tutorial-1-640.webp', width: 852, height: 1847, band: [0.36, 0.60], face: [0.49, 0.47], sides: [0.08, 0.90] },
  { src: '/images/tutorial-2.webp', small: '/images/tutorial-2-640.webp', width: 863, height: 1822, band: [0.29, 0.61], face: [0.53, 0.39], sides: [0.08, 0.92] },
  { src: '/images/tutorial-3.webp', small: '/images/tutorial-3-640.webp', width: 851, height: 1847, band: [0.33, 0.74], face: [0.53, 0.52], sides: [0.04, 0.92] },
  { src: '/images/tutorial-4.webp', small: '/images/tutorial-4-640.webp', width: 863, height: 1822, band: [0.43, 0.67], face: [0.48, 0.54], sides: [0.08, 0.94] },
];

export interface Fit {
  scale: number;      // 画像の 1px が、画面の何 px か
  x: number;          // 画像の左上の位置（画面の px）
  y: number;
  bandVisible: boolean; // キャラクターのいる高さが、見出しとカードのあいだに全部入る
  faceVisible: boolean; // まん中の顔が、見出しとカードのあいだにある
  sideCut: number;      // 端のキャラクターが、画面の外に出る割合（いちばん大きい側。0 なら切れない）
}

// 背景を画面いっぱいに（cover）置き、キャラクターを、見出しの下（top）とカードの上（bottom）のあいだに寄せる
// cover なので、動かせるのは、はみ出した分だけ（すき間はつくらない）
export function fitBackground(vw: number, vh: number, img: TutorialImage, top: number, bottom: number): Fit {
  const cover = Math.max(vw / img.width, vh / img.height);
  const f = place(vw, vh, img, top, bottom, cover);
  if (f.faceVisible) return f;
  // 顔がカードに隠れる（小さい画面）: 少し大きくして、顔を見出しとカードのあいだに上げる（最大 1.6 倍。端は少し切れる）
  // 顔をあいだのまん中に置き、下にすき間ができない大きさ: (1 - 顔の高さ) × 画像の高さ ≥ 画面の高さ − まん中
  const mid = (top + bottom) / 2;
  const need = (vh - mid) / ((1 - img.face[1]) * img.height);
  return place(vw, vh, img, top, bottom, Math.min(cover * 1.6, Math.max(cover, need)));
}

function place(vw: number, vh: number, img: TutorialImage, top: number, bottom: number, scale: number): Fit {
  const W = img.width * scale, H = img.height * scale;
  const [a, b] = img.band;
  const avail = Math.max(0, bottom - top);
  // キャラクター全体が入るなら、あいだのまん中に。入らなければ、顔をまん中に
  const want = (b - a) * H <= avail ? (top + bottom) / 2 - ((a + b) / 2) * H : (top + bottom) / 2 - img.face[1] * H;
  const y = Math.min(0, Math.max(vh - H, want));
  const x = Math.min(0, Math.max(vw - W, (vw - W) / 2));
  const bandVisible = y + a * H >= top - 0.5 && y + b * H <= bottom + 0.5;
  const fy = y + img.face[1] * H;
  const faceVisible = fy >= top && fy <= bottom;
  // 端のキャラクターの幅は、画像の幅の 約 22%。外側の端が、画面の外に出る分を、その幅で割る
  const charW = 0.22 * W;
  const leftOut = Math.max(0, -(x + img.sides[0] * W));
  const rightOut = Math.max(0, x + img.sides[1] * W - vw);
  return { scale, x, y, bandVisible, faceVisible, sideCut: Math.max(leftOut, rightOut) / charW };
}

// ── 「見た」という印 ──

export interface SeenStore {
  get(): Promise<boolean>;
  set(): Promise<void>;
}

export interface TutorialSession { shown: boolean } // この回（ページを開いているあいだ）に出したか

// 出すか: この回に、まだ出していない、かつ、どこにも「見た」が無い。印が読めないところは、見ていないとみなす
export async function shouldShowTutorial(stores: SeenStore[], session: TutorialSession): Promise<boolean> {
  if (session.shown) return false;
  for (const s of stores) {
    try {
      if (await s.get()) return false;
    } catch { /* 読めなければ、次を見る */ }
  }
  return true;
}

// 見た（スキップ・はじめる）: 両方に印を残す。どちらも残せなくても、この回は、もう出さない
export async function markTutorialSeen(stores: SeenStore[], session: TutorialSession): Promise<boolean> {
  session.shown = true;
  let saved = false;
  for (const s of stores) {
    try {
      await s.set();
      saved = true;
    } catch { /* 残せなくても、続ける */ }
  }
  return saved;
}

// ── 「ホーム画面に追加」の案内（チュートリアルの最後のスライド。src/components/tutorial.ts）──
// ホーム画面から開いたとき（standalone）は出さない。iPhone・iPad の Safari なら手順、ほかのブラウザなら「Safari で開いてください」
// iPhone・iPad でないとき（パソコン・Android）は、ブラウザのメニューから、と案内する

export type HomeScreenGuide = 'none' | 'ios-safari' | 'ios-other' | 'other';

export interface GuideEnv {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean; // matchMedia('(display-mode: standalone)') か navigator.standalone
}

// iPhone・iPad の、Safari 以外のブラウザ（Chrome・Firefox・Edge・アプリの中のブラウザなど）の印
const IOS_OTHER = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|DuckDuckGo|Line\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger|YJApp/;

export function homeScreenGuide(env: GuideEnv): HomeScreenGuide {
  if (env.standalone) return 'none';
  const ua = env.userAgent;
  // iPad の Safari は、パソコンの Mac と同じ名前を名乗る（さわれる画面かで見分ける）
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  if (!ios) return 'other';
  return /Safari\//.test(ua) && !IOS_OTHER.test(ua) ? 'ios-safari' : 'ios-other';
}
