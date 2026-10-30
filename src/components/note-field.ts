// ひとことの入力欄（「23/50」のように文字数を出す）
// 日記カードのシートと、図鑑の詳細の「ひとことを直す」シートで使う
// 50 文字を超えているあいだは、保存しない（前に保存した長いひとことを、勝手に切りつめないため）
import { cleanNote, noteLength, NOTE_MAX } from '../lib/diary-text';

export interface NoteField {
  element: HTMLElement;
  input: HTMLInputElement;
  value: () => string;   // 整えたひとこと
  fits: () => boolean;   // 50 文字以内か
}

// onInput: 文字が変わるたびに呼ぶ（50 文字以内かどうかも渡す）
export function createNoteField(initial: string, onInput?: (note: string, fits: boolean) => void): NoteField {
  const element = document.createElement('label');
  element.className = 'note-field';
  element.innerHTML = `
    <span class="note-field-head">
      <span>ひとこと（なくても いいよ）</span>
      <span class="note-field-count" aria-live="polite"></span>
    </span>
    <input type="text" enterkeyhint="done" autocomplete="off">
    <span class="note-field-over" hidden>${NOTE_MAX}文字までに してね</span>`;
  const input = element.querySelector('input')!;
  const count = element.querySelector('.note-field-count') as HTMLElement;
  const over = element.querySelector('.note-field-over') as HTMLElement;
  input.value = initial;

  const value = () => cleanNote(input.value);
  const fits = () => noteLength(value()) <= NOTE_MAX;
  const update = () => {
    const ok = fits();
    count.textContent = `${noteLength(value())}/${NOTE_MAX}`;
    element.classList.toggle('note-field--over', !ok);
    over.hidden = ok;
    input.setAttribute('aria-invalid', String(!ok));
  };
  input.addEventListener('input', () => {
    update();
    onInput?.(value(), fits());
  });
  update();
  return { element, input, value, fits };
}
