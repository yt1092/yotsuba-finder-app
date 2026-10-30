// 四つ葉の枠をタップしたときに、下から出てくるシート
// その場所を大きくした画像（使う人が、自分の目で葉の数をかぞえられる大きさ）と、ボタンを出す
import type { Detection } from '../lib/detector';
import { drawCrop } from '../lib/verify-run';

type Box = Detection['bbox'];

// 大きくした画像の中で、葉の長い辺が占める割合（まわりも少し見えるように）
const ZOOM_FRACTION = 0.55;

export interface SheetButton {
  label: string;
  kind: 'primary' | 'secondary' | 'text';
  // 押したときの処理。シートの「お知らせ」の欄に文を出せる。true を返すとシートを閉じる
  onClick: (sheet: LeafSheet) => void | boolean | Promise<void | boolean>;
}

export interface LeafSheetOptions {
  image: CanvasImageSource & { width: number; height: number }; // 元の写真
  box: Box;              // 葉の枠（写真の座標）
  title: string;
  hint?: string;         // 画像の下の、短い説明
  buttons: SheetButton[];
}

export class LeafSheet {
  private readonly backdrop: HTMLElement;
  private readonly message: HTMLElement;
  private readonly lastFocus = document.activeElement as HTMLElement | null;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };

  constructor(opts: LeafSheetOptions) {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'sheet-backdrop';
    this.backdrop.addEventListener('click', e => { if (e.target === this.backdrop) this.close(); });

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', opts.title);

    const head = document.createElement('div');
    head.className = 'sheet-head';
    const h = document.createElement('h2');
    h.textContent = opts.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-icon';
    close.setAttribute('aria-label', 'とじる');
    close.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', () => this.close());
    head.append(h, close);

    // 大きくした画像（画面の幅いっぱい。くっきり見えるように、画面の画素の細かさに合わせて描く）
    const side = Math.max(opts.box.w, opts.box.h) / ZOOM_FRACTION;
    const crop = { x: opts.box.x + opts.box.w / 2 - side / 2, y: opts.box.y + opts.box.h / 2 - side / 2, size: side };
    const px = Math.round(Math.min(window.innerWidth, 480) * Math.min(window.devicePixelRatio || 1, 3));
    const { canvas } = drawCrop(opts.image, crop, px, '#E9EFE2');
    canvas.className = 'sheet-zoom';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '葉を大きくした写真');

    const hint = document.createElement('p');
    hint.className = 'sheet-hint';
    hint.textContent = opts.hint ?? '';
    hint.hidden = !opts.hint;

    this.message = document.createElement('p');
    this.message.className = 'sheet-message';
    this.message.setAttribute('role', 'status');
    this.message.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'sheet-actions';
    for (const b of opts.buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = b.kind === 'primary' ? 'btn-primary' : b.kind === 'secondary' ? 'btn-secondary' : 'btn-text-link';
      el.textContent = b.label;
      el.addEventListener('click', async () => {
        if (el.disabled) return;
        el.disabled = true;
        try {
          if ((await b.onClick(this)) === true) this.close();
        } finally {
          el.disabled = false;
        }
      });
      actions.append(el);
    }

    sheet.append(head, canvas, hint, this.message, actions);
    this.backdrop.append(sheet);
    document.body.append(this.backdrop);
    document.addEventListener('keydown', this.onKey);
    close.focus();
  }

  // お知らせの欄に文を出す（tone: ふつう / よい知らせ / 気をつけて）
  say(text: string, tone: 'info' | 'good' | 'caution' = 'info') {
    this.message.textContent = text;
    this.message.dataset.tone = tone;
    this.message.hidden = !text;
  }

  close() {
    document.removeEventListener('keydown', this.onKey);
    this.backdrop.remove();
    this.lastFocus?.focus?.();
  }
}
