// すべてのデータを消す（設定の「すべてのデータを消す」。src/pages/settings.ts）
// データは、この端末の中（IndexedDB とブラウザの保存場所）にだけある。ここで、いつでも消せる
// 消すもの: 図鑑（記録。ひとこと・日記の手書きも記録の中にある）・今日のよつばの一覧と、版 5 へ上げたときに残した元の値・最後に調べた写真・まちがいの記録・
//           きろく（経験値・バッジ）・端末内の調整の記録・今日のよつばの今日の形と端末ごとの値（次は新しい値になる）・結果の画面へ渡すための一時的な値
// 消さないもの: チュートリアルの「見た」という印（設定から、もういちど見られるため）・保存のしかたなどの設定・
//               Service Worker のキャッシュ（アプリとモデル。オフラインで動くため）・カメラの許可（ブラウザの設定）
import { FEEDBACK_STORE, GACHA_STORE, PROGRESS_STORE, openDb } from './db';
import { GACHA_MOVE_KEY } from './gacha-list';

const STORES_TO_CLEAR = ['records', GACHA_STORE, FEEDBACK_STORE, 'lastPhoto']; // src/lib/db.ts の入れ物の名前（今日のよつばの一覧も）
const PROGRESS_KEYS = ['me', 'tuning', 'gachaToday', 'gachaDevice', GACHA_MOVE_KEY]; // progress の入れ物の中で消すもの（'tutorial' は残す。今日の形 src/lib/gacha-today.ts・端末ごとの値 src/lib/gacha-device.ts）
const SESSION_KEYS = ['lastFoundId', 'leafCounts', 'yotsuba-progress-notice', 'scanLastSavedAt'];

export async function wipeAllData(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const names = STORES_TO_CLEAR.filter(n => db.objectStoreNames.contains(n));
    const tx = db.transaction([...names, PROGRESS_STORE], 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    for (const k of PROGRESS_KEYS) tx.objectStore(PROGRESS_STORE).delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  try {
    for (const k of SESSION_KEYS) sessionStorage.removeItem(k);
  } catch { /* 使えなくても、記録は消えている */ }
}
