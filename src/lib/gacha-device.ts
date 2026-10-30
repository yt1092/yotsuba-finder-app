// 「今日のよつば」: 端末ごとの値（種のもと。src/lib/gacha-seed.ts）を、IndexedDB に残す・読む
// 入れ物は progress（id: 'gachaDevice'）。「すべてのデータを消す」で消える（src/lib/wipe.ts）。書き出し・読み込みには入れない
import { PROGRESS_STORE, openDb } from './db';
import { isDeviceValue, newDeviceValue } from './gacha-seed';

export const DEVICE_KEY = 'gachaDevice';

// 端末の値（無ければ作って残す）
export async function deviceValue(): Promise<number[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROGRESS_STORE, 'readwrite');
    const store = tx.objectStore(PROGRESS_STORE);
    let value: number[] = [];
    const req = store.get(DEVICE_KEY);
    req.onsuccess = () => {
      const rec = req.result as { value?: unknown } | undefined;
      if (rec && isDeviceValue(rec.value)) {
        value = rec.value;
      } else {
        value = newDeviceValue();
        store.put({ id: DEVICE_KEY, value, at: Date.now() });
      }
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}
