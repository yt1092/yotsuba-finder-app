// 日記カードの「てがきで かく」: カードのプレビューの上に、書ける層（canvas）を重ねる
// - Pointer Events。touch-action: none とポインターキャプチャで、書いている間にページがスクロールしたり拡大したりしないようにする
// - Apple Pencil の筆圧で太さを変える。ペンが使われたら、指の接触（手のひら）は無視する
// - 線は 2 次曲線でなめらかにつなぐ（描画は src/lib/ink.ts。カードの描画と同じ関数）
import { INK_COLORS, INK_SIZES, InkHistory, STICKER_KINDS, STICKER_SIZES, drawInk, pressureOf, stickerSvg, toCard,
  type Ink, type InkColor, type InkStroke, type StickerKind } from '../lib/ink';

type Tool = 'pen' | 'eraser' | 'sticker';

export interface InkEditor {
  finish: () => void; // 書くのをおわる（「おわり」と同じ）
}

export function openInkEditor(opts: { stage: HTMLElement; after: HTMLElement; initial: Ink; onDone: (ink: Ink) => void }): InkEditor {
  const history = new InkHistory(opts.initial.items);
  let tool: Tool = 'pen';
  let color: InkColor = 'black';
  let sizeIndex = 1;
  let sticker: StickerKind = 'clover';
  let stickerSizeIndex = 1;
  let current: InkStroke | null = null;
  let active: number | null = null;
  let penSeen = false;
  let frame = 0;
  let clearArmed = 0;

  // ── 書く層 ──
  const canvas = document.createElement('canvas');
  canvas.className = 'ink-canvas';
  canvas.setAttribute('aria-label', 'てがきで かく ところ');
  opts.stage.append(canvas);
  opts.stage.classList.add('diary-preview--ink');
  const layer = document.createElement('canvas');
  const g = canvas.getContext('2d')!;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    render();
  };
  const reuseLayer = (w: number, h: number) => {
    if (layer.width !== w || layer.height !== h) { layer.width = w; layer.height = h; } else layer.getContext('2d')!.clearRect(0, 0, w, h);
    return layer;
  };
  function render() {
    frame = 0;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const ink: Ink = { v: 1, items: current ? [...history.ink.items, current] : history.ink.items };
    drawInk(g, ink, canvas.width, canvas.height, reuseLayer);
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

  // ── 道具 ──
  const tools = document.createElement('div');
  tools.className = 'ink-tools';
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'てがきの どうぐ');
  tools.innerHTML = `
    <div class="ink-row" role="radiogroup" aria-label="ペンの いろ">
      ${INK_COLORS.map(c => `<button type="button" class="ink-btn ink-color" role="radio" data-color="${c.id}" aria-label="${c.name}" style="--ink:${c.hex}"><span aria-hidden="true"></span></button>`).join('')}
    </div>
    <div class="ink-row" role="radiogroup" aria-label="ふとさと けしゴム">
      ${INK_SIZES.map((_, i) => `<button type="button" class="ink-btn ink-size" role="radio" data-size="${i}" aria-label="${['ほそい', 'ふつう', 'ふとい'][i]}"><span aria-hidden="true" style="width:${6 + i * 6}px;height:${6 + i * 6}px"></span></button>`).join('')}
      <button type="button" class="ink-btn ink-eraser" role="radio" data-tool="eraser">けしゴム</button>
    </div>
    <div class="ink-row" role="radiogroup" aria-label="シール">
      ${STICKER_KINDS.map(k => `<button type="button" class="ink-btn ink-sticker" role="radio" data-sticker="${k.id}" aria-label="${k.name}の シール">${stickerSvg(k.id, 38)}</button>`).join('')}
    </div>
    <div class="ink-row" role="radiogroup" aria-label="シールの おおきさ" data-sticker-sizes hidden>
      ${STICKER_SIZES.map((_, i) => `<button type="button" class="ink-btn ink-sticker-size" role="radio" data-sticker-size="${i}">${['ちいさい', 'ふつう', 'おおきい'][i]}</button>`).join('')}
    </div>
    <div class="ink-row ink-actions">
      <button type="button" class="ink-btn" data-undo>もどす</button>
      <button type="button" class="ink-btn ink-clear" data-clear>ぜんぶけす</button>
      <button type="button" class="btn-primary ink-done" data-done>おわり</button>
    </div>
    <p class="ink-hint" data-hint>カードの上を、ゆびや ペンで なぞってね</p>`;
  opts.after.after(tools);
  const $ = <T extends HTMLElement>(sel: string) => tools.querySelector(sel) as T;
  const undoBtn = $<HTMLButtonElement>('[data-undo]');
  const clearBtn = $<HTMLButtonElement>('[data-clear]');
  const hint = $<HTMLElement>('[data-hint]');

  function syncTools() {
    tools.querySelectorAll<HTMLElement>('[data-color]').forEach(b => b.setAttribute('aria-checked', String(tool === 'pen' && b.dataset.color === color)));
    tools.querySelectorAll<HTMLElement>('[data-size]').forEach(b => b.setAttribute('aria-checked', String(tool !== 'sticker' && Number(b.dataset.size) === sizeIndex)));
    $<HTMLElement>('[data-tool="eraser"]').setAttribute('aria-checked', String(tool === 'eraser'));
    tools.querySelectorAll<HTMLElement>('[data-sticker]').forEach(b => b.setAttribute('aria-checked', String(tool === 'sticker' && b.dataset.sticker === sticker)));
    tools.querySelectorAll<HTMLElement>('[data-sticker-size]').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.stickerSize) === stickerSizeIndex)));
    $<HTMLElement>('[data-sticker-sizes]').hidden = tool !== 'sticker';
    undoBtn.disabled = !history.canUndo;
    hint.textContent = tool === 'sticker' ? 'シールを はりたい ところを タップしてね' : tool === 'eraser' ? 'けしたい 線を なぞってね' : 'カードの上を、ゆびや ペンで なぞってね';
  }
  const disarmClear = () => { window.clearTimeout(clearArmed); clearArmed = 0; clearBtn.textContent = 'ぜんぶけす'; clearBtn.classList.remove('ink-clear--armed'); };

  tools.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    if (!b.matches('[data-clear]')) disarmClear();
    if (b.dataset.color) { color = b.dataset.color as InkColor; tool = 'pen'; }
    else if (b.dataset.size) { sizeIndex = Number(b.dataset.size); if (tool === 'sticker') tool = 'pen'; }
    else if (b.dataset.tool === 'eraser') tool = 'eraser';
    else if (b.dataset.sticker) { sticker = b.dataset.sticker as StickerKind; tool = 'sticker'; }
    else if (b.dataset.stickerSize) stickerSizeIndex = Number(b.dataset.stickerSize);
    else if (b.matches('[data-undo]')) { history.undo(); render(); }
    else if (b.matches('[data-clear]')) {
      // ぜんぶけす: 1 回目で「もう一度 おすと けせます」に変わり、4 秒以内に もう一度 おすと消す（もどすで戻せる）
      if (!clearArmed) {
        clearBtn.textContent = 'もう一度 おすと けせます';
        clearBtn.classList.add('ink-clear--armed');
        clearArmed = window.setTimeout(disarmClear, 4000);
        return;
      }
      disarmClear();
      history.clear();
      render();
    } else if (b.matches('[data-done]')) { finish(); return; }
    syncTools();
  });

  // ── 書く ──
  const pointFrom = (e: PointerEvent) => {
    const [x, y] = toCard(e.clientX, e.clientY, canvas.getBoundingClientRect());
    return [x, y, pressureOf(e.pointerType, e.pressure)] as [number, number, number];
  };
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen') penSeen = true;
    else if (e.pointerType === 'touch' && penSeen) return; // ペンを使っているときの、手のひら
    if (active !== null) return;
    e.preventDefault();
    disarmClear();
    const [x, y, p] = pointFrom(e);
    if (tool === 'sticker') {
      history.add({ kind: 'sticker', type: sticker, x, y, size: STICKER_SIZES[stickerSizeIndex] });
      render();
      syncTools();
      return;
    }
    active = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* つかめなくても書ける */ }
    current = { kind: 'line', color, size: INK_SIZES[sizeIndex], ...(tool === 'eraser' ? { erase: true } : {}), points: [[x, y, p]] };
    schedule();
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerId !== active || !current) return;
    e.preventDefault();
    const coalesced = e.getCoalescedEvents?.() ?? [];
    for (const ev of coalesced.length ? coalesced : [e]) {
      const pt = pointFrom(ev);
      const last = current.points[current.points.length - 1];
      if (pt[0] !== last[0] || pt[1] !== last[1]) current.points.push(pt);
    }
    schedule();
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== active) return;
    active = null;
    if (current) history.add(current);
    current = null;
    render();
    syncTools();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    if (current) { history.add(current); current = null; }
    disarmClear();
    ro.disconnect();
    cancelAnimationFrame(frame);
    canvas.remove();
    tools.remove();
    opts.stage.classList.remove('diary-preview--ink');
    opts.onDone(history.ink);
  }

  syncTools();
  resize();
  return { finish };
}
