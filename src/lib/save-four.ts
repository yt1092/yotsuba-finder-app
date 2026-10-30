// 四つ葉を図鑑に保存する処理と、四つ葉の経験値（1 つ 100 点）を、ここ 1 か所にまとめる
// （あとで「確認のポップアップ」で『図鑑に入れる』を選んだときに保存する形に変えても、ここを呼ぶだけでよいように）
// 写真から探したときは、写真のハッシュを渡す: 1 枚の写真で 3 つ（300 点）まで。同じ写真の 2 回目は 0 点
import { addRecord, type CloverRecord } from './db';
import { recordProgress } from './progress-db';
import type { ProgressResult } from './progress';

// 四つ葉の記録を図鑑に保存し、経験値を入れる。戻り値: 記録の ID と、経験値の結果（記録できなかったときは null）
export async function saveFourLeafRecord(rec: Omit<CloverRecord, 'id'>, opts: { count: number; photoHash?: string }): Promise<{ id: number; progress: ProgressResult | null }> {
  const id = await addRecord(rec);
  return { id, progress: await awardFourLeaves(opts.count, opts.photoHash) };
}

// すでにある記録に、四つ葉を足したとき（あとから確かめて通ったときなど）の経験値
export async function awardFourLeaves(count: number, photoHash?: string): Promise<ProgressResult | null> {
  if (count <= 0) return null;
  try {
    return await recordProgress({ kind: 'four', count, photoHash });
  } catch (e) {
    console.warn('経験値を記録できませんでした', e); // 記録できなくても、保存は済んでいる
    return null;
  }
}
