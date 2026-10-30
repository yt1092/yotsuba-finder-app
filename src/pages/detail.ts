// Detail（記録の詳細）画面の初期化
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';
import { getRecord, deleteRecord, updateRecord } from '../lib/db';
import { confirmCandidate, confirmedCounts } from '../lib/auto-verify';
import { leafCountMessage } from '../lib/leaf-count';
import { updateNote } from '../lib/db';
import { createNoteField } from '../components/note-field';
import { VERIFY_STEP } from '../lib/detector-config';
import { setupLeafInspect } from '../components/leaf-inspect';
import { feedbackButtons, photoOnce, setupMissedMode, type FeedbackContext } from '../components/feedback-ui';
import { recordProgress } from '../lib/progress-db';
import { showProgressResult } from '../components/progress-notice';
import { hasInk, parseInk, type Ink } from '../lib/ink';
import type { CloverRecord } from '../lib/db';
import { GACHA_MODEL_NOTE, gachaAlt, gachaSource } from '../lib/gacha';
import { fitGachaImage } from '../lib/gacha-image';

injectSvgDefs();

async function init() {
  // URL パラメータから表示する記録の ID を取得する
  const params = new URLSearchParams(location.search);
  const id = Number(params.get('id'));
  if (!id) {
    location.href = 'collection.html';
    return;
  }

  const rec = await getRecord(id);
  if (!rec) {
    location.href = 'collection.html';
    return;
  }

  // 写真を表示する
  const img = document.getElementById('detailImg') as HTMLImageElement;
  if (img) {
    img.src = rec.imageDataUrl;
    // 今日のよつばの絵は、切り抜かずに、形の全体を見せる（下のシートが重なる 40px と、少しの余白を空ける。src/lib/gacha-image.ts）
    if (rec.source === 'gacha') {
      img.style.boxSizing = 'border-box';
      img.style.padding = '12px 12px 52px';
      fitGachaImage(img, img.parentElement!);
    }
    img.addEventListener('load', () => {
      if (img.naturalHeight > img.naturalWidth * 1.1) img.parentElement!.style.height = 'min(70dvh, 620px)';
    }, { once: true });
    // 四つ葉の枠をタップすると、その場所を大きくして見られる（枠を持っている記録だけ。シートで、まちがいも報告できる）
    const ctx: FeedbackContext = { key: `record:${id}`, detections: rec.detections ?? [], photo: photoOnce(img) };
    const view = setupLeafInspect({
      img, detections: ctx.detections, verify: VERIFY_STEP,
      extraButtons: (det, index) => feedbackButtons(ctx, det, index),
      // 候補（まだ確かめていない四つ葉）を確かめて通ったら、記録を直す（四つ葉として数える）
      onVerdict: async (det, index, verdict) => {
        if (verdict !== 'four' || !det.candidate) return;
        const detections = confirmCandidate(ctx.detections, index);
        const counts = confirmedCounts(detections);
        await updateRecord(id, { detections, counts });
        ctx.detections = detections;
        rec.detections = detections;
        rec.counts = counts;
        view.setDetections(detections);
        const countsEl = document.getElementById('detailCounts');
        if (countsEl) { countsEl.textContent = leafCountMessage(counts); countsEl.hidden = false; }
        return '記録を直しました';
      },
    });
    // 「…」のメニュー: 四つ葉を見逃している（子どもがうっかり触らないように、メニューの中に入れる）
    const startMissed = setupMissedMode(view, ctx);
    document.getElementById('moreBtn')?.addEventListener('click', () => openMoreMenu(startMissed));
  }

  // ラベル（四つ葉 / 三つ葉）を表示する
  const labelEl = document.getElementById('detailLabel');
  if (labelEl) labelEl.textContent = rec.label;

  // 「今日のよつば」の記録: 写真ではないこと（形の出どころ。かならず出す）を書き、まちがいの報告（「…」のメニュー）は出さない
  // 端末の中のモデルが作った形には、「数式で作った形で学習したモデルです」も小さく書く
  if (rec.source === 'gacha') {
    const kind = rec.gachaKind ?? 'preset';
    if (img) img.alt = gachaAlt(kind);
    const tag = document.getElementById('detailGacha');
    if (tag) { tag.textContent = gachaSource(kind); tag.hidden = false; }
    const model = document.getElementById('detailGachaModel');
    if (model && kind === 'dit') { model.textContent = GACHA_MODEL_NOTE; model.hidden = false; }
    const more = document.getElementById('moreBtn');
    if (more) more.hidden = true;
    document.querySelector<HTMLAnchorElement>('a[aria-label="戻る"]')?.setAttribute('href', 'collection.html?tab=gacha'); // 戻る先は、今日のよつばの一覧
  }

  if (rec.photoMissing) document.getElementById('detailNoPhoto')?.removeAttribute('hidden');

  // 日時を Nunito フォントで表示する
  const dateEl = document.getElementById('detailDate');
  if (dateEl) {
    const d = new Date(rec.date);
    dateEl.textContent =
      `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // 写真から探したときの葉の数（写真の結果の画面と同じ文）
  const countsEl = document.getElementById('detailCounts');
  if (countsEl && rec.counts) {
    countsEl.textContent = leafCountMessage(rec.counts);
    countsEl.hidden = false;
  }

  // ひとこと（日記カードにも書く。タップで直せる。前の「メモ」も、ここに引き継いである）
  const noteText = document.getElementById('noteText');
  const showNote = (note: string) => { if (noteText) noteText.textContent = note || '（まだ ありません。タップして 書く）'; };
  if (noteText) {
    showNote(rec.note ?? '');
    noteText.addEventListener('click', () => openNoteEditor(rec.note ?? '', async note => {
      rec.note = note;
      await updateNote(id, note);
      showNote(note);
      if (note) showProgressResult(await recordProgress({ kind: 'note' }).catch(() => null));
    }));
  }

  // 日記カードを作る（四つ葉の記録だけ。カードを作る部品とフォントは、押したときに読み込む）
  const diaryBtn = document.getElementById('diaryBtn') as HTMLButtonElement | null;
  if (rec.label === '四つ葉' && diaryBtn) {
    const openDiary = async () => {
      const { openDiarySheet } = await import('../components/diary-sheet');
      await openDiarySheet({ ...rec, id }, note => { rec.note = note; showNote(note); }, (ink: Ink) => {
        rec.ink = ink;
        showInkCard(rec);
      });
    };
    diaryBtn.hidden = false;
    diaryBtn.addEventListener('click', openDiary);
    document.getElementById('inkCard')?.addEventListener('click', openDiary);
    showInkCard(rec);
  }

  // 削除ボタン
  document.getElementById('deleteBtn')?.addEventListener('click', async () => {
    if (confirm('この記録を削除しますか？')) {
      await deleteRecord(id);
      location.href = rec.source === 'gacha' ? 'collection.html?tab=gacha' : 'collection.html'; // 今日のよつばは、今日のよつばの一覧へ戻る
    }
  });

  // 共有ボタン（Web Share API）
  document.getElementById('shareBtn')?.addEventListener('click', async () => {
    try {
      const blob = await (await fetch(rec.imageDataUrl)).blob();
      const file = new File([blob], 'yotsuba.jpg', { type: 'image/jpeg' });
      await navigator.share({ title: rec.source === 'gacha' ? '今日のよつば' : `${rec.label}を見つけた！`, files: [file] });
    } catch {
      // 共有非対応の場合は何もしない
    }
  });
}

// 手書きがあれば、日記カードの小さな見本を出す（なければ、今まで通り出さない）
let inkCardUrl = '';
async function showInkCard(rec: CloverRecord) {
  const box = document.getElementById('inkCard') as HTMLButtonElement | null;
  const img = document.getElementById('inkCardImg') as HTMLImageElement | null;
  if (!box || !img) return;
  const ink = parseInk(rec.ink);
  if (!hasInk(ink)) { box.hidden = true; return; }
  const [{ drawDiaryCard, cardToBlob }, { dataUrlToBlob }] = await Promise.all([import('../lib/diary-card'), import('../lib/data-url')]);
  const photo = await createImageBitmap(dataUrlToBlob(rec.imageDataUrl), { imageOrientation: 'from-image' });
  const focus = [...(rec.detections ?? [])].filter(d => d.label === '四つ葉').sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.bbox;
  const canvas = await drawDiaryCard({ photo, focus, date: rec.date, counts: rec.counts, source: rec.source, note: rec.note ?? '', theme: rec.diaryTheme ?? 'cream', ink });
  photo.close();
  const blob = await cardToBlob(canvas);
  if (inkCardUrl) URL.revokeObjectURL(inkCardUrl);
  inkCardUrl = URL.createObjectURL(blob);
  img.src = inkCardUrl;
  box.hidden = false;
}

// ひとことを直すシート（文字数つき。50 文字を超えているあいだは、保存できない）
function openNoteEditor(current: string, save: (note: string) => Promise<void>) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="ひとことを直す">
      <div class="sheet-head">
        <h2>ひとこと</h2>
        <button type="button" class="btn-icon" data-close aria-label="とじる">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div data-slot></div>
      <div class="sheet-actions">
        <button type="button" class="btn-primary" data-save>保存する</button>
      </div>
    </div>`;
  const saveBtn = backdrop.querySelector('[data-save]') as HTMLButtonElement;
  const field = createNoteField(current, (_note, fits) => { saveBtn.disabled = !fits; });
  saveBtn.disabled = !field.fits();
  backdrop.querySelector('[data-slot]')!.replaceWith(field.element);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]')!.addEventListener('click', close);
  saveBtn.addEventListener('click', async () => {
    if (!field.fits()) return;
    await save(field.value());
    close();
  });
  document.body.append(backdrop);
  field.input.focus();
}

// 「…」のメニュー（下から出るシート）
function openMoreMenu(startMissed: () => void) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="その他">
      <div class="sheet-head">
        <h2>その他</h2>
        <button type="button" class="btn-icon" data-close aria-label="とじる">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn-secondary" data-missed>四つ葉を見逃している</button>
      </div>
    </div>`;
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]')!.addEventListener('click', close);
  backdrop.querySelector('[data-missed]')!.addEventListener('click', () => { close(); startMissed(); });
  document.body.append(backdrop);
  (backdrop.querySelector('[data-close]') as HTMLElement).focus();
}

init();
