// まちがいの報告（「これは四つ葉じゃない」「合っている」「四つ葉を見逃している」）の記録の形と計算
// 記録はこの端末の中（IndexedDB の feedback）にだけ保存する。書き出すのは、使う人が押したときだけ
// 画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/feedback.test.ts）
import type { Detection } from './detector';

type Box = Detection['bbox'];

// 見逃した場所の、仮の枠の大きさ（写真の短い辺に対する割合）。見つかった枠が無いときに使う
export const PROVISIONAL_FRACTION = 0.12;
// 仮の枠の最初の大きさの範囲（写真の短い辺に対する割合）と、小さくできる下限
export const MISSED_MIN_FRACTION = 0.1;
export const MISSED_MAX_FRACTION = 0.25;
export const MISSED_RESIZE_MIN_FRACTION = 0.04;

// 使う人の答え
export type FeedbackAnswer =
  | { kind: 'correct'; index: number; bbox: Box }   // 合っている（index は、そのときの検出結果の何番目か）
  | { kind: 'not-four'; index: number; bbox: Box }  // これは四つ葉じゃない
  | { kind: 'missed'; bbox: Box; provisional: true; at: number }; // 四つ葉を見逃している（仮の枠。at はタップした時刻）

// 1 枚の写真についての記録（同じ写真への答えは、1 つの記録にまとめる）
export interface FeedbackEntry {
  key: string;            // 写真ごとの名前（図鑑の記録なら record:<id>、写真から探したものなら photo:<時刻>）
  date: number;           // さいごに答えた日時
  photo: ArrayBuffer;     // 写真（JPEG。長い辺を 1600px 以下に縮めたもの）
  width: number;          // 縮めたあとの写真の大きさ
  height: number;
  detections: Pick<Detection, 'label' | 'bbox'>[]; // そのときの検出結果（縮めたあとの座標。スコアは入れない）
  answers: FeedbackAnswer[];
}

// 見逃した場所（タップした点）から、仮の枠を作る（写真の中に収める）。size を省くと、短い辺の 12%
export function provisionalBox(x: number, y: number, width: number, height: number, size = Math.min(width, height) * PROVISIONAL_FRACTION): Box {
  const left = Math.min(Math.max(x - size / 2, 0), width - size);
  const top = Math.min(Math.max(y - size / 2, 0), height - size);
  return { x: left, y: top, w: size, h: size };
}

// 仮の枠の最初の大きさ: 写真の中で見つかった枠（三つ葉・四つ葉）の大きさの中央値。短い辺の 10〜25% に収める
export function initialMissedSize(detections: readonly Pick<Detection, 'bbox'>[], width: number, height: number): number {
  const short = Math.min(width, height);
  if (detections.length === 0) return short * PROVISIONAL_FRACTION;
  const sizes = detections.map(d => Math.max(d.bbox.w, d.bbox.h)).sort((a, b) => a - b);
  const mid = sizes.length % 2 ? sizes[(sizes.length - 1) / 2] : (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2;
  return Math.min(Math.max(mid, short * MISSED_MIN_FRACTION), short * MISSED_MAX_FRACTION);
}

// 枠を動かす（写真の中に収める）
export function moveBox(box: Box, dx: number, dy: number, width: number, height: number): Box {
  return {
    ...box,
    x: Math.min(Math.max(box.x + dx, 0), width - box.w),
    y: Math.min(Math.max(box.y + dy, 0), height - box.h),
  };
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

// 四隅のつまみで大きさを変える（つまみを x, y へ。反対の角は動かさない。写真の中・下限の大きさを守る）
export function resizeBox(box: Box, corner: Corner, x: number, y: number, width: number, height: number): Box {
  const min = Math.min(width, height) * MISSED_RESIZE_MIN_FRACTION;
  let left = box.x, top = box.y, right = box.x + box.w, bottom = box.y + box.h;
  const cx = Math.min(Math.max(x, 0), width), cy = Math.min(Math.max(y, 0), height);
  if (corner.includes('w')) left = Math.min(cx, right - min); else right = Math.max(cx, left + min);
  if (corner.includes('n')) top = Math.min(cy, bottom - min); else bottom = Math.max(cy, top + min);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// 答えを足す。同じ枠への答え（「合っている」と「四つ葉じゃない」）は、新しいほうに置きかえる
export function addAnswer(answers: readonly FeedbackAnswer[], answer: FeedbackAnswer): FeedbackAnswer[] {
  if (answer.kind === 'missed') return [...answers, answer];
  return [...answers.filter(a => a.kind === 'missed' || a.index !== answer.index), answer];
}

// 写真の座標を、縮めた写真の座標に直す
export function scaleBox(box: Box, scale: number): Box {
  return { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale };
}

// 書き出す JSON（写真は zip の中の photos/ に別のファイルとして入れる）
export function exportJson(entries: readonly FeedbackEntry[], photoName: (index: number) => string, exportedAt: Date) {
  return {
    app: 'YOTSUBA FINDER',
    about: 'まちがいの報告。写真の座標は、縮めたあとの写真（photo）の左上を 0 とした px。provisional の枠は、使う人がタップした場所の仮の枠',
    exportedAt: exportedAt.toISOString(),
    count: entries.length,
    items: entries.map((e, i) => ({
      photo: photoName(i),
      date: new Date(e.date).toISOString(),
      width: e.width,
      height: e.height,
      detections: e.detections.map(d => ({ label: d.label, bbox: roundBox(d.bbox) })),
      answers: e.answers.map(a => ({ ...a, bbox: roundBox(a.bbox), ...(a.kind === 'missed' ? { at: new Date(a.at).toISOString() } : {}) })),
    })),
  };
}

function roundBox(b: Box): Box {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
}
