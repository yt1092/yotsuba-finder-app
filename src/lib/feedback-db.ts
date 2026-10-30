// まちがいの報告の記録を、IndexedDB の feedback に保存する（この端末の中だけ）
import { openDb, FEEDBACK_STORE } from './db';
import { addAnswer, scaleBox, type FeedbackAnswer, type FeedbackEntry } from './feedback';
import type { Detection } from './detector';
import { requestPersist } from './persist';

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const req = run(db.transaction(FEEDBACK_STORE, mode).objectStore(FEEDBACK_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const countFeedback = () => request('readonly', s => s.count());
export const allFeedback = () => request<FeedbackEntry[]>('readonly', s => s.getAll());
export const clearFeedback = () => request('readwrite', s => s.clear()).then(() => undefined);

// 写真の長い辺を 1600px 以下に縮めて、JPEG にする（記録の大きさを抑えるため）
const MAX_SIDE = 1600;
async function shrinkPhoto(photo: ImageBitmap): Promise<{ buffer: ArrayBuffer; width: number; height: number; scale: number }> {
  const scale = Math.min(1, MAX_SIDE / Math.max(photo.width, photo.height));
  const width = Math.round(photo.width * scale), height = Math.round(photo.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(photo, 0, 0, width, height);
  // canvas から書き出すので、位置情報などのメタデータは入らない
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('写真を縮められませんでした'))), 'image/jpeg', 0.9));
  return { buffer: await blob.arrayBuffer(), width, height, scale };
}

// 答えを 1 つ保存する。同じ写真（key）の記録があれば、そこに足す
// answer の枠は、元の写真の座標で渡す（保存するときに、縮めた写真の座標に直す）
export async function saveAnswer(key: string, photo: ImageBitmap, detections: readonly Detection[], answer: FeedbackAnswer): Promise<void> {
  const existing = await request<FeedbackEntry | undefined>('readonly', s => s.get(key));
  let entry: FeedbackEntry;
  if (existing) {
    const scale = existing.width / photo.width;
    entry = { ...existing, date: Date.now(), answers: addAnswer(existing.answers, { ...answer, bbox: scaleBox(answer.bbox, scale) }) };
  } else {
    const small = await shrinkPhoto(photo);
    entry = {
      key,
      date: Date.now(),
      photo: small.buffer,
      width: small.width,
      height: small.height,
      detections: detections.map(d => ({ label: d.label, bbox: scaleBox(d.bbox, small.scale) })),
      answers: addAnswer([], { ...answer, bbox: scaleBox(answer.bbox, small.scale) }),
    };
  }
  await request('readwrite', s => s.put(entry));
  await requestPersist({ once: true }); // 記録が勝手に消されにくくする（src/lib/persist.ts）
}
