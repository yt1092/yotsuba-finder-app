// PhotoPick（写真選択）画面の初期化
import '../lib/register-sw';
import { cropPhotoRecord } from '../lib/crop-image';
import { fourThresholdFor } from '../lib/tuning-db';
import { injectSvgDefs } from '../components/svg-defs';
import { createDetector } from '../lib/create-detector';
import type { Detection } from '../lib/detector';
import { setLastPhoto } from '../lib/db';
import { AUTO_VERIFY_BUDGET_MS, MANY_CANDIDATES, VERIFY_STEP } from '../lib/detector-config';
import { VERIFY_NEEDED, VERIFY_NEEDED_STRICT } from '../lib/verify-crops';
import { autoVerify, confirmedCounts, finalDetections, resultKind } from '../lib/auto-verify';
import { verifyLeaf } from '../lib/verify-run';
import { mergeResults, photoHash, type ProgressResult } from '../lib/progress';
import { recordProgress, stashNotice } from '../lib/progress-db';
import { saveFourLeafRecord } from '../lib/save-four';
import { getSaveMode } from '../lib/save-mode';
import { PHOTO_FALLBACK_TEXT, createDiagBox, diag, readRepeat, readSession, repeatSummary, writeRepeat, writeSession } from '../lib/diag';

injectSvgDefs();

const fileInput = document.getElementById('fileInput') as HTMLInputElement;

// カメラが続けて止まって、ここに切り替わったとき、理由を出す
//   ?from=camera … スキャン画面が、続けて強制終了したのを見て、切り替えた（src/pages/scan.ts）
//   スキャン画面の印が「動いている」のまま … スキャン画面が落ちたあと、ブラウザがこの画面を開いた
{
  const scan = readSession();
  const fromCamera = new URLSearchParams(location.search).get('from') === 'camera';
  if (fromCamera || scan?.alive === true) {
    const box = document.getElementById('cameraFallback');
    if (box) { box.textContent = PHOTO_FALLBACK_TEXT; box.hidden = false; }
    if (scan?.alive) writeSession({ ...scan, alive: false });
    if (fromCamera) history.replaceState(null, '', location.pathname); // 読み込み直しても、もう出さない
  }
}
const pickBtn = document.getElementById('pickBtn') as HTMLButtonElement;
const analyzing = document.getElementById('analyzing') as HTMLElement;
const pickError = document.getElementById('pickError') as HTMLElement;
const analyzingText = document.getElementById('analyzingText') as HTMLElement;

// 画面を開いた時点でモデルの読み込みを始めておく（写真を選ぶまでの間に準備できるように）
// 写真から探すは、WebGPU を優先する（使えなければ WASM。カメラは WASM。src/lib/create-detector.ts）
const detector = createDetector('photo');

// 診断（?diag=1&repeat=10）: 選んだ写真を、続けて検出する。WebGPU で、続けて使っても落ちないかを見る（src/lib/diag.ts）
// 結果の画面には進まず、図鑑・経験値・記録にも入れない。前回が途中で止まっていたら、そのようすを出す
const diagBox = __DIAG__ && diag.on ? createDiagBox(document.querySelector('.app')) : null;
if (__DIAG__ && diagBox) {
  const last = readRepeat();
  diagBox.textContent = last ? repeatSummary(last, true) : diag.repeat ? `写真を えらぶと、同じ写真で ${diag.repeat}回 続けて 検出します` : '診断中';
  if (last?.alive) writeRepeat({ ...last, alive: false, done: last.done }); // 見せたら、次は出さない（ようすは残す）
}

// 本番のビルドでは作らない（__DIAG__ が false なら null。関数ごとビルドから消える）
const repeatDetect = __DIAG__ ? async (img: HTMLImageElement, total: number) => {
  const backend = await detector.backend().catch(() => 'error');
  const run = { alive: true, done: 0, total, ms: [] as number[], backend, at: Date.now() };
  writeRepeat(run);
  for (let i = 0; i < total; i++) {
    analyzingText.textContent = `同じ写真で ${i + 1}/${total}回目`;
    const t0 = performance.now();
    try {
      await detector.detect(img, { mode: 'photo', tiles: true, fourThreshold: await fourThresholdFor('photo') });
    } catch (e) {
      writeRepeat({ ...run, alive: false }); // 落ちたのではなく、エラーで止まった
      diagBox!.textContent = `${i + 1}回目で エラーに なりました: ${(e as Error).message}`;
      throw e;
    }
    run.ms.push(Math.round(performance.now() - t0));
    run.done = i + 1;
    run.at = Date.now();
    writeRepeat(run);
    diagBox!.textContent = repeatSummary(run);
  }
  writeRepeat({ ...run, alive: false });
  diagBox!.textContent = repeatSummary({ ...run, alive: false });
} : null;

// ボタンクリックで隠しファイル入力を起動する
pickBtn?.addEventListener('click', () => fileInput.click());

// ドロップゾーンをクリックしても選択できる
document.getElementById('dropZone')?.addEventListener('click', () => fileInput.click());

// ファイル選択後、即座に解析する
fileInput?.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  // ローディング表示
  analyzingText.textContent = '読み込み中…';
  analyzing.hidden = false;
  pickError.hidden = true;

  // File を DataURL に変換する
  const dataUrl = await fileToDataUrl(file);

  // 画像要素を生成して検出器に渡す
  // 写真は大きく、葉が小さく写りやすいので、全体とタイルの両方で探して結果をまとめる
  let detections: Detection[];
  let verifyNeeded = VERIFY_NEEDED;
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    if (repeatDetect && diag.repeat > 0) {
      await repeatDetect(img, diag.repeat);
      analyzing.hidden = true;
      fileInput.value = ''; // 同じ写真を、もう一度えらべるように
      return;
    }
    // 四つ葉のしきい値は、使う人に合わせて少しだけ動かしたもの（設定でオフなら、もとの値。src/lib/tuning.ts）
    const found = await detector.detect(img, { mode: 'photo', tiles: true, fourThreshold: await fourThresholdFor('photo') });

    // 「確かめる」がオフ（v3 から）のときは、検出した四つ葉を、そのまま四つ葉として出す（候補は作らない）
    if (!VERIFY_STEP) {
      detections = found;
    } else {
      // 四つ葉の候補を、自動で確かめる（スコアの高い順。時間の上限を超えそうなら、残りは候補のまま）
      // 確かめて通ったものだけを四つ葉として出し、落ちたものは出さない（三つ葉として数える）
      const fours = found.filter(d => d.label === '四つ葉');
      const others = found.filter(d => d.label !== '四つ葉');
      // 候補が多すぎる写真は、三つ葉を四つ葉と間違えやすいので、3 回とも四つ葉のときだけ通す
      verifyNeeded = fours.length > MANY_CANDIDATES ? VERIFY_NEEDED_STRICT : VERIFY_NEEDED;
      let photo: ImageBitmap | null = null;
      const result = await autoVerify(fours, {
        budgetMs: AUTO_VERIFY_BUDGET_MS,
        now: () => performance.now(),
        verify: async d => {
          photo ??= await createImageBitmap(img, { imageOrientation: 'from-image' });
          return (await verifyLeaf(detector, photo, d.bbox, undefined, verifyNeeded)) === 'four';
        },
        onProgress: (done, total) => { if (total > 0) analyzingText.textContent = `確かめています ${done}/${total}`; },
      });
      (photo as ImageBitmap | null)?.close();
      detections = finalDetections(others, result);
    }
  } catch (e) {
    console.error(e);
    analyzing.hidden = true;
    pickError.hidden = false;
    fileInput.value = ''; // 同じ写真をもう一度選べるようにする
    return;
  }
  // 三つ葉と四つ葉の本数（四つ葉は、確かめて通ったものだけ。候補は数えない）
  const counts = confirmedCounts(detections);
  sessionStorage.setItem('leafCounts', JSON.stringify(counts));
  const kind = resultKind({
    confirmed: detections.filter(d => d.label === '四つ葉' && !d.candidate),
    candidates: detections.filter(d => d.candidate),
  });

  // 経験値（葉の分）: 葉 1 本につき 1 点、1 枚の写真で 200 点まで。同じ写真の 2 回目は 0 点。結果の画面で知らせる
  // 四つ葉の分は、図鑑に保存するところ（src/lib/save-four.ts）で入れる
  let hash: string | undefined;
  let leafXp: ProgressResult | null = null;
  try {
    hash = await photoHash(await file.arrayBuffer());
    leafXp = await recordProgress({ kind: 'photo', hash, leaves: counts.three + counts.four });
  } catch (e) {
    console.warn('経験値を記録できませんでした', e); // 記録できなくても、結果は出す
  }

  analyzing.hidden = true;
  // 結果の画面の文に使う（見つけた四つ葉の候補の数・前にも調べた写真か。src/lib/result-text.ts）
  const shown = { fourDetected: counts.four, repeated: leafXp?.repeated ?? false };

  if (kind === 'found' && getSaveMode() === 'confirm') {
    // 四つ葉がある・「確認してから入れる」→ まだ保存しない。結果の画面の確認のポップアップで、使う人が選んだものだけを保存する
    stashNotice(leafXp);
    sessionStorage.removeItem('lastFoundId');
    await setLastPhoto({ date: Date.now(), imageDataUrl: dataUrl, detections, counts, verifyNeeded, photoHash: hash, pendingReview: true, ...shown });
    location.href = 'photo-found.html';
  } else if (kind === 'found') {
    // 四つ葉がある・「自動で入れる」→ IndexedDB に自動で保存して PhotoFound へ（四つ葉の経験値も、保存の処理で入れる）
    // 図鑑の写真は、四つ葉の枠のまわりで切り抜く（結果の画面には、写真の全体を出す。src/lib/crop.ts）
    const cropped = await cropPhotoRecord(dataUrl, detections);
    const { id, progress: fourXp } = await saveFourLeafRecord({
      date: Date.now(),
      imageDataUrl: cropped.imageDataUrl,
      label: '四つ葉',
      source: 'photo',
      detections: cropped.detections ?? detections,
      counts,
      ...(cropped.crop ? { crop: cropped.crop } : {}),
    }, { count: counts.four, photoHash: hash });
    stashNotice(leafXp && fourXp ? mergeResults(leafXp, fourXp) : leafXp ?? fourXp);
    sessionStorage.setItem('lastFoundId', String(id));
    await setLastPhoto({ date: Date.now(), imageDataUrl: dataUrl, detections, counts, recordId: id, verifyNeeded, photoHash: hash, ...shown });
    location.href = 'photo-found.html';
  } else if (kind === 'candidates') {
    // 候補だけ（時間の上限で確かめきれなかった）→ 保存はしない。結果の画面で、枠をタップして確かめ、通ったら、そのときに自動で保存する
    stashNotice(leafXp);
    sessionStorage.removeItem('lastFoundId');
    await setLastPhoto({ date: Date.now(), imageDataUrl: dataUrl, detections, counts, verifyNeeded, photoHash: hash, ...shown });
    location.href = 'photo-found.html';
  } else {
    // 見つからなかった → PhotoNone へ（本数は sessionStorage の leafCounts で渡す）
    stashNotice(leafXp);
    await setLastPhoto({ date: Date.now(), imageDataUrl: dataUrl, detections, counts, ...shown });
    location.href = 'photo-none.html';
  }
});

// File → DataURL への変換
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
