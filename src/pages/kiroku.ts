// きろく（レベル・本数・バッジ）画面
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';
import { getProgress, resetProgress } from '../lib/progress-db';
import { activeBadges, formatCount, levelInfo } from '../lib/progress';

injectSvgDefs();

const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
const resetMessage = document.getElementById('resetMessage')!;

async function render() {
  const p = await getProgress();
  const info = levelInfo(p.xp);
  document.getElementById('levelLv')!.textContent = `Lv.${info.level}`;
  document.getElementById('levelRank')!.textContent = info.rank;
  document.getElementById('levelNext')!.textContent = `次まで あと ${formatCount(info.toNext)}`;
  (document.getElementById('levelBar') as HTMLElement).style.width = `${(info.into / info.need) * 100}%`;
  document.getElementById('statLeaves')!.textContent = formatCount(p.leaves);
  document.getElementById('statFours')!.textContent = formatCount(p.fours);
  document.getElementById('statDiary')!.textContent = formatCount(p.diaryCards);

  // バッジ: 取れたものは色つき（取った日）。まだのものは薄く出して、取り方を書く
  const got = new Map(p.badges.map(b => [b.id, b.date]));
  document.getElementById('badgeList')!.innerHTML = activeBadges().map(b => {
    const date = got.get(b.id);
    const d = date ? new Date(date) : null;
    return `
      <li class="badge ${d ? 'badge--got' : 'badge--locked'}">
        <svg class="badge-icon" width="44" height="44" viewBox="-42 -42 84 84" aria-hidden="true">
          <circle r="40" class="badge-ring"/>
          <use href="#cH" transform="rotate(8) scale(0.62)"/>
        </svg>
        <span class="badge-text">
          <span class="badge-name">${b.name}</span>
          <span class="badge-sub">${d ? `${d.getMonth() + 1}月${d.getDate()}日に もらいました` : b.how}</span>
        </span>
      </li>`;
  }).join('');
}

// きろくを消す: 1 回目で「もう一度 おすと 消えます」に変わり、5 秒以内に もう一度 おすと消す（ブラウザの確認画面は使わない）
let armed = 0;
const disarm = () => {
  window.clearTimeout(armed);
  armed = 0;
  resetBtn.textContent = 'きろくを消す';
  resetBtn.classList.remove('btn-text-link--armed');
};
resetBtn.addEventListener('click', async () => {
  if (!armed) {
    resetBtn.textContent = 'もう一度 おすと、消えます';
    resetBtn.classList.add('btn-text-link--armed');
    armed = window.setTimeout(disarm, 5000);
    return;
  }
  disarm();
  await resetProgress();
  await render();
  resetMessage.textContent = 'きろくを 消しました';
  resetMessage.hidden = false;
});

window.addEventListener('pageshow', e => { if (e.persisted) render(); });
render();
