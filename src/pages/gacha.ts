// 「今日のよつば」画面（gacha.html）
// 1. ひく前 → 2. つくっている間 → 3. 結果（切り絵・押し花・ドット絵）→ 4. 図鑑に入れる（確認のポップアップ）
// - 形は、この端末の中の小さなモデル（DiT）が作る（src/lib/gacha-maker.ts。ワーカー 1 つ・セッション 1 つ・できたら止める）
// - 種は、日付と端末ごとの値から決まる（src/lib/gacha-seed.ts・src/lib/gacha-device.ts）。同じ端末の同じ日は同じ形
// - モデルが端末に無ければ、その場で取る（「準備しています」）。通信できない・取れない・読み込みや推論の失敗・
//   9 回作っても妥当にならない・時間切れのときだけ、あらかじめ作った 60 枚から、種で 1 枚（説明の 1 行は出さない）
// - 今日の形は、DiT の形だけ IndexedDB に残す（src/lib/gacha-today.ts）。同じ日に開き直したら、同じ形を、すぐに出す
//   60 枚から出した形は残さないので、次に開いたときは「ひく前」から（DiT が使えるようになれば、DiT の形になる）
// - 「図鑑に入れる」は、確認のポップアップのあとで、1 日 1 回。経験値は入れない（見つけた四つ葉ではないため。
//   ホームの「見つけた四つ葉」の数や「最近の発見」にも入れない。src/pages/main.ts）
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';
import { addGacha, getAllGacha } from '../lib/db';
import { newGachaRecord } from '../lib/gacha-list';
import { shapeThumb } from '../lib/gacha-thumb';
import { GACHA_DIT_NOTE, dayNumber, gachaAlt, gachaImageUrl, tokyoDayKey } from '../lib/gacha';
import { RETRY_LIMIT, noise, toUnit } from '../lib/gacha-gen';
import { mixSeed, newDeviceValue, presetNumber } from '../lib/gacha-seed';
import { deviceValue } from '../lib/gacha-device';
import { cleanup, SIZE, type Mask } from '../lib/gacha-shape';
import { maskFromAlpha } from '../lib/gacha-mask';
import { outline, type Outline } from '../lib/gacha-outline';
import { GACHA_STYLES, drawArt, drawStep, type GachaStyle } from '../lib/gacha-draw';
import { makeToday, stopMaking } from '../lib/gacha-maker';
import { loadToday, saveToday } from '../lib/gacha-today';
import { STEP_SHOW_MS } from '../lib/gacha-config';
import { recordGachaLoad } from '../lib/gacha-ready';
import { openGachaConfirm } from '../components/gacha-confirm';

injectSvgDefs();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sections = { before: $('gachaBefore'), making: $('gachaMaking'), result: $('gachaResult') };
const drawBtn = $<HTMLButtonElement>('gachaDraw');
const stepBig = $<HTMLCanvasElement>('gachaStepBig');
const stepTiles = [...document.querySelectorAll<HTMLCanvasElement>('.gacha-step')];
const bar = $('gachaBar');
const art = $<HTMLCanvasElement>('gachaArt');
const note = $('gachaNote');
const stageLabel = $('gachaStage');
const busyBtn = $<HTMLButtonElement>('gachaBusy');
const saveBtn = $<HTMLButtonElement>('gachaSave');
const savedMsg = $('gachaSaved');
const openLink = $<HTMLAnchorElement>('gachaOpen');
const styleBtns = [...document.querySelectorAll<HTMLButtonElement>('.gacha-style')];

const STYLE_KEY = 'yotsuba-gacha-style'; // 見た目の選択（この端末のブラウザにだけ。読めなければ切り絵）

type Shown = { day: string; kind: 'dit' | 'preset'; mask: Mask; outline: Outline };
let dayKey = '';
let shown: Shown | null = null;
let style: GachaStyle = readStyle();
let making = 0; // 作っている回の番号（画面を離れて止めたら、前の回の続きは使わない）

function readStyle(): GachaStyle {
  try {
    const s = localStorage.getItem(STYLE_KEY);
    if (GACHA_STYLES.some(g => g.key === s)) return s as GachaStyle;
  } catch { /* 使えない */ }
  return 'cut';
}

function show(name: keyof typeof sections) {
  for (const [k, el] of Object.entries(sections)) el.hidden = k !== name;
}

// 日付の表示（日本時間）: 「10月28日（水）」と、押し花の絵の「10.28」
function dateLabels(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  const week = '日月火水木金土'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { long: `${m}月${d}日（${week}）`, short: `${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}` };
}

const pixelSize = (el: HTMLElement) => Math.round(Math.max(64, el.clientWidth || 310) * Math.min(3, window.devicePixelRatio || 1));

// 今の状態を出す（今日の形が残っていれば結果、なければ「ひく前」）。日付が変わっていたら、次の日の形へ
async function render() {
  const key = tokyoDayKey(new Date());
  $('gachaDate').textContent = dateLabels(key).long;
  if (key === dayKey && shown) return;
  dayKey = key;
  const today = await loadToday(key);
  if (today) {
    await showResult({ day: key, kind: 'dit', mask: today, outline: outline(today) });
  } else {
    shown = null;
    show('before');
    drawBtn.disabled = false;
  }
}

// あらかじめ作った 60 枚の 1 枚を、64×64 の形にする
async function presetMask(n: number): Promise<Mask> {
  const im = new Image();
  im.src = gachaImageUrl(n);
  await im.decode();
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(im, 0, 0, SIZE, SIZE);
  return cleanup(maskFromAlpha(g.getImageData(0, 0, SIZE, SIZE).data));
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// 2. つくっている間: 途中の 4 つの形を、順に見せる（全部で 約 2 秒）
async function playSteps(steps: Float32Array[], run: number) {
  for (let i = 0; i < steps.length; i++) {
    if (run !== making) return;
    drawStep(stepBig, pixelSize(stepBig), steps[i]);
    drawStep(stepTiles[i], pixelSize(stepTiles[i]), steps[i]);
    stepTiles[i].classList.add('is-on');
    bar.style.width = `${((i + 1) / steps.length) * 100}%`;
    await wait(STEP_SHOW_MS);
  }
}

// 今日の種（作り直しの番号 0〜8）。端末の値が読めない・残せないときは、その回だけの値で作る
async function todaySeeds(key: string): Promise<number[]> {
  let dev: number[];
  try {
    dev = await deviceValue();
  } catch {
    dev = newDeviceValue();
  }
  return Array.from({ length: RETRY_LIMIT + 1 }, (_, k) => mixSeed(dev, dayNumber(key), k));
}

// 「準備しています」（モデルを取っている）・「つくっています」
function setStage(text: string) {
  stageLabel.textContent = text;
  busyBtn.textContent = `${text}…`;
}

drawBtn.addEventListener('click', async () => {
  const run = ++making;
  const now = new Date();
  const key = tokyoDayKey(now);
  drawBtn.disabled = true;
  show('making');
  setStage('つくっています');
  bar.classList.add('is-waiting');
  bar.style.width = '0%';
  for (const t of stepTiles) { t.classList.remove('is-on'); drawStep(t, pixelSize(t), null); }
  const seeds = await todaySeeds(key);
  if (run !== making) return;
  // はじめのノイズ（1 回目に使うものと同じ）。途中の形の 4 つは、まだ空
  drawStep(stepBig, pixelSize(stepBig), toUnit(noise(seeds[0])));

  const r = await makeToday(seeds, stage => { if (run === making) setStage(stage === 'preparing' ? '準備しています' : 'つくっています'); });
  if (run !== making || !r) return; // 画面を離れて、止めた
  // モデルを読み込めたかを残す（ホームの準備の印に使う。通信できない・取れなかったときは、読み込みの結果ではないので残さない）
  if (r.kind === 'dit') recordGachaLoad(true);
  else if (r.why === 'load' || r.why === 'timeout-load') recordGachaLoad(false);
  bar.classList.remove('is-waiting');
  let kind: Shown['kind'], mask: Mask;
  if (r.kind === 'dit') {
    await playSteps(r.steps, run);
    if (run !== making) return;
    kind = 'dit';
    mask = r.mask;
    try {
      await saveToday(key, mask); // DiT の形だけ残す
    } catch (e) {
      console.warn('今日の形を残せませんでした', e);
    }
  } else {
    kind = 'preset'; // 60 枚から（残さない）
    try {
      mask = await presetMask(presetNumber(seeds[0]));
    } catch {
      show('before'); // 絵も読めないとき（ふつうは、先にキャッシュに入っている）
      drawBtn.disabled = false;
      return;
    }
  }
  if (run !== making) return;
  dayKey = key;
  await showResult({ day: key, kind, mask, outline: outline(mask) });
});

// 3. 結果
async function showResult(s: Shown) {
  shown = s;
  note.textContent = GACHA_DIT_NOTE;
  note.hidden = s.kind !== 'dit'; // 60 枚から出したときは、説明の 1 行を出さない（出どころは、図鑑の詳細に出す）
  paintArt();
  show('result');
  showSaved((await savedToday(s))?.id);
}

function paintArt() {
  if (!shown) return;
  drawArt(art, pixelSize(art), shown.mask, shown.outline, style, dateLabels(shown.day).short);
  art.setAttribute('aria-label', `${gachaAlt(shown.kind)}（${GACHA_STYLES.find(g => g.key === style)!.label}）`);
  for (const b of styleBtns) b.setAttribute('aria-pressed', String(b.dataset.style === style));
}

for (const b of styleBtns) {
  b.addEventListener('click', () => {
    style = b.dataset.style as GachaStyle;
    try { localStorage.setItem(STYLE_KEY, style); } catch { /* 使えない */ }
    paintArt();
  });
}

// 今日のよつばの一覧に入れた、今日の形（日付と出どころが同じもの。60 枚の形を入れたあとで、DiT の形が使えるようになったら、DiT の形も入れられる）
async function savedToday(s: Shown) {
  return (await getAllGacha()).find(r => r.gachaDay === s.day && (r.gachaKind ?? 'preset') === s.kind);
}

function showSaved(id: number | undefined) {
  saveBtn.hidden = id !== undefined;
  savedMsg.hidden = id === undefined;
  openLink.hidden = id === undefined;
  if (id !== undefined) openLink.href = `detail.html?id=${id}`;
}

// 4. 図鑑に入れる: 今の見た目の絵（512×512）と、一覧に出す形（64×64）を、確認のポップアップのあとで保存する
//    入れ物は、図鑑の写真とは別の、今日のよつばの入れ物（src/lib/gacha-list.ts）
saveBtn.addEventListener('click', async () => {
  if (!shown) return;
  const s = shown;
  const c = document.createElement('canvas');
  drawArt(c, 512, s.mask, s.outline, style, dateLabels(s.day).short);
  const image = c.toDataURL('image/jpeg', 0.9);
  if (!(await openGachaConfirm(image, gachaAlt(s.kind)))) return;
  saveBtn.disabled = true;
  try {
    // 同じ日の、同じ出どころの形が、もう入っていれば、2 回は入れない（別のタブで入れたときなど）
    const already = await savedToday(s);
    const id = already?.id ?? await addGacha(newGachaRecord({ now: Date.now(), image, day: s.day, kind: s.kind, shape64: shapeThumb(c, c.width, c.height) }));
    showSaved(id);
  } catch (e) {
    console.warn('図鑑に入れられませんでした', e);
  } finally {
    saveBtn.disabled = false;
  }
});

// 画面を離れるとき: 作っている途中なら、ワーカーとセッションを止める。戻ったら、もう一度「ひく前」から
function leave() {
  if (sections.making.hidden) return;
  making++;
  stopMaking();
  show('before');
  drawBtn.disabled = false;
}
window.addEventListener('pagehide', () => { stopMaking(); leave(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') leave();
  else render(); // 開いたまま日付が変わったとき
});
window.addEventListener('pageshow', e => { if (e.persisted) render(); });

render();
