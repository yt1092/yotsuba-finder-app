// 「今日のよつば」: 今日の形を、IndexedDB に残す・読む（形の書き方は src/lib/gacha-mask.ts）
// 入れ物は progress（id: 'gachaToday'。1 件だけ。次の日にひくと、置きかえる。DiT の形だけ）。「すべてのデータを消す」で消える（src/lib/wipe.ts）
import { PROGRESS_STORE, openDb } from './db';
import { fromStored, toStored } from './gacha-mask';
import type { Mask } from './gacha-shape';

// 今日の DiT の形（無ければ null）
export async function loadToday(day: string): Promise<Mask | null> {
  try {
    const db = await openDb();
    const rec = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(PROGRESS_STORE, 'readonly').objectStore(PROGRESS_STORE).get('gachaToday');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return fromStored(rec, day);
  } catch {
    return null;
  }
}

// 今日の DiT の形を残す（60 枚から出した形は、残さない）
export async function saveToday(day: string, mask: Mask): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROGRESS_STORE, 'readwrite');
    tx.objectStore(PROGRESS_STORE).put(toStored(day, mask));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
