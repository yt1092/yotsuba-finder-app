// 経験値・レベルアップ・新しいバッジを知らせる
// - 経験値: 結果の画面の、葉の数の文の下に「けいけんち ＋142」（同じ写真の 2 回目や 0 点のときは出さない）
// - レベルアップ: 画面のまん中に「レベルアップ！」と新しいレベル。短い紙吹雪（約 2 秒。「視差効果を減らす」がオンのときは出さない）
// - 新しいバッジ: 上に小さく出して、少しで消す
import type { ProgressNotice } from '../lib/progress-db';
import { badgeName } from '../lib/progress-db';
import { mascotHtml } from '../lib/mascot';
import type { ProgressResult } from '../lib/progress';

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 結果を知らせる（xpEl があれば、そこに経験値の文を出す）
export function showProgressNotice(notice: ProgressNotice | null, xpEl?: HTMLElement | null): void {
  if (!notice) return;
  if (xpEl && notice.gained > 0 && !notice.repeated) {
    xpEl.textContent = `けいけんち ＋${notice.gained.toLocaleString('ja-JP')}`;
    xpEl.hidden = false;
  }
  const badges = notice.badgeIds.map(badgeName).filter(Boolean);
  if (notice.levelUp) showLevelUp(notice.levelUp.level, notice.levelUp.rank, () => showBadgeToast(badges));
  else showBadgeToast(badges);
}

// 初めて「入れない」を選んで記録されたときのお礼（約 3 秒で消える。キャラクター smile つき）。そのあと、新しいバッジを知らせる
export const THANKS_TEXT = 'おしえてくれて ありがとう。記録しました。';
export async function showTeachThanks(r: ProgressResult | null): Promise<void> {
  if (!r || !r.newBadges.some(b => b.id === 'first-teach')) return; // 2 回目からは出さない
  // ほかのお知らせ（バッジ・レベルアップ）が出ているあいだは待つ（同じ場所に重ならないように。最大 8 秒）
  // 結果の画面は、ポップアップを閉じたすぐあとに、経験値のお知らせを出すので、少し待ってから見る
  await new Promise(res => setTimeout(res, 300));
  for (let i = 0; i < 40 && document.querySelector('.toast, .levelup-backdrop'); i++) await new Promise(res => setTimeout(res, 200));
  const toast = document.createElement('p');
  toast.className = 'toast toast--thanks';
  toast.setAttribute('role', 'status');
  toast.innerHTML = `${mascotHtml('smile', 56)}<span>${THANKS_TEXT}</span>`;
  document.body.append(toast);
  window.setTimeout(() => {
    toast.remove();
    showBadgeToast(r.newBadges.map(b => b.name));
  }, 3000);
}

// その場で起きたできごと（日記カード・ひとこと）を知らせる
export function showProgressResult(r: ProgressResult | null): void {
  if (!r) return;
  showProgressNotice({ gained: r.gained, repeated: r.repeated, levelUp: r.levelUp, badgeIds: r.newBadges.map(b => b.id) });
}

function showLevelUp(level: number, rank: string, onClose: () => void) {
  const backdrop = document.createElement('div');
  backdrop.className = 'levelup-backdrop';
  backdrop.innerHTML = `
    <div class="levelup" role="dialog" aria-modal="true" aria-labelledby="levelupTitle">
      ${mascotHtml('happy', 72, 'levelup-icon')}
      <h2 id="levelupTitle" class="levelup-title">レベルアップ！</h2>
      <p class="levelup-level"><span class="font-nunito">Lv.${level}</span> ${rank}</p>
      <button type="button" class="btn-primary" data-ok>やったね</button>
    </div>`;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.querySelector('[data-ok]')!.addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  (backdrop.querySelector('[data-ok]') as HTMLElement).focus();
  if (!reduceMotion()) confetti(2000);
}

function showBadgeToast(names: string[]) {
  if (names.length === 0) return;
  const toast = document.createElement('p');
  toast.className = 'toast toast--badge';
  toast.setAttribute('role', 'status');
  toast.textContent = `バッジを もらいました：${names.join('、')}`;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 3500);
}

// 短い紙吹雪（canvas。約 2 秒で消える。画面の操作は、じゃましない）
function confetti(ms: number) {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  document.body.append(canvas);
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  const colors = ['#F2B84B', '#7CCB6A', '#3E9A4A', '#FF8FA3', '#6FB7E8', '#FFFFFF'];
  const pieces = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 9,
    vy: -6 - Math.random() * 7,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    w: 6 + Math.random() * 6,
    h: 4 + Math.random() * 4,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    g.clearRect(0, 0, innerWidth, innerHeight);
    g.globalAlpha = t > ms - 400 ? Math.max(0, (ms - t) / 400) : 1;
    for (const p of pieces) {
      p.vy += 0.35;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.r);
      g.fillStyle = p.c;
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.restore();
    }
    if (t < ms) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
