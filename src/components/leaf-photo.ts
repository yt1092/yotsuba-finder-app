// 写真の上に、検出の枠を重ねて出す（見た目は src/lib/box-style.ts。カメラと同じ）
// - 四つ葉: 金色の太い枠・四隅の印・「四つ葉 ●●●」の小さなラベル。枠をタップすると onTap が呼ばれる（大きくして見る・報告など）
// - 三つ葉: 細い白の枠（押せない・ラベルなし）
// 写真の表示のしかた（object-fit: cover / contain）に合わせて、枠の位置を計算する
import type { Detection } from '../lib/detector';
import { devLabel, fourLabel } from '../lib/box-style';
import { DEBUG_BUILD, isDevMode } from '../lib/dev-mode';

const MIN_TAP = 52; // 枠が小さくても、押せる範囲はこの大きさ以上にする

export interface LeafPhotoOptions {
  img: HTMLImageElement;    // 写真（親要素は position: relative にしておく）
  detections: Detection[];  // 写真の座標の枠
  onTap: (detection: Detection, index: number) => void;
  label?: (detection: Detection) => string; // 枠の読み上げ用の名前
}

// 写真の座標と、画面の座標の対応（画面 = 写真 × s + o。img の親要素の左上が 0）
interface Geometry { sx: number; sy: number; ox: number; oy: number }

export class LeafPhoto {
  readonly container: HTMLElement; // 写真と枠を入れている要素（img の親）
  private readonly layer: HTMLElement;
  private boxes: { el: HTMLButtonElement; det: Detection; chip: HTMLElement }[] = [];
  private threes: { el: HTMLElement; det: Detection; chip?: HTMLElement }[] = [];
  detections: Detection[] = []; // 今の枠（全画面で見るときにも使う）
  private markers: { el: HTMLElement; box: Detection['bbox'] }[] = []; // 見逃した場所の印（仮の枠）
  private readonly observer: ResizeObserver;

  constructor(private readonly opts: LeafPhotoOptions) {
    this.container = opts.img.parentElement!;
    this.layer = document.createElement('div');
    this.layer.className = 'leaf-layer';
    opts.img.insertAdjacentElement('afterend', this.layer);
    this.setDetections(opts.detections);
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(opts.img);
    if (!opts.img.complete) opts.img.addEventListener('load', () => this.layout(), { once: true });
  }

  // 枠を出し直す（三つ葉は細い白の枠。数が多くても写真が見えるように、細く、ラベルなし）
  setDetections(detections: Detection[]) {
    this.detections = detections;
    const dev = DEBUG_BUILD && isDevMode(); // 本番のビルドでは、いつも false（デバッグ表示のコードは入らない）
    for (const { el, chip } of this.boxes) { el.remove(); chip.remove(); }
    for (const { el, chip } of this.threes) { el.remove(); chip?.remove(); }
    this.threes = detections.filter(det => det.label !== '四つ葉').map(det => {
      const el = document.createElement('div');
      el.className = 'leaf-three';
      this.layer.append(el);
      // 開発者向けの表示のときだけ、三つ葉にもラベル（クラス・スコア）
      const chip = dev ? this.makeChip(devLabel(det), true) : undefined;
      return { el, det, chip };
    });
    this.boxes = detections
      .map((det, index) => ({ det, index }))
      .filter(({ det }) => det.label === '四つ葉')
      .map(({ det, index }) => {
        const el = document.createElement('button');
        el.type = 'button';
        // 候補（まだ確かめていない四つ葉）は、点線の枠にする
        el.className = det.candidate ? 'leaf-box leaf-box--candidate' : 'leaf-box';
        el.setAttribute('aria-label', this.opts.label?.(det)
          ?? (det.candidate ? '四つ葉の候補。タップすると、大きくして確かめられます' : '四つ葉。タップすると、大きくして見られます'));
        el.addEventListener('click', () => this.opts.onTap(det, index));
        this.layer.append(el);
        const chip = this.makeChip(dev ? `${fourLabel(det.score)}  ${devLabel(det)}` : fourLabel(det.score), dev);
        return { el, det, chip };
      });
    this.layout();
  }

  // 枠の近くの小さなラベル（押せない。読み上げは枠のボタンの名前で行う）
  private makeChip(text: string, dev: boolean): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'leaf-chip';
    // デバッグ表示の見た目（開発用の版だけ。本番のビルドには入らない）
    if (DEBUG_BUILD && dev) Object.assign(chip.style, { fontFamily: 'ui-monospace, monospace', color: '#FFFFFF', background: 'rgba(0,0,0,0.65)', borderColor: 'transparent' });
    chip.setAttribute('aria-hidden', 'true');
    chip.textContent = text;
    this.layer.append(chip);
    return chip;
  }

  // 写真の表示のしかた（object-fit）から、写真の座標と画面の座標の対応を求める
  private geometry(): Geometry | null {
    const { img } = this.opts;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const cw = img.clientWidth, ch = img.clientHeight;
    if (!iw || !ih || !cw || !ch) return null;
    const fit = getComputedStyle(img).objectFit;
    const scale = fit === 'cover' ? Math.max(cw / iw, ch / ih) : fit === 'fill' ? NaN : Math.min(cw / iw, ch / ih);
    const sx = Number.isNaN(scale) ? cw / iw : scale;
    const sy = Number.isNaN(scale) ? ch / ih : scale;
    return { sx, sy, ox: (cw - iw * sx) / 2 + img.offsetLeft, oy: (ch - ih * sy) / 2 + img.offsetTop };
  }

  // 画面の点（タップした場所）を、写真の座標に直す。写真の外（余白）なら null
  toPhotoPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const g = this.geometry();
    if (!g) return null;
    const rect = this.container.getBoundingClientRect();
    const x = (clientX - rect.left - this.container.clientLeft - g.ox) / g.sx;
    const y = (clientY - rect.top - this.container.clientTop - g.oy) / g.sy;
    const { naturalWidth: w, naturalHeight: h } = this.opts.img;
    return x >= 0 && y >= 0 && x <= w && y <= h ? { x, y } : null;
  }

  // 見逃した場所の印（点線の仮の枠と、label の札）を出す。押せるものではない
  addMarker(box: Detection['bbox'], label: string) {
    const el = document.createElement('div');
    el.className = 'leaf-marker';
    const tag = document.createElement('span');
    tag.textContent = label;
    el.append(tag);
    this.layer.append(el);
    this.markers.push({ el, box });
    this.layout();
  }

  // 写真の表示の大きさに合わせて、枠を置き直す
  layout() {
    const g = this.geometry();
    if (!g) return;
    const { sx, sy, ox, oy } = g;
    for (const { el, box } of this.markers) {
      Object.assign(el.style, { left: `${ox + box.x * sx}px`, top: `${oy + box.y * sy}px`, width: `${box.w * sx}px`, height: `${box.h * sy}px` });
    }
    for (const { el, det, chip } of this.threes) {
      const r = { x: ox + det.bbox.x * sx, y: oy + det.bbox.y * sy, w: det.bbox.w * sx, h: det.bbox.h * sy };
      Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      if (chip) this.placeChip(chip, r);
    }
    // 四つ葉のラベルは、スコアの高い順に置き、ほかのラベルと重なるものは出さない（枠は出す）
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const { det, chip } of [...this.boxes].sort((a, b) => (b.det.score ?? 0) - (a.det.score ?? 0))) {
      const p = this.placeChip(chip, { x: ox + det.bbox.x * sx, y: oy + det.bbox.y * sy, w: det.bbox.w * sx, h: det.bbox.h * sy });
      chip.hidden = placed.some(q => p.x < q.x + q.w + 2 && q.x < p.x + p.w + 2 && p.y < q.y + q.h + 2 && q.y < p.y + p.h + 2);
      if (!chip.hidden) placed.push(p);
    }
    for (const { el, det } of this.boxes) {
      const w = det.bbox.w * sx, h = det.bbox.h * sy;
      const tw = Math.max(w, MIN_TAP), th = Math.max(h, MIN_TAP);
      const left = ox + det.bbox.x * sx - (tw - w) / 2;
      const top = oy + det.bbox.y * sy - (th - h) / 2;
      Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${tw}px`, height: `${th}px` });
      // 見た目の枠は、葉の大きさのまま（押せる範囲だけを広げる）
      el.style.setProperty('--ring-x', `${(tw - w) / 2}px`);
      el.style.setProperty('--ring-y', `${(th - h) / 2}px`);
    }
  }

  // ラベルは枠の上に。上に場所がなければ枠の中の上。写真の外にはみ出さないように、左右を寄せる
  private placeChip(chip: HTMLElement, r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    chip.hidden = false;
    const cw = this.container.clientWidth;
    const w = chip.offsetWidth, h = chip.offsetHeight;
    let top = r.y - h - 4;
    if (top < 2) top = r.y + 4;
    const left = Math.max(2, Math.min(r.x, cw - w - 2));
    Object.assign(chip.style, { left: `${left}px`, top: `${top}px` });
    return { x: left, y: top, w, h };
  }
}
