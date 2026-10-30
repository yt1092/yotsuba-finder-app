// Found（四つ葉発見）画面の初期化
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';
import { getRecord } from '../lib/db';
import { takeNotice } from '../lib/progress-db';
import { showProgressNotice } from '../components/progress-notice';
import { getSaveMode } from '../lib/save-mode';

injectSvgDefs();

async function init() {
  // sessionStorage から最後に保存した記録の ID を取得する
  const id = Number(sessionStorage.getItem('lastFoundId'));
  if (!id) return;

  const rec = await getRecord(id);
  if (!rec) return;
  showProgressNotice(takeNotice()); // レベルアップ・新しいバッジ
  document.getElementById('savedText')!.textContent = getSaveMode() === 'auto' ? '図鑑に自動で入れました' : '図鑑に入れました';

  // 発見した写真を表示する
  const img = document.getElementById('foundImg') as HTMLImageElement;
  if (img) img.src = rec.imageDataUrl;

  // 日時を Nunito フォントで表示する
  const dateEl = document.getElementById('foundDate');
  if (dateEl) {
    const d = new Date(rec.date);
    dateEl.textContent =
      `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}  ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // Web Share API で写真を共有する
  document.getElementById('shareBtn')?.addEventListener('click', async () => {
    try {
      const blob = await (await fetch(rec.imageDataUrl)).blob();
      const file = new File([blob], 'yotsuba.jpg', { type: 'image/jpeg' });
      await navigator.share({ title: '四つ葉を見つけた！', files: [file] });
    } catch {
      // 共有がサポートされていないブラウザでは何もしない
    }
  });
}

init();
