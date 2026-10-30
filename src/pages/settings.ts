// Settings（設定）画面: 保存のしかた・調整・まちがいの記録・データの書き出しと読み込み・すべて消す
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';
import { allFeedback, clearFeedback, countFeedback } from '../lib/feedback-db';
import { exportJson } from '../lib/feedback';
import { createZip } from '../lib/zip';
import { fileDate } from '../lib/diary-text';
import { getSaveMode, setSaveMode, type SaveMode } from '../lib/save-mode';
import { currentTuning, getTuning, resetTuning, setTuningEnabled, type TuningState } from '../lib/tuning-db';
import { MIN_TOTAL } from '../lib/tuning';
import { DEBUG_BUILD, isDevMode, tapCounter } from '../lib/dev-mode';
import { wipeAllData } from '../lib/wipe';
import { gachaModelReady } from '../lib/gacha-config';
import { BIG_EXPORT_BYTES, backupFileName, backupText, parseBackup, sizeLabel, textBytes, type BackupData, type ImportMode } from '../lib/backup';
import { applyImport, collectBackup, lastExportAt, makeImportPlan, markExported } from '../lib/backup-db';
import { needsExportHint, readPersist } from '../lib/persist';
import { diaryDate } from '../lib/diary-text';

injectSvgDefs();

// 保存のしかた: 「確認してから入れる」（既定）か「自動で入れる」か
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
const showMode = () => {
  const mode = getSaveMode();
  for (const b of modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
};
for (const b of modeButtons) b.addEventListener('click', () => { setSaveMode(b.dataset.mode as SaveMode); showMode(); });
showMode();

// あなたに合わせて調整する: オン・オフと、もとに戻す（数字やしきい値は出さない）
const tuningButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-tuning]')];
const tuningState = document.getElementById('tuningState')!;
const tuningReset = document.getElementById('tuningReset') as HTMLButtonElement;
const showTuning = (s: TuningState) => {
  for (const b of tuningButtons) b.setAttribute('aria-checked', String((b.dataset.tuning === 'on') === s.enabled));
  const t = currentTuning(s);
  tuningState.textContent = !s.enabled ? '今は、調整していません'
    : t.shift !== 0 ? 'あなたの えらび方に 合わせています'
    : t.ready ? 'まだ、もとのままです（えらび方が、もとの出し方と 合っています）'
    : `えらんだ数が ${MIN_TOTAL}こ ほど たまると、合わせはじめます`;
  tuningReset.disabled = s.choices.length === 0;
};
getTuning().then(showTuning).catch(e => console.warn(e));
for (const b of tuningButtons) b.addEventListener('click', async () => showTuning(await setTuningEnabled(b.dataset.tuning === 'on')));
let resetArmed = 0;
tuningReset.addEventListener('click', async () => {
  // まちがって押さないように、2 回押したら もどす
  if (Date.now() - resetArmed > 4000) {
    resetArmed = Date.now();
    tuningReset.textContent = 'もう一度 おすと、もとに もどります';
    return;
  }
  resetArmed = 0;
  tuningReset.textContent = '調整を もとに もどす';
  showTuning(await resetTuning());
  tuningState.textContent = 'もとに もどしました';
});

// ── データの書き出しと読み込み（src/lib/backup.ts・src/lib/backup-db.ts。外部との通信はしない）──
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const backupMessage = $('backupMessage');
const sayBackup = (text: string) => { backupMessage.textContent = text; backupMessage.hidden = !text; };
const photoButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-photos]')];
let withPhotos = true;
const showPhotos = () => { for (const b of photoButtons) b.setAttribute('aria-checked', String((b.dataset.photos === 'on') === withPhotos)); };
for (const b of photoButtons) b.addEventListener('click', () => { withPhotos = b.dataset.photos === 'on'; showPhotos(); });

// 最後に書き出した日（静かに出すだけ。催促はしない）と、記録が消えることがあるブラウザの案内（src/lib/persist.ts）
const showLastExport = () => {
  const at = lastExportAt();
  $('lastExport').textContent = at ? `最後に 書き出した日：${diaryDate(at)}` : 'まだ 書き出していません';
};
showLastExport();
$('persistHint').hidden = !needsExportHint(readPersist());

// ファイルを渡す: 共有画面（Web Share API）。使えなければダウンロード。渡せたら true（共有画面を閉じただけなら false）
async function handOver(file: File): Promise<boolean> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return false;
      throw e;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

// 書き出す。写真ありで大きすぎる（目安 50MB）ときは、写真なしも選べるようにする（大きさを出す）。書き出せたら true
let pendingBig: { text: string; at: number } | null = null;
async function exportBackup(photos: boolean, opts: { allowBig?: boolean } = {}): Promise<boolean> {
  sayBackup('ファイルを 作っています…');
  const data = await collectBackup(photos);
  const text = backupText(data);
  const bytes = textBytes(text);
  if (photos && bytes > BIG_EXPORT_BYTES && !opts.allowBig) {
    const small = textBytes(backupText(await collectBackup(false)));
    pendingBig = { text, at: data.exportedAt };
    $('backupBigText').textContent = `写真も 入れると、${sizeLabel(bytes)} です。大きいので、写真なしでも 書き出せます（${sizeLabel(small)}）。`;
    $('backupBigNoPhoto').textContent = `写真なしで 書き出す（${sizeLabel(small)}）`;
    $('backupBig').hidden = false;
    sayBackup('');
    return false;
  }
  return deliver(text, data.exportedAt);
}
async function deliver(text: string, at: number): Promise<boolean> {
  const file = new File([text], backupFileName(fileDate(at)), { type: 'application/json' });
  const done = await handOver(file);
  if (done) {
    markExported(at);
    showLastExport();
    sayBackup(`書き出しました（${sizeLabel(file.size)}）`);
  } else {
    sayBackup('');
  }
  return done;
}
const guard = (btn: HTMLButtonElement, run: () => Promise<unknown>) => btn.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    await run();
  } catch (e) {
    console.error(e);
    sayBackup('うまく いきませんでした。もう一度 ためしてください');
  } finally {
    btn.disabled = false;
  }
});
guard($('backupExport'), () => { $('backupBig').hidden = true; return exportBackup(withPhotos); });
guard($('backupBigKeep'), async () => {
  $('backupBig').hidden = true;
  if (pendingBig) await deliver(pendingBig.text, pendingBig.at);
  pendingBig = null;
});
guard($('backupBigNoPhoto'), async () => { $('backupBig').hidden = true; pendingBig = null; await exportBackup(false); });

// 読み込む: 形・版・大きさを確かめてから、上書きか足すかを選んでもらう。確かめてから書く（途中で失敗したら、元に戻る）
const fileInput = $<HTMLInputElement>('backupFile');
const importChoice = $('importChoice');
const importButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-import]')];
let importMode: ImportMode = 'add';
let importData: BackupData | null = null;
const showImportMode = () => {
  for (const b of importButtons) b.setAttribute('aria-checked', String(b.dataset.import === importMode));
  $('replaceWarn').hidden = importMode !== 'replace';
};
for (const b of importButtons) b.addEventListener('click', () => { importMode = b.dataset.import as ImportMode; showImportMode(); });
const closeImport = () => { importChoice.hidden = true; importData = null; fileInput.value = ''; };
$('backupImport').addEventListener('click', () => { closeImport(); sayBackup(''); fileInput.click(); });
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const result = parseBackup(await file.text().catch(() => ''), file.size);
  if (!result.ok) {
    closeImport();
    sayBackup(result.error);
    return;
  }
  importData = result.data;
  const d = result.data;
  $('importSummary').textContent = `${diaryDate(d.exportedAt)}に 書き出した ファイルです。図鑑の 記録は ${d.records.length}件${d.withPhotos ? '' : '（写真なし）'}。`;
  importMode = 'add';
  showImportMode();
  importChoice.hidden = false;
  sayBackup('');
});
$('importCancel').addEventListener('click', () => { closeImport(); sayBackup('やめました'); });
guard($('replaceExportFirst'), () => exportBackup(withPhotos));
guard($('importGo'), async () => {
  if (!importData) return;
  const ask = importMode === 'replace'
    ? '今の データを 消して、ファイルの 中身に おきかえます。よいですか？'
    : '今の データに、ファイルの 図鑑と まちがいの記録を 足します。よいですか？';
  if (!confirm(ask)) return;
  const plan = await makeImportPlan(importData, importMode);
  try {
    await applyImport(plan);
  } catch (e) {
    console.error(e);
    sayBackup('読み込めませんでした。データは 変わっていません');
    return;
  }
  closeImport();
  sayBackup(plan.mode === 'replace' ? '読み込みました（上書き）'
    : `読み込みました（${plan.records.length + plan.gacha.length}件 足しました${plan.skipped ? `。同じ 記録 ${plan.skipped}件は 足していません` : ''}）`);
  showMode();
  getTuning().then(showTuning).catch(() => undefined);
  await refresh();
});

// すべてのデータを消す: まず、消す前の書き出しを案内する（飛ばせる）。そのあと「もう一度 おすと、すべて消えます」に変わり、
// 5 秒以内に もう一度 おすと消す（きろくを消すと同じ方式）
const wipeBtn = document.getElementById('wipeBtn') as HTMLButtonElement;
const wipeMessage = document.getElementById('wipeMessage')!;
const wipeAsk = $('wipeAsk');
let wipeArmed = 0;
const wipeDisarm = () => {
  window.clearTimeout(wipeArmed);
  wipeArmed = 0;
  wipeBtn.textContent = 'すべてのデータを消す';
  wipeBtn.classList.remove('btn-text-link--armed');
};
const wipeArm = () => {
  wipeAsk.hidden = true;
  wipeBtn.textContent = 'もう一度 おすと、すべて消えます';
  wipeBtn.classList.add('btn-text-link--armed');
  wipeArmed = window.setTimeout(wipeDisarm, 5000);
};
$('wipeSkip').addEventListener('click', wipeArm);
guard($('wipeExport'), async () => { if (await exportBackup(withPhotos, { allowBig: true })) wipeArm(); });
wipeBtn.addEventListener('click', async () => {
  if (!wipeArmed) {
    wipeAsk.hidden = false;
    wipeMessage.hidden = true;
    return;
  }
  wipeDisarm();
  wipeBtn.disabled = true;
  try {
    await wipeAllData();
    wipeMessage.textContent = 'すべてのデータを 消しました';
    await refresh();
    getTuning().then(showTuning).catch(() => undefined);
  } catch (e) {
    console.error(e);
    wipeMessage.textContent = 'うまく 消せませんでした。もう一度 ためしてください';
  }
  wipeMessage.hidden = false;
  wipeBtn.disabled = false;
});

// アプリの版（5 回つづけて押すと、開発者向けの表示のオン・オフ）
const versionBtn = document.getElementById('versionBtn') as HTMLButtonElement;
const devMessage = document.getElementById('devMessage')!;
const showVersion = () => {
  versionBtn.textContent = `バージョン ${__APP_VERSION__}${DEBUG_BUILD && isDevMode() ? '（デバッグ表示: オン）' : ''}`;
};
showVersion();
// 開発用の版だけ: 5 回つづけて押すと、デバッグ表示のオン・オフ（本番のビルドには入らない）
if (DEBUG_BUILD) {
  versionBtn.addEventListener('click', tapCounter(5, 3000, on => {
    showVersion();
    devMessage.textContent = on ? 'デバッグ表示を オンにしました' : 'デバッグ表示を オフにしました';
    devMessage.hidden = false;
  }));
}

const countEl = document.getElementById('feedbackCount')!;
const message = document.getElementById('feedbackMessage')!;
const exportBtn = document.getElementById('exportBtn') as HTMLButtonElement;
const clearBtn = document.getElementById('clearBtn') as HTMLButtonElement;

const say = (text: string) => { message.textContent = text; message.hidden = !text; };

async function refresh() {
  const n = await countFeedback();
  countEl.textContent = String(n);
  exportBtn.disabled = clearBtn.disabled = n === 0;
}

// 書き出す: 写真と、答えの JSON を 1 つの zip にして、共有画面かダウンロードで渡す（端末の中で作る。通信はしない）
exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  try {
    const entries = await allFeedback();
    const now = new Date();
    const photoName = (i: number) => `photos/${String(i + 1).padStart(4, '0')}.jpg`;
    const json = exportJson(entries, photoName, now);
    const zip = createZip([
      { name: 'answers.json', data: new TextEncoder().encode(JSON.stringify(json, null, 2)), date: now },
      ...entries.map((e, i) => ({ name: photoName(i), data: new Uint8Array(e.photo), date: new Date(e.date) })),
    ]);
    const name = `yotsuba-mistakes-${fileDate(now.getTime())}.zip`;
    const file = new File([zip], name, { type: 'application/zip' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (e) {
        if ((e as DOMException).name !== 'AbortError') throw e;
      }
    } else {
      // 共有画面が使えないときは、ダウンロードで渡す
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      say('書き出しました');
    }
  } catch (e) {
    console.error(e);
    say('うまく 書き出せませんでした');
  } finally {
    await refresh();
  }
});

// すべて消す（確かめてから）
clearBtn.addEventListener('click', async () => {
  if (!confirm('まちがいの記録を、すべて消しますか？')) return;
  await clearFeedback();
  say('すべて消しました');
  await refresh();
});

refresh();

// 今日のよつばのモデルが、この端末に入っているか（Service Worker のモデル用キャッシュ）。数字は出さない
async function showGachaModel() {
  const el = document.getElementById('gachaModelStatus');
  if (el) el.textContent = `今日のよつばのモデル：${(await gachaModelReady()) ? '準備できています' : 'まだ準備中です'}`;
}
showGachaModel();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') showGachaModel(); });
