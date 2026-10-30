// 版 5 へ上げるとき: 図鑑の入れ物にある今日のよつばを、今日のよつばの入れ物へ移す（IndexedDB に頼らない手順。tests/gacha-move.test.ts）
// IndexedDB とのつなぎは src/lib/db.ts（moveGachaRecords）
// 1. 移す前に、元の値（移すもの全部）を残す。残せなければ、移さない（図鑑の入れ物に残したまま。一覧では混ぜない。src/lib/gacha-list.ts）
// 2. 1 件ずつ、今日のよつばの入れ物に書けたら、図鑑の入れ物から消す。書けなかったものは、図鑑の入れ物に残し、理由を残す
// 3. 最後に、結果（移した ID・移せなかった ID と理由）を、元の値といっしょに残し直す
// どの失敗も、呼ぶ側には投げない（DB を開くこと自体は止めない）
import { GACHA_MOVE_KEY, planGachaMove } from './gacha-list.ts'; // node のテストでそのまま読めるように、.ts を付ける
import type { CloverRecord } from './db';

export interface GachaMoveSummary {
  id: typeof GACHA_MOVE_KEY;
  at: number;
  fromVersion: number;
  records: CloverRecord[];   // 移す前の元の値
  moved: number[];
  failed: { id: number; reason: string }[];
  done: boolean;             // 全部を試し終えた
}

// 入れ物への操作（IndexedDB では、どれも、あとで ok か fail が 1 回呼ばれる）
export interface GachaMoveOps {
  getAll(ok: (records: CloverRecord[]) => void, fail: (reason: string) => void): void;
  keep(summary: GachaMoveSummary, ok: () => void, fail: (reason: string) => void): void; // 元の値・結果を残す
  add(rec: CloverRecord & { id: number }, ok: () => void, fail: (reason: string) => void): void; // 今日のよつばの入れ物へ
  remove(id: number): void;  // 図鑑の入れ物から
  warn?(message: string, reason: string): void;
}

export function moveGacha(ops: GachaMoveOps, fromVersion: number, now: number): void {
  const warn = (m: string, r: string) => ops.warn?.(m, r);
  ops.getAll(all => {
    const move = planGachaMove(all);
    if (move.length === 0) return;
    const summary: GachaMoveSummary = { id: GACHA_MOVE_KEY, at: now, fromVersion, records: move.map(r => ({ ...r })), moved: [], failed: [], done: false };
    ops.keep(summary, () => {
      let left = move.length;
      const finish = () => {
        if (--left > 0) return;
        summary.done = true;
        ops.keep(summary, () => undefined, r => warn('今日のよつば: 移した結果を残せませんでした', r));
      };
      for (const r of move) {
        ops.add(r, () => { ops.remove(r.id); summary.moved.push(r.id); finish(); },
          reason => { summary.failed.push({ id: r.id, reason }); finish(); });
      }
    }, r => warn('今日のよつば: 元の値を残せないので、移しませんでした', r));
  }, r => warn('今日のよつば: 図鑑の記録を読めないので、移しませんでした', r));
}
