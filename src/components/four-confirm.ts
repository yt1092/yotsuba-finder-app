// 確認のポップアップ: 検出した四つ葉の候補を、使う人が目で見て、図鑑に入れるか、入れないかを選ぶ
// - 候補を 1 つずつ、拡大した写真（まわりの景色つき・枠つき）で出す。「1/13」・左右になぞる・「まえへ」「つぎへ」
// - 「図鑑に入れる」「入れない」を押すと、次の候補に進む。全部決めたら、閉じる
//   （決めた結果は、後ろの結果の画面だけに出す。まとめの文とボタンを、ここと結果の画面で重ねて出さないため）
// - たしかさのめやすは 3 段階（●●● 高め／●●○ ふつう／●○○ 低め）。数字は出さない
// 決める動きは src/lib/four-review.ts（テストあり）。保存とまちがいの記録は、呼ぶ側（onDone）で行う
import type { Detection } from '../lib/detector';
import { CONFIDENCE_LEVELS } from '../lib/detector-config';
import { verifyCrops, boxInCrop } from '../lib/verify-crops';
import { mascotHtml } from '../lib/mascot';
import { recordProgress } from '../lib/progress-db';
import { addChoices } from '../lib/tuning-db';
import { showTeachThanks } from './progress-notice';
import { drawCrop } from '../lib/verify-run';
import {
  CONFIDENCE_TEXT, confidenceLevel, decide, move, showSkipAll, skipAll, startReview, summarize,
  type ReviewState, type ReviewSummary,
} from '../lib/four-review';

export interface ConfirmOptions {
  photo: ImageBitmap;                 // 写真（向きを直したもの）
  candidates: Detection[];            // 四つ葉の候補（写真の座標）
  onDone: (summary: ReviewSummary) => Promise<void>; // 全部決めた・とじたとき（保存と、まちがいの記録）
}

const CROP_PX = 720;
const SWIPE_PX = 50;

export function openFourConfirm(opts: ConfirmOptions): Promise<ReviewSummary> {
  return new Promise(resolve => {
    let state: ReviewState = startReview(opts.candidates.length);
    let finished = false;

    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.innerHTML = `
      <div class="confirm" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <div class="sheet-head">
          <div class="confirm-head-main">
            ${mascotHtml('surprised', 56)}
            <h2 id="confirmTitle" class="confirm-title">四つ葉が <wbr>見つかりました</h2>
          </div>
          <button type="button" class="btn-icon" data-close aria-label="とじる">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div data-review>
          <p class="confirm-lead">目で見て、たしかめてください</p>
          <!-- 候補が多いときだけ。上のほうに、控えめに置く（「図鑑に入れる」「入れない」とは離す） -->
          <button type="button" class="confirm-skip-all" data-skip-all hidden>ぜんぶ入れない</button>
          <div class="confirm-photo" data-photo>
            <canvas width="${CROP_PX}" height="${CROP_PX}" role="img" data-canvas></canvas>
            <span class="confirm-count font-nunito" data-count></span>
            <span class="confirm-state" data-state hidden></span>
          </div>
          <p class="confirm-guide"><span class="confirm-dots" aria-hidden="true" data-dots></span><span data-guide></span></p>
          <p class="confirm-note">めやすです。目で確かめてください</p>
          <div class="confirm-choice">
            <button type="button" class="btn-primary" data-keep>図鑑に入れる</button>
            <button type="button" class="btn-secondary" data-skip>入れない</button>
          </div>
          <div class="confirm-nav" data-nav>
            <button type="button" class="btn-text-link" data-prev>まえへ</button>
            <button type="button" class="btn-text-link" data-next>つぎへ</button>
          </div>
        </div>
      </div>`;
    const $ = <T extends HTMLElement>(sel: string) => backdrop.querySelector(sel) as T;
    const canvas = $<HTMLCanvasElement>('[data-canvas]');
    const g = canvas.getContext('2d')!;
    const many = opts.candidates.length > 1;

    // 候補の場所を、まわりの景色つきで描く（枠の長い辺が、切り抜きの 35% になるように）
    function drawCandidate(i: number) {
      const box = opts.candidates[i].bbox;
      const crop = verifyCrops(box, [0.35])[0];
      const { canvas: c, scale } = drawCrop(opts.photo, crop, CROP_PX);
      g.clearRect(0, 0, CROP_PX, CROP_PX);
      g.drawImage(c, 0, 0);
      const b = boxInCrop(box, crop, scale);
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
      g.strokeStyle = '#FFD66B';
      g.lineWidth = 4;
      g.strokeRect(b.x, b.y, b.w, b.h);
    }

    function render() {
      const i = state.index;
      drawCandidate(i);
      canvas.setAttribute('aria-label', `四つ葉の候補 ${i + 1}ばんめ`);
      $<HTMLElement>('[data-count]').textContent = `${i + 1}/${opts.candidates.length}`;
      $<HTMLElement>('[data-count]').hidden = !many;
      const level = CONFIDENCE_TEXT[confidenceLevel(opts.candidates[i].score, CONFIDENCE_LEVELS)];
      $<HTMLElement>('[data-dots]').textContent = level.dots;
      $<HTMLElement>('[data-guide]').textContent = `たしかさの めやす：${level.word}`;
      const choice = state.choices[i];
      const stateEl = $<HTMLElement>('[data-state]');
      stateEl.hidden = choice === null;
      stateEl.textContent = choice === 'keep' ? '図鑑に入れる' : '入れない';
      stateEl.classList.toggle('confirm-state--skip', choice === 'skip');
      $<HTMLElement>('[data-nav]').hidden = !many;
      $<HTMLButtonElement>('[data-prev]').disabled = i === 0;
      $<HTMLButtonElement>('[data-next]').disabled = i === opts.candidates.length - 1;
      $<HTMLElement>('[data-skip-all]').hidden = !showSkipAll(state);
    }

    async function finish() {
      if (finished) return;
      finished = true;
      const summary = summarize(state);
      backdrop.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = true; });
      try {
        await opts.onDone(summary);
        // 選んだもの（スコアと、入れたか）を、使う人に合わせた調整のために残す（端末の中だけ。src/lib/tuning-db.ts）
        await addChoices([
          ...summary.kept.map(i => ({ score: opts.candidates[i].score ?? 0, keep: true })),
          ...summary.skipped.map(i => ({ score: opts.candidates[i].score ?? 0, keep: false })),
        ]).catch(e => console.warn('選んだ記録を残せませんでした', e));
        // 「入れない」は、まちがいの記録に足した（onDone の中）。初めてのときだけ、お礼とバッジ（経験値は付けない）
        if (summary.skipped.length > 0) showTeachThanks(await recordProgress({ kind: 'teach' }));
      } catch (e) {
        console.error('保存できませんでした', e);
      }
      close();
      resolve(summary);
    }

    const step = (next: ReviewState) => {
      state = next;
      if (state.done) finish();
      else render();
    };
    $<HTMLButtonElement>('[data-keep]').addEventListener('click', () => step(decide(state, 'keep')));
    $<HTMLButtonElement>('[data-skip]').addEventListener('click', () => step(decide(state, 'skip')));
    $<HTMLButtonElement>('[data-prev]').addEventListener('click', () => step(move(state, -1)));
    $<HTMLButtonElement>('[data-next]').addEventListener('click', () => step(move(state, 1)));
    $<HTMLButtonElement>('[data-skip-all]').addEventListener('click', () => step(skipAll(state)));
    // とじる: 決めたものだけで終える（まだ決めていない候補は、入れない・記録もしない）
    $<HTMLButtonElement>('[data-close]').addEventListener('click', () => finish());

    // 左右になぞって、まえ・つぎへ（縦のスクロールはそのまま）
    const photoEl = $<HTMLElement>('[data-photo]');
    let startX: number | null = null;
    photoEl.addEventListener('pointerdown', e => { startX = e.clientX; });
    photoEl.addEventListener('pointerup', e => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) >= SWIPE_PX && many) step(move(state, dx < 0 ? 1 : -1));
    });
    photoEl.addEventListener('pointercancel', () => { startX = null; });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(move(state, 1));
      else if (e.key === 'ArrowLeft') step(move(state, -1));
    };
    function close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    }
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    render();
    $<HTMLButtonElement>('[data-keep]').focus();
  });
}
