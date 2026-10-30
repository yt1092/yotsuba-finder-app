// Collection（図鑑）画面の初期化
// 切り替え: 「すべて」「四つ葉」（見つけた写真）と「今日のよつば」（別の入れ物の一覧。src/lib/gacha-list.ts）
// 「すべて」「四つ葉」には、今日のよつばを混ぜない。collection.html?tab=gacha で、今日のよつばの一覧を開く
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';
import { getAllGacha, getAllRecords, updateRecord } from '../lib/db';
import type { CloverRecord } from '../lib/db';
import { GACHA_SHAPE_SIZE, collectionItems, gachaDateLabel, gachaListItems, splitGacha } from '../lib/gacha-list';
import { shapeThumbFromDataUrl } from '../lib/gacha-thumb';

injectSvgDefs();

type Filter = 'all' | '四つ葉' | 'gacha';

let allRecords: CloverRecord[] = [];
let gachaEntries: CloverRecord[] = [];
let currentFilter: Filter = new URLSearchParams(location.search).get('tab') === 'gacha' ? 'gacha' : 'all';

async function init() {
  const [records, gacha] = await Promise.all([getAllRecords(), getAllGacha()]);
  // 図鑑の入れ物に移せずに残った今日のよつばも、今日のよつばの一覧に出す（図鑑の一覧には混ぜない）
  allRecords = splitGacha(records).photos;
  gachaEntries = gachaListItems(gacha, records);
  setupTabs();
  render();
}

// タブ切替のイベントを設定する
function setupTabs() {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
    const filter = (btn.getAttribute('data-filter') as Filter) ?? 'all';
    const mark = () => {
      document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(b => {
        b.classList.toggle('tab-active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
    };
    if (filter === currentFilter) mark();
    btn.addEventListener('click', () => {
      mark();
      currentFilter = filter;
      history.replaceState(null, '', filter === 'gacha' ? '?tab=gacha' : location.pathname);
      render();
    });
  });
}

function render() {
  if (currentFilter === 'gacha') renderGacha();
  else renderGrid(currentFilter);
}

// フィルター適用後のグリッドを描画する（見つけた写真だけ）
function renderGrid(filter: 'all' | '四つ葉') {
  const filtered = collectionItems(allRecords, filter);

  const container = document.getElementById('gridContainer');
  if (!container) return;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text2);">
        <p class="empty-msg">まだ記録がありません</p>
        <a href="scan.html" class="btn-primary" style="margin-top:16px;display:inline-flex;width:auto;padding:0 32px;">スキャンを始める</a>
      </div>`;
    return;
  }

  // 月ごとにグループ化する
  const byMonth = new Map<string, CloverRecord[]>();
  for (const r of filtered) {
    const d = new Date(r.date);
    const key = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(r);
  }

  let html = '';
  for (const [month, recs] of byMonth) {
    html += `
      <div class="month-header">
        <h2>${month}</h2>
        <span>${recs.length} 枚</span>
      </div>
      <div class="card-grid">
        ${recs.map(r => {
          const d = new Date(r.date);
          const label = `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
          return `
            <a href="detail.html?id=${r.id}" class="record-card" aria-label="${label}の${r.label}">
              <img src="${r.imageDataUrl}" alt="" loading="lazy">
              <div class="card-shade"></div>
              <span class="card-date">${label}</span>
            </a>`;
        }).join('')}
        <a href="scan.html" class="card-add" aria-label="次の一枚を探す">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          <span>次の一枚を探す</span>
        </a>
      </div>`;
  }
  container.innerHTML = html;
}

// 今日のよつばの一覧: 1 行に、形（64×64）と日付
function renderGacha() {
  const container = document.getElementById('gridContainer');
  if (!container) return;
  if (gachaEntries.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px 0;">
        <p class="empty-msg">まだ ありません</p>
        <a href="gacha.html" class="btn-primary" style="margin-top:16px;display:inline-flex;width:auto;padding:0 32px;">今日のよつばへ</a>
      </div>`;
    return;
  }
  const S = GACHA_SHAPE_SIZE;
  container.innerHTML = `
    <ul class="gacha-list" data-gacha-list>
      ${gachaEntries.map(e => {
        const date = gachaDateLabel(e);
        return `
        <li>
          <a href="detail.html?id=${e.id}" class="gacha-row card-surface" aria-label="${date}の今日のよつば">
            <img src="${e.shape64 ?? e.imageDataUrl}" alt="" width="${S}" height="${S}" loading="lazy" data-id="${e.id}"${e.shape64 ? '' : ' data-need-shape'}>
            <span class="gacha-row-date">${date}</span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
          </a>
        </li>`;
      }).join('')}
    </ul>`;
  fillMissingShapes(container).catch(e => console.warn('今日のよつばの形を作れませんでした', e));
}

// 版 5 より前に入れた記録は、64×64 の形がまだ無い: ここで作って残す（作れなければ、記録の絵を小さく出したまま）
async function fillMissingShapes(container: HTMLElement) {
  for (const img of container.querySelectorAll<HTMLImageElement>('img[data-need-shape]')) {
    const id = Number(img.dataset.id);
    const e = gachaEntries.find(g => g.id === id);
    if (!e) continue;
    const shape = await shapeThumbFromDataUrl(e.imageDataUrl);
    if (!shape) continue;
    e.shape64 = shape;
    img.src = shape;
    img.removeAttribute('data-need-shape');
    await updateRecord(id, { shape64: shape });
  }
}

init();
