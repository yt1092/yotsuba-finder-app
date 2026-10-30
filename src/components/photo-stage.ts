// 写真を全画面で見る・見逃した四つ葉の場所に枠をつける（ピンチで拡大・縮小、ドラッグで移動）
// - mode 'view': 見るだけ（見つかった四つ葉の枠も出す）
// - mode 'mark': 写真をタップすると枠が出る。枠はドラッグで動かし、四隅のつまみで大きさを変える
//   動かしている間は、指に隠れないように、指の少し上にルーペ（拡大図）を出す。「決定」「やり直し」「やめる」
import type { Detection } from '../lib/detector';
import { initialMissedSize, moveBox, provisionalBox, resizeBox, type Corner } from '../lib/feedback';
import { pickBox } from '../lib/pick-box';
import { drawCrop } from '../lib/verify-run';

type Box = Detection['bbox'];

export interface PhotoStageOptions {
  photo: ImageBitmap;          // 写真（向きを直したもの。枠と同じ座標）
  detections: Detection[];     // 見つかった枠（四つ葉の枠を出す・最初の大きさの目安にする）
  mode: 'view' | 'mark';
  onDecide?: (box: Box) => void | Promise<void>; // mark: 「決定」を押したとき（写真の座標の枠）
  // view: 四つ葉の枠をタップしたとき（detections の何番目か）。シートを開く
  onPickFound?: (index: number) => void;
  // view: 今の枠（候補を確かめて通ったあとなど、変わったときに、出し直すため）
  getDetections?: () => Detection[];
}

const MAX_ZOOM = 6;
const TAP_PX = 8;          // これより動いたら、タップではなくドラッグ
const LOUPE = 132;          // ルーペの大きさ（px）
const LOUPE_ZOOM = 2.5;     // ルーペの中の拡大（今の表示に対して）

export function openPhotoStage(opts: PhotoStageOptions): void {
  const { photo } = opts;
  const W = photo.width, H = photo.height;

  const root = document.createElement('div');
  root.className = 'stage';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', opts.mode === 'mark' ? '見逃した四つ葉に、印をつける' : '写真を大きく見る');
  root.innerHTML = `
    <p class="stage-guide" role="status"></p>
    <div class="stage-area">
      <canvas class="stage-photo"></canvas>
      <div class="stage-boxes"></div>
      <canvas class="stage-loupe" width="${LOUPE * 2}" height="${LOUPE * 2}" hidden></canvas>
    </div>
    <div class="stage-actions"></div>`;
  const guide = root.querySelector('.stage-guide') as HTMLElement;
  const area = root.querySelector('.stage-area') as HTMLElement;
  const canvas = root.querySelector('.stage-photo') as HTMLCanvasElement;
  const boxesLayer = root.querySelector('.stage-boxes') as HTMLElement;
  const loupe = root.querySelector('.stage-loupe') as HTMLCanvasElement;
  const actions = root.querySelector('.stage-actions') as HTMLElement;
  const g = canvas.getContext('2d')!;
  const lg = loupe.getContext('2d')!;

  // 表示: 写真の点 p → 画面（area の中）の点 = off + p * scale
  let fit = 1, scale = 1, offX = 0, offY = 0;
  let box: Box | null = null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  const resetView = () => {
    const r = area.getBoundingClientRect();
    fit = Math.min(r.width / W, r.height / H);
    scale = fit;
    offX = (r.width - W * scale) / 2;
    offY = (r.height - H * scale) / 2;
  };
  // 拡大しすぎ・写真が画面から外れすぎないようにする
  const clampView = () => {
    const r = area.getBoundingClientRect();
    scale = Math.min(Math.max(scale, fit), fit * MAX_ZOOM);
    const w = W * scale, h = H * scale;
    offX = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, offX));
    offY = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, offY));
  };
  const toPhoto = (clientX: number, clientY: number) => {
    const r = area.getBoundingClientRect();
    return { x: (clientX - r.left - offX) / scale, y: (clientY - r.top - offY) / scale };
  };

  const draw = () => {
    const r = area.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0B1A10';
    g.fillRect(0, 0, r.width, r.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(photo, offX, offY, W * scale, H * scale);
    renderBoxes();
  };

  // 枠: 見つかった四つ葉（見るだけのとき）と、つけている枠（印をつけるとき）
  const renderBoxes = () => {
    boxesLayer.replaceChildren();
    if (opts.mode === 'view') {
      for (const d of currentDetections().filter(d => d.label === '四つ葉')) {
        const el = document.createElement('div');
        el.className = 'stage-found' + (d.candidate ? ' stage-found--candidate' : '');
        place(el, d.bbox);
        boxesLayer.append(el);
      }
      return;
    }
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'stage-box';
    el.setAttribute('aria-label', '仮の枠。ドラッグで動かせます');
    place(el, box);
    const tag = document.createElement('span');
    tag.className = 'stage-box-tag';
    tag.textContent = '仮の枠';
    el.append(tag);
    for (const c of ['nw', 'ne', 'sw', 'se'] as Corner[]) {
      const h = document.createElement('div');
      h.className = `stage-handle stage-handle--${c}`;
      h.dataset.corner = c;
      h.setAttribute('aria-label', '大きさを変える');
      el.append(h);
    }
    boxesLayer.append(el);
  };
  const currentDetections = () => opts.getDetections?.() ?? opts.detections;
  const screenRect = (b: Box) => ({ x: offX + b.x * scale, y: offY + b.y * scale, w: b.w * scale, h: b.h * scale });

  // 見るだけのとき: タップした場所の四つ葉の枠を選ぶ（半径 24px 以内のいちばん近い枠。決められなければ一覧から）
  const pickAt = (clientX: number, clientY: number) => {
    const r = area.getBoundingClientRect();
    const fours = currentDetections().map((d, index) => ({ d, index })).filter(({ d }) => d.label === '四つ葉');
    const result = pickBox(clientX - r.left, clientY - r.top, fours.map(({ d }) => screenRect(d.bbox)));
    if (result.kind === 'one') opts.onPickFound?.(fours[result.index].index);
    else if (result.kind === 'choose') openChooser(result.indices.map(i => fours[i]));
  };

  // 枠が重なって決められないとき: 小さな切り抜きの一覧から、選んでもらう
  const openChooser = (items: { d: Detection; index: number }[]) => {
    const panel = document.createElement('div');
    panel.className = 'stage-chooser';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'どの葉かな');
    const title = document.createElement('p');
    title.textContent = 'どの葉かな？ えらんでね';
    const list = document.createElement('div');
    list.className = 'stage-chooser-list';
    for (const { d, index } of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stage-chooser-item';
      b.setAttribute('aria-label', 'この葉をえらぶ');
      const side = Math.max(d.bbox.w, d.bbox.h) / 0.6;
      const { canvas: thumb } = drawCrop(photo, { x: d.bbox.x + d.bbox.w / 2 - side / 2, y: d.bbox.y + d.bbox.h / 2 - side / 2, size: side }, 192, '#0B1A10');
      b.append(thumb);
      b.addEventListener('click', () => { panel.remove(); opts.onPickFound?.(index); });
      list.append(b);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = 'やめる';
    cancel.addEventListener('click', () => panel.remove());
    panel.append(title, list, cancel);
    root.append(panel);
  };

  const place = (el: HTMLElement, b: Box) => {
    Object.assign(el.style, { left: `${offX + b.x * scale}px`, top: `${offY + b.y * scale}px`, width: `${b.w * scale}px`, height: `${b.h * scale}px` });
  };

  // ルーペ: 指の少し上に、指の下の写真を拡大して出す（枠も描く）
  const showLoupe = (clientX: number, clientY: number) => {
    const r = area.getBoundingClientRect();
    const p = toPhoto(clientX, clientY);
    const zoom = scale * LOUPE_ZOOM;
    const left = Math.min(Math.max(clientX - r.left - LOUPE / 2, 4), r.width - LOUPE - 4);
    const top = Math.max(clientY - r.top - LOUPE - 72, 4);
    Object.assign(loupe.style, { left: `${left}px`, top: `${top}px`, width: `${LOUPE}px`, height: `${LOUPE}px` });
    lg.setTransform(2, 0, 0, 2, 0, 0);
    lg.fillStyle = '#0B1A10';
    lg.fillRect(0, 0, LOUPE, LOUPE);
    const ox = LOUPE / 2 - p.x * zoom, oy = LOUPE / 2 - p.y * zoom;
    lg.drawImage(photo, ox, oy, W * zoom, H * zoom);
    if (box) {
      lg.strokeStyle = '#FFE48A';
      lg.lineWidth = 3;
      lg.setLineDash([8, 6]);
      lg.strokeRect(ox + box.x * zoom, oy + box.y * zoom, box.w * zoom, box.h * zoom);
      lg.setLineDash([]);
    }
    // 指の位置の印
    lg.strokeStyle = 'rgba(255,255,255,0.9)';
    lg.lineWidth = 1.5;
    lg.beginPath();
    lg.moveTo(LOUPE / 2 - 8, LOUPE / 2); lg.lineTo(LOUPE / 2 + 8, LOUPE / 2);
    lg.moveTo(LOUPE / 2, LOUPE / 2 - 8); lg.lineTo(LOUPE / 2, LOUPE / 2 + 8);
    lg.stroke();
    loupe.hidden = false;
  };

  // ── 指の操作 ──
  // 1 本: 枠・つまみの上ならその操作、それ以外は写真を動かす（動かさずに離したらタップ）
  // 2 本: ピンチで拡大・縮小（2 本の指の真ん中を中心に）
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { kind: 'pan' | 'box' | 'handle'; corner?: Corner; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null = null;
  let pinch: { dist: number; scale: number; midX: number; midY: number; offX: number; offY: number } | null = null;

  area.addEventListener('pointerdown', e => {
    if (opts.mode === 'view') renderBoxes(); // シートで確かめたあとなど、枠が変わっていれば出し直す
    try { area.setPointerCapture(e.pointerId); } catch { /* 捕まえられなくても、操作はできる */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const r = area.getBoundingClientRect();
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale, midX: (a.x + b.x) / 2 - r.left, midY: (a.y + b.y) / 2 - r.top, offX, offY };
      drag = null;
      loupe.hidden = true;
      return;
    }
    const target = e.target as HTMLElement;
    const corner = target.dataset.corner as Corner | undefined;
    const kind = corner ? 'handle' : target.closest('.stage-box') ? 'box' : 'pan';
    drag = { kind, corner, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
    if (kind !== 'pan') showLoupe(e.clientX, e.clientY);
  });
  area.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const r = area.getBoundingClientRect();
      const next = Math.min(Math.max(pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist, fit), fit * MAX_ZOOM);
      const midX = (a.x + b.x) / 2 - r.left, midY = (a.y + b.y) / 2 - r.top;
      // ピンチを始めたときの真ん中の写真の点が、今の真ん中に来るようにする
      const px = (pinch.midX - pinch.offX) / pinch.scale, py = (pinch.midY - pinch.offY) / pinch.scale;
      scale = next;
      offX = midX - px * scale;
      offY = midY - py * scale;
      clampView();
      draw();
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY;
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > TAP_PX) drag.moved = true;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (drag.kind === 'pan') {
      if (!drag.moved) return;
      offX += dx;
      offY += dy;
      clampView();
      draw();
    } else if (box) {
      if (drag.kind === 'box') box = moveBox(box, dx / scale, dy / scale, W, H);
      else { const p = toPhoto(e.clientX, e.clientY); box = resizeBox(box, drag.corner!, p.x, p.y, W, H); }
      renderBoxes();
      showLoupe(e.clientX, e.clientY);
    }
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    loupe.hidden = true;
    // 動かさずに離した → タップ: 写真の上なら、そこに枠を出す（印をつけるとき）
    // 見るだけのとき: 動かさずに離した → タップ: そこにある四つ葉の枠を選ぶ
    if (drag && !drag.moved && drag.kind === 'pan' && opts.mode === 'view' && e.type === 'pointerup') pickAt(e.clientX, e.clientY);
    if (drag && !drag.moved && drag.kind === 'pan' && opts.mode === 'mark' && e.type === 'pointerup') {
      const p = toPhoto(e.clientX, e.clientY);
      if (p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H) {
        box = provisionalBox(p.x, p.y, W, H, box ? Math.max(box.w, box.h) : initialMissedSize(opts.detections, W, H));
        renderBoxes();
        updateGuide();
      }
    }
    if (pointers.size === 0) drag = null;
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);

  // ── ボタン（画面の下）──
  const button = (label: string, cls: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    actions.append(b);
    return b;
  };
  const close = () => {
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    root.remove();
  };
  let decide: HTMLButtonElement | null = null;
  if (opts.mode === 'mark') {
    decide = button('決定', 'btn-primary', async () => {
      if (!box || !decide) return;
      decide.disabled = true;
      await opts.onDecide?.(box);
      close();
    });
    const row = document.createElement('div');
    row.className = 'stage-actions-row';
    actions.append(row);
    const redo = button('やり直し', 'btn-secondary', () => { box = null; renderBoxes(); updateGuide(); });
    const cancel = button('やめる', 'btn-secondary', close);
    row.append(redo, cancel);
  } else {
    button('とじる', 'btn-secondary', close);
  }
  const updateGuide = () => {
    if (opts.mode === 'view') guide.textContent = '指で ひろげて、四つ葉の枠を タップしてね';
    else guide.textContent = box ? '枠を動かして、四つ葉に あわせてね' : '見逃した四つ葉のところを、タップしてね';
    if (decide) decide.disabled = !box;
  };

  const onResize = () => { resetView(); draw(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKey);
  document.body.append(root);
  updateGuide();
  resetView();
  draw();
}
