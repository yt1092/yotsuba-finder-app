// 「このアプリについて」（about.html。設定から開く）: ソースコード・ライセンス・クレジット・部品のライセンスの一覧
// 見せるファイルは、どれも自分のサイトの public/about/（scripts/make-licenses.mjs が作る。Service Worker が先にキャッシュするので、オフラインでも見られる）
import '../lib/register-sw';
import { LICENSE_NAME, SOURCE_URL, SOURCE_URL_IS_PLACEHOLDER } from '../lib/app-info';

interface Part { name: string; version: string; license: string; repository: string; text: string }

document.getElementById('aboutVersion')!.textContent = `YOTSUBA FINDER　バージョン ${__APP_VERSION__}`;
document.getElementById('licenseName')!.textContent = `このアプリは、${LICENSE_NAME} で 公開します。`;

// ソースコードの URL は、仮のあいだは出さない（src/lib/app-info.ts）
if (!SOURCE_URL_IS_PLACEHOLDER) {
  const link = document.getElementById('sourceLink') as HTMLAnchorElement;
  link.href = SOURCE_URL;
  link.hidden = false;
  document.getElementById('sourceWait')!.hidden = true;
}

// 開いたときに、全文を読み込む
for (const d of document.querySelectorAll<HTMLDetailsElement>('details[data-src]')) {
  d.addEventListener('toggle', async () => {
    const pre = d.querySelector('pre')!;
    if (!d.open || pre.textContent) return;
    try {
      const res = await fetch(d.dataset.src!);
      if (!res.ok) throw new Error(String(res.status));
      pre.textContent = await res.text();
    } catch {
      pre.textContent = '読み込めませんでした。';
    }
  });
}

// 部品の一覧（名前・版・ライセンス。押すと、ライセンスの文）
async function showParts() {
  const list = document.getElementById('partsList')!;
  try {
    const res = await fetch('/about/licenses.json');
    if (!res.ok) throw new Error(String(res.status));
    const parts = await res.json() as Part[];
    for (const p of parts) {
      const li = document.createElement('li');
      const details = document.createElement('details');
      details.className = 'about-details';
      const summary = document.createElement('summary');
      summary.textContent = `${p.name} ${p.version}（${p.license}）`;
      const pre = document.createElement('pre');
      pre.className = 'about-text';
      pre.textContent = (p.repository ? `${p.repository}\n\n` : '') + p.text;
      details.append(summary, pre);
      li.append(details);
      list.append(li);
    }
  } catch {
    document.getElementById('partsError')!.hidden = false;
  }
}
showParts();
