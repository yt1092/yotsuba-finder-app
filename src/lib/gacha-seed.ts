// 「今日のよつば」の種（テスト: tests/gacha-seed.test.ts）
// 種 = 「端末ごとの値」＋「日本時間の日付」＋「作り直しの番号」をまぜた 32 ビットの値（作者の決定 2026-10-28）
// - 端末ごとの値: 初めて使うときに crypto.getRandomValues で作り、IndexedDB に残す（src/lib/gacha-device.ts）。
//   外のサーバーやデータベースは使わない。端末の特徴（フィンガープリント）も使わない
// - 同じ端末の同じ日は、同じ形。別の端末では、同じ日でも別の形
// - 「すべてのデータを消す」で、端末の値も消える（次は新しい値）。書き出し・読み込みには入れない
import { GACHA_COUNT } from './gacha.ts';

export const DEVICE_WORDS = 4; // 端末の値: 32 ビット × 4（128 ビット）

// 端末の値を新しく作る
export function newDeviceValue(): number[] {
  return Array.from(crypto.getRandomValues(new Uint32Array(DEVICE_WORDS)));
}

export function isDeviceValue(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === DEVICE_WORDS && v.every(w => Number.isInteger(w) && w >= 0 && w <= 0xffffffff);
}

// 32 ビットの値を、よくまぜる（MurmurHash3 の最後の手順）
function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// 種: 端末の値・日付（1970-01-01 からの日数）・作り直しの番号（0〜8）を、順にまぜる
export function mixSeed(device: readonly number[], day: number, retry: number): number {
  let h = 0x9e3779b9;
  for (const w of [...device, day >>> 0, retry >>> 0]) h = fmix((h ^ w) + 0x6d2b79f5);
  return h;
}

// あらかじめ作った 60 枚から、種で 1 枚（1〜60）
export function presetNumber(seed: number, count = GACHA_COUNT): number {
  return (seed % count) + 1;
}
