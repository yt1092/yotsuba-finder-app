// PhotoNone（写真で四つ葉なし）画面の初期化
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';

injectSvgDefs();

import type { LeafCounts } from '../lib/leaf-count';
import { getLastPhoto } from '../lib/db';
import { resultText } from '../lib/result-text';
import { setupLeafInspect } from '../components/leaf-inspect';
import { photoOnce, setupMissedMode } from '../components/feedback-ui';
import { takeNotice } from '../lib/progress-db';
import { showProgressNotice } from '../components/progress-notice';

// 見出しと文（最後に調べた写真の記録から。無ければ sessionStorage の葉の数から）
function showText(counts: LeafCounts, repeated: boolean) {
  const t = resultText({ fourDetected: 0, kept: 0, three: counts.three, repeated });
  const set = (id: string, text: string) => { const el = document.getElementById(id)!; el.textContent = text; el.hidden = !text; };
  set('resultTitle', t.title);
  set('resultLead', t.sub);
  set('leafCountText', t.detail);
}
showText(JSON.parse(sessionStorage.getItem('leafCounts') ?? '{"three":0,"four":0}'), false);
// 経験値（葉の数の文の下）・レベルアップ・新しいバッジ
showProgressNotice(takeNotice(), document.getElementById('xpText'));

// 最後に調べた写真があれば、イラストの代わりに出し、「四つ葉を見逃している」を言えるようにする
getLastPhoto().then(last => {
  const img = document.getElementById('photoImg') as HTMLImageElement | null;
  const missedBtn = document.getElementById('missedBtn') as HTMLButtonElement | null;
  if (last) showText(last.counts, last.repeated ?? false);
  if (!last || !img || !missedBtn) return;
  img.src = last.imageDataUrl;
  document.getElementById('photoBox')!.hidden = false;
  document.getElementById('illustBox')!.hidden = true;
  const view = setupLeafInspect({ img, detections: last.detections, verify: false });
  const startMissed = setupMissedMode(view, { key: `photo:${last.date}`, detections: last.detections, photo: photoOnce(img) });
  missedBtn.hidden = false;
  missedBtn.addEventListener('click', startMissed);
});
