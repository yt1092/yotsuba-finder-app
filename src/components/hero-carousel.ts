// ホームの大きな画像（ヒーロー）を、イラストと見つけた四つ葉の写真で、順番に切り替える
// - 写真が 0 枚なら、イラストのまま（タイマーもドットも出さない）
// - 7 秒ごとにフェードで次へ。最後まで行ったら最初に戻る
// - ドット（押すとその画像へ）と、左右になぞる操作でも移れる。触っている間はタイマーを止める
// - 画面が見えていない間と、OS の「視差効果を減らす」がオンのときは、自動では切り替えない
import type { HeroSlide } from '../lib/hero-slides';
import { dataUrlToBlob } from '../lib/data-url';

const INTERVAL_MS = 7000; // 自動で切り替える間隔
const SWIPE_PX = 40;      // これ以上、横になぞったら前後に移る
const TAP_PX = 10;        // これ未満の動きなら「タップ」とみなす

export class HeroCarousel {
  private slideEls: HTMLElement[] = [];
  private objectUrls: string[] = []; // 写真を表示するために作った URL（不要になったら解放する）
  private index = 0;
  private timerId = 0;
  private touching = false;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private readonly root: HTMLElement,          // スライドを重ねる枠
    private readonly illustration: HTMLElement,  // 最初のイラスト（HTML に書いてあるもの）
    private readonly dots: HTMLElement,          // ドットの列
  ) {
    this.setupSwipe();
    this.setupDots();
    document.addEventListener('visibilitychange', () => this.restartTimer());
    this.reducedMotion.addEventListener('change', () => this.restartTimer());
  }

  // スライドを作り直す（ホームを開いたとき・戻ってきたとき）
  setSlides(slides: HeroSlide[]) {
    this.clearPhotos();
    this.slideEls = slides.map(slide => (slide.kind === 'illustration' ? this.illustration : this.createPhotoSlide(slide)));
    for (const el of this.slideEls) if (el !== this.illustration) this.root.insertBefore(el, this.dots);

    this.dots.hidden = slides.length <= 1;
    this.dots.innerHTML = slides.map(() => '<span class="hero-dot"></span>').join('');
    this.dots.setAttribute('aria-valuemax', String(slides.length));
    this.show(0);
  }

  // 作った写真の要素と URL を片付ける（メモリを増やさないため、URL は必ず解放する）
  dispose() {
    window.clearTimeout(this.timerId);
    this.clearPhotos();
    this.slideEls = [];
  }

  private clearPhotos() {
    for (const el of this.slideEls) if (el !== this.illustration) el.remove();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  // 写真のスライド。タップすると、図鑑のその記録の詳細を開く
  private createPhotoSlide(slide: Extract<HeroSlide, { kind: 'photo' }>): HTMLElement {
    const url = URL.createObjectURL(dataUrlToBlob(slide.imageDataUrl));
    this.objectUrls.push(url);
    const d = new Date(slide.date);
    const a = document.createElement('a');
    a.className = 'hero-slide';
    a.href = `detail.html?id=${slide.id}`;
    a.setAttribute('aria-label', `${d.getMonth() + 1}月${d.getDate()}日に見つけた四つ葉`);
    a.draggable = false;
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;
    a.append(img);
    return a;
  }

  // i 番目のスライドを表示する
  private show(i: number) {
    const n = this.slideEls.length;
    if (n === 0) return;
    this.index = ((i % n) + n) % n;
    this.slideEls.forEach((el, k) => {
      const active = k === this.index;
      el.classList.toggle('hero-slide--active', active);
      el.setAttribute('aria-hidden', String(!active));
      if (el instanceof HTMLAnchorElement) el.tabIndex = active ? 0 : -1;
    });
    [...this.dots.children].forEach((dot, k) => dot.classList.toggle('hero-dot--active', k === this.index));
    this.dots.setAttribute('aria-valuenow', String(this.index + 1));
    this.dots.setAttribute('aria-valuetext', `${this.index + 1}枚目（全${n}枚）`);
    this.restartTimer();
  }

  // 自動切り替えのタイマーを、今の状態に合わせて掛け直す
  private restartTimer() {
    window.clearTimeout(this.timerId);
    const auto = this.slideEls.length > 1 && !this.touching && !document.hidden && !this.reducedMotion.matches;
    if (auto) this.timerId = window.setTimeout(() => this.show(this.index + 1), INTERVAL_MS);
  }

  // 左右になぞると前後に移る。縦のスクロールはブラウザに任せる（CSS の touch-action: pan-y）
  private setupSwipe() {
    let startX = 0, startY = 0, moved = false, pointerId = -1;
    this.root.addEventListener('pointerdown', e => {
      if (this.slideEls.length <= 1 || this.dots.contains(e.target as Node)) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      this.touching = true;
      this.restartTimer();
    });
    this.root.addEventListener('pointermove', e => {
      if (e.pointerId !== pointerId) return;
      if (Math.abs(e.clientX - startX) > TAP_PX || Math.abs(e.clientY - startY) > TAP_PX) moved = true;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = -1;
      this.touching = false;
      const dx = e.clientX - startX;
      if (e.type === 'pointerup' && Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - startY)) {
        this.show(this.index + (dx < 0 ? 1 : -1));
      } else {
        this.restartTimer();
      }
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
    // なぞったあとの click では、写真の詳細を開かない
    this.root.addEventListener('click', e => { if (moved) { e.preventDefault(); moved = false; } }, true);
  }

  // ドットの列: 押した位置にいちばん近いドットの画像へ移る。なぞって選ぶこともできる
  // （列全体を 1 つの押せる範囲にして、高さ 48px・幅いっぱいを確保する）
  private setupDots() {
    const pick = (clientX: number) => {
      const r = this.dots.getBoundingClientRect();
      const n = this.slideEls.length;
      const k = Math.min(n - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * n)));
      if (k !== this.index) this.show(k);
    };
    let dragging = false;
    this.dots.addEventListener('pointerdown', e => {
      dragging = true;
      this.touching = true;
      try { this.dots.setPointerCapture(e.pointerId); } catch { /* 捕まえられなくても、押した位置への移動はできる */ }
      pick(e.clientX);
      window.clearTimeout(this.timerId);
    });
    this.dots.addEventListener('pointermove', e => { if (dragging) pick(e.clientX); });
    const end = () => { dragging = false; this.touching = false; this.restartTimer(); };
    this.dots.addEventListener('pointerup', end);
    this.dots.addEventListener('pointercancel', end);
    this.dots.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.show(this.index + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.show(this.index - 1);
      else if (e.key === 'Home') this.show(0);
      else if (e.key === 'End') this.show(this.slideEls.length - 1);
      else return;
      e.preventDefault();
    });
  }
}
