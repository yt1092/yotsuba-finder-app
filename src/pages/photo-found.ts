// PhotoFound（写真で四つ葉発見・候補あり）画面の初期化
// 最後に調べた写真（lastPhoto）を出す。四つ葉の枠をタップすると、大きくして見られる
// - 「確認してから入れる」（既定）→ 確認のポップアップで、使う人が「図鑑に入れる」を選んだ四つ葉だけを保存する
// - 「自動で入れる」→ 図鑑に自動で保存済み
// 見出しと文は src/lib/result-text.ts で決める（決めた結果は、ポップアップではなく、この画面だけに出す）
// - （「確かめる」がオンのときだけ）候補だけ → 保存しない。候補をタップして確かめ、通ったら、そのときに自動で保存する
//   （「保存」ボタンは作らない。v3 からは「確かめる」がオフなので、候補はできない）
import '../lib/register-sw';
import { cropPhotoRecord } from '../lib/crop-image';
import { detectionsInCrop } from '../lib/crop';
import { injectSvgDefs } from '../components/svg-defs';
import { getLastPhoto, getRecord, setLastPhoto, updateRecord, type LastPhoto } from '../lib/db';
import { resultText } from '../lib/result-text';
import { setMascot } from '../lib/mascot';
import { VERIFY_STEP } from '../lib/detector-config';
import { RESULT_TEXT, confirmCandidate, confirmedCounts, resultKind } from '../lib/auto-verify';
import { setupLeafInspect } from '../components/leaf-inspect';
import { feedbackButtons, photoOnce, setupMissedMode, type FeedbackContext } from '../components/feedback-ui';
import { takeNotice } from '../lib/progress-db';
import { saveAnswer } from '../lib/feedback-db';
import { combineNotices, noticeOf } from '../lib/progress-db';
import { awardFourLeaves, saveFourLeafRecord } from '../lib/save-four';
import { showProgressNotice, showProgressResult } from '../components/progress-notice';

injectSvgDefs();

const titleEl = document.getElementById('resultTitle')!;
const leadEl = document.getElementById('resultLead')!;
const countEl = document.getElementById('leafCountText')!;
const diaryBtn = document.getElementById('diaryBtn') as HTMLButtonElement;

async function init() {
  const last = await getLastPhoto();
  if (!last) return;
  let state: LastPhoto = last;

  // 見出し・本数・保存の印・日記カードのボタンを、今の状態に合わせる
  const render = () => {
    const kind = resultKind({
      confirmed: state.detections.filter(d => d.label === '四つ葉' && !d.candidate),
      candidates: state.detections.filter(d => d.candidate),
    });
    // 候補だけ（「確かめる」がオンで、確かめきれなかったとき）は、確かめてもらう文
    const t = kind === 'candidates'
      ? { mascot: null, title: RESULT_TEXT.candidates.title, sub: RESULT_TEXT.candidates.lead, detail: '' }
      : resultText({
        fourDetected: state.fourDetected ?? state.detections.filter(d => d.label === '四つ葉').length,
        kept: state.recordId != null ? state.counts.four : 0,
        three: state.counts.three,
        pending: state.pendingReview,
        closedEarly: state.closedEarly,
        repeated: state.repeated,
      });
    setMascot(document.getElementById('resultMascot') as HTMLImageElement, t.mascot);
    titleEl.textContent = t.title;
    leadEl.textContent = t.sub;
    leadEl.hidden = !t.sub;
    countEl.textContent = t.detail;
    countEl.hidden = !t.detail;
    diaryBtn.hidden = state.recordId == null;
    // 図鑑に入れたときは、その記録を開く
    (document.getElementById('collectionLink') as HTMLAnchorElement).href = state.recordId != null ? `detail.html?id=${state.recordId}` : 'collection.html';
  };
  render();
  // 経験値（葉の数の文の下）・レベルアップ・新しいバッジ（確認のポップアップを出すときは、決めたあとで知らせる）
  const leafNotice = takeNotice();
  if (!state.pendingReview) showProgressNotice(leafNotice, document.getElementById('xpText'));

  const img = document.getElementById('foundImg') as HTMLImageElement;
  img.src = state.imageDataUrl;

  const ctx: FeedbackContext = {
    // まちがいの記録は、写真の全体の座標で残す（図鑑の記録の写真は切り抜いてあり、座標がちがうため、record:<id> にはしない）
    key: `photo:${state.date}`,
    detections: state.detections,
    photo: photoOnce(img),
  };
  const view = setupLeafInspect({
    img, detections: state.detections, verify: VERIFY_STEP, verifyNeeded: state.verifyNeeded,
    extraButtons: (det, index) => feedbackButtons(ctx, det, index),
    // 候補を確かめて通ったら、その場で自動で保存する（まだ保存していなければ新しく、保存済みなら記録を直す）
    onVerdict: async (det, index, verdict) => {
      if (verdict !== 'four' || !det.candidate) return;
      const detections = confirmCandidate(state.detections, index);
      const counts = confirmedCounts(detections);
      let recordId = state.recordId;
      if (recordId == null) {
        const cropped = await cropPhotoRecord(state.imageDataUrl, detections);
        const saved = await saveFourLeafRecord({ date: state.date, imageDataUrl: cropped.imageDataUrl, label: '四つ葉', source: 'photo',
          detections: cropped.detections ?? detections, counts, ...(cropped.crop ? { crop: cropped.crop } : {}) },
          { count: 1, photoHash: state.photoHash });
        recordId = saved.id;
        showProgressResult(saved.progress);
        sessionStorage.setItem('lastFoundId', String(recordId));
      } else {
        // 記録の写真が切り抜いてあれば、枠の座標を、切り抜いた写真の座標に直す
        const crop = (await getRecord(recordId))?.crop;
        await updateRecord(recordId, { detections: crop ? detectionsInCrop(detections, crop) : detections, counts });
        showProgressResult(await awardFourLeaves(1, state.photoHash));
      }
      state = { ...state, detections, counts, recordId };
      await setLastPhoto(state);
      ctx.detections = detections;
      view.setDetections(detections);
      render();
      return '図鑑に保存しました';
    },
  });

  // 四つ葉を見逃している（押したあと、写真の見逃した場所をタップ）
  const missedBtn = document.getElementById('missedBtn') as HTMLButtonElement | null;
  if (missedBtn) {
    const startMissed = setupMissedMode(view, ctx);
    missedBtn.hidden = false;
    missedBtn.addEventListener('click', startMissed);
  }

  // 確認のポップアップ（「確認してから入れる」のとき）: 候補を 1 つずつ見て、入れるものだけを保存する
  if (state.pendingReview) {
    await img.decode().catch(() => undefined);
    const photo = await ctx.photo();
    const fours = state.detections.map((d, i) => ({ d, i })).filter(x => x.d.label === '四つ葉')
      .sort((a, b) => (b.d.score ?? 0) - (a.d.score ?? 0));
    const original = state.detections;
    const xp: { four: ReturnType<typeof noticeOf> | null } = { four: null };
    const { openFourConfirm } = await import('../components/four-confirm');
    await openFourConfirm({
      photo,
      candidates: fours.map(x => x.d),
      onDone: async summary => {
        // 入れた枠だけを四つ葉として残す（入れなかった枠は、記録に残さない）
        const kept = new Set(summary.kept.map(k => fours[k].i));
        const detections = original.filter((d, i) => d.label !== '四つ葉' || kept.has(i));
        const counts = { three: state.counts.three, four: kept.size };
        let recordId: number | undefined;
        if (kept.size > 0) {
          // 図鑑の写真は、入れた四つ葉の枠のまわりで切り抜く（src/lib/crop.ts）
          const cropped = await cropPhotoRecord(state.imageDataUrl, detections);
          const saved = await saveFourLeafRecord({ date: state.date, imageDataUrl: cropped.imageDataUrl, label: '四つ葉', source: 'photo',
            detections: cropped.detections ?? detections, counts, ...(cropped.crop ? { crop: cropped.crop } : {}) },
            { count: kept.size, photoHash: state.photoHash });
          recordId = saved.id;
          xp.four = saved.progress ? noticeOf(saved.progress) : null;
          sessionStorage.setItem('lastFoundId', String(recordId));
        }
        // 「入れない」は、まちがいの記録に「これは四つ葉じゃない」として足す（端末の中だけ。同じ枠は重ねない）
        for (const k of summary.skipped) {
          const { d, i } = fours[k];
          await saveAnswer(ctx.key, photo, original, { kind: 'not-four', index: i, bbox: d.bbox }).catch(e => console.error(e));
        }
        state = { ...state, detections, counts, recordId, pendingReview: false, reviewed: true, closedEarly: !summary.complete };
        await setLastPhoto(state);
        ctx.detections = detections;
        view.setDetections(detections);
        render();
      },
    });
    showProgressNotice(combineNotices(leafNotice, xp.four), document.getElementById('xpText'));
  }

  // 日記カードを作る（保存した記録があるときだけ。部品とフォントは、押したときに読み込む）
  diaryBtn.addEventListener('click', async () => {
    if (state.recordId == null) return;
    const rec = await getRecord(state.recordId);
    if (!rec) return;
    const { openDiarySheet } = await import('../components/diary-sheet');
    await openDiarySheet({ ...rec, id: state.recordId });
  });

  // Web Share API で写真を共有する
  document.getElementById('shareBtn')?.addEventListener('click', async () => {
    try {
      const blob = await (await fetch(state.imageDataUrl)).blob();
      const file = new File([blob], 'yotsuba.jpg', { type: 'image/jpeg' });
      await navigator.share({ title: '四つ葉を見つけた！', files: [file] });
    } catch {
      // 共有非対応の場合は何もしない
    }
  });
}

init();
