// 「日記カードを作る」のシート: プレビューを見ながら、色とひとことを選び、てがきで書いて、共有する
// カードは端末の中だけで作る（src/lib/diary-card.ts）。共有できないときは、画像を長押しして保存してもらう
import '../styles/diary.css';
import type { CloverRecord } from '../lib/db';
import { updateNote, updateRecord } from '../lib/db';
import { drawDiaryCard, cardToBlob, type DiaryTheme } from '../lib/diary-card';
import { cleanNote, diaryDate, fileDate } from '../lib/diary-text';
import { createNoteField } from './note-field';
import { dataUrlToBlob } from '../lib/data-url';
import { recordProgress } from '../lib/progress-db';
import { showProgressResult } from './progress-notice';
import { hasInk, parseInk, type Ink } from '../lib/ink';
import { openInkEditor, type InkEditor } from './ink-editor';

const THEME_NAMES: Record<DiaryTheme, string> = { cream: 'クリーム', green: 'うすい緑' };

export async function openDiarySheet(rec: CloverRecord & { id: number }, onNoteSaved?: (note: string) => void, onInkSaved?: (ink: Ink) => void) {
  const photo = await createImageBitmap(dataUrlToBlob(rec.imageDataUrl), { imageOrientation: 'from-image' });
  // 四つ葉の枠（いちばん自信のあるもの）を中心に切り抜く。枠が無い記録は、写真の真ん中
  const focus = [...(rec.detections ?? [])].filter(d => d.label === '四つ葉').sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.bbox;

  let theme: DiaryTheme = rec.diaryTheme ?? 'cream';
  let note = cleanNote(rec.note ?? '');
  let blob: Blob | null = null;
  let url = '';
  let drawing = 0;
  let counted = false;
  let ink = parseInk(rec.ink);          // 手書き（前に書いたものから、続きを書ける）
  let editor: InkEditor | null = null;  // 書いているあいだだけ
  let closed = false;

  const backdrop = document.createElement('div');
  // 画面の真ん中に出す、大きなポップアップ（横幅は画面の 92%、高さは最大で 90%。中はスクロールできる）
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="日記カード">
      <div class="sheet-head">
        <h2>日記カード</h2>
        <button type="button" class="btn-icon" data-close aria-label="とじる">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="diary-preview">
        <img alt="" data-preview>
        <div class="spinner" data-spinner></div>
      </div>
      <div class="diary-themes" role="radiogroup" aria-label="カードの色">
        ${(Object.keys(THEME_NAMES) as DiaryTheme[]).map(k => `
          <button type="button" role="radio" class="diary-theme diary-theme--${k}" data-theme="${k}" aria-checked="${k === theme}">
            <span class="diary-swatch" aria-hidden="true"></span>${THEME_NAMES[k]}
          </button>`).join('')}
      </div>
      <button type="button" class="btn-secondary diary-ink-btn" data-ink>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/></svg>
        てがきで かく
      </button>
      <div data-note-slot></div>
      <p class="sheet-message" data-message role="status" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn-primary" data-share>共有する</button>
      </div>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string) => backdrop.querySelector(sel) as T;
  const preview = $<HTMLImageElement>('[data-preview]');
  const spinner = $<HTMLElement>('[data-spinner]');
  const message = $<HTMLElement>('[data-message]');
  const shareBtn = $<HTMLButtonElement>('[data-share]');
  preview.alt = `${diaryDate(rec.date)}の日記カード`;

  const say = (text: string) => { message.textContent = text; message.hidden = !text; };

  // カードを描き直して、プレビューに出す（古い画像の URL は解放する）
  async function redraw() {
    const ticket = ++drawing;
    spinner.hidden = false;
    shareBtn.disabled = true;
    // 書いているあいだは、手書きを書く層に出すので、カードには描かない
    const canvas = await drawDiaryCard({ photo, focus, date: rec.date, counts: rec.counts, source: rec.source, note, theme, ink: editor ? undefined : ink });
    const next = await cardToBlob(canvas);
    if (ticket !== drawing) return; // もっと新しい描き直しが始まっていたら、それに任せる
    blob = next;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    preview.src = url;
    spinner.hidden = true;
    shareBtn.disabled = false;
    // 経験値: 日記カードを作ったら 30 点（1 つの記録につき 1 回まで）
    if (!counted) {
      counted = true;
      showProgressResult(await recordProgress({ kind: 'diary', recordId: rec.id }).catch(() => null));
    }
  }

  backdrop.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach(btn => btn.addEventListener('click', () => {
    theme = btn.dataset.theme as DiaryTheme;
    backdrop.querySelectorAll('[data-theme]').forEach(b => b.setAttribute('aria-checked', String(b === btn)));
    if (hasInk(ink)) updateRecord(rec.id, { diaryTheme: theme });
    redraw();
  }));

  // てがきで かく: プレビューの上に書く層を重ね、色・ひとこと・共有は、おわるまで隠す
  const inkBtn = $<HTMLButtonElement>('[data-ink]');
  const editingHides = () => [inkBtn, $<HTMLElement>('.diary-themes'), backdrop.querySelector<HTMLElement>('.note-field'), $<HTMLElement>('.sheet-actions'), message];
  inkBtn.addEventListener('click', () => {
    if (editor) return;
    for (const el of editingHides()) if (el) el.hidden = true;
    editor = openInkEditor({
      stage: $<HTMLElement>('.diary-preview'),
      after: $<HTMLElement>('.diary-preview'),
      initial: ink,
      onDone: async next => {
        editor = null;
        ink = next;
        for (const el of editingHides()) if (el && el !== message) el.hidden = false;
        await updateRecord(rec.id, { ink, diaryTheme: theme });
        rec.ink = ink;
        onInkSaved?.(ink);
        if (!closed) redraw();
        if (hasInk(ink)) showProgressResult(await recordProgress({ kind: 'ink' }).catch(() => null));
      },
    });
    redraw(); // 手書きを、カードから書く層にうつす
  });

  // ひとこと: 打ち終わって少ししたら、記録に保存して、カードを描き直す（50 文字を超えているあいだは、保存しない）
  let typingTimer = 0;
  const field = createNoteField(note, (next, fits) => {
    window.clearTimeout(typingTimer);
    if (!fits) return;
    typingTimer = window.setTimeout(async () => {
      note = next;
      await updateNote(rec.id, note);
      if (note) showProgressResult(await recordProgress({ kind: 'note' }).catch(() => null));
      rec.note = note;
      onNoteSaved?.(note);
      redraw();
    }, 500);
  });
  $<HTMLElement>('[data-note-slot]').replaceWith(field.element);

  // キーボードが出たとき: 見えている範囲（visualViewport）に合わせてポップアップを収め直し、入力欄が見えるようにする
  const vv = window.visualViewport;
  const fitViewport = () => {
    if (!vv) return;
    backdrop.style.setProperty('--vv-top', `${vv.offsetTop}px`);
    backdrop.style.setProperty('--vv-h', `${vv.height}px`);
  };
  vv?.addEventListener('resize', fitViewport);
  vv?.addEventListener('scroll', fitViewport);
  fitViewport();
  field.input.addEventListener('focus', () => {
    window.setTimeout(() => field.input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  });

  // 共有: iPhone の共有画面を開く。使えないときは、画像を長押しして保存してもらう
  shareBtn.addEventListener('click', async () => {
    if (!blob) return;
    const file = new File([blob], `yotsuba-diary-${fileDate(rec.date)}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        say('');
      } catch (e) {
        if ((e as DOMException).name !== 'AbortError') say('共有できませんでした。上の画像を 長押しすると、ほぞんできます');
      }
    } else {
      say('上の画像を 長押しすると、ほぞんできます');
      preview.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  const close = () => {
    closed = true;
    editor?.finish(); // 書いている途中でとじても、書いたものは残す
    window.clearTimeout(typingTimer);
    drawing++;
    if (url) URL.revokeObjectURL(url);
    photo.close();
    vv?.removeEventListener('resize', fitViewport);
    vv?.removeEventListener('scroll', fitViewport);
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $<HTMLButtonElement>('[data-close]').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  document.body.append(backdrop);
  $<HTMLButtonElement>('[data-close]').focus();
  await redraw();
}
