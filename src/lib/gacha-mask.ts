// 「今日のよつば」: 今日の形（64×64）を、端末に残すための形にする・戻す（テスト: tests/gacha-mask.test.ts）
// 残すのは IndexedDB（src/lib/gacha-today.ts）。同じ日に開き直したら、モデルを読み込まずに、同じ形を出す
import { SIZE, type Mask } from './gacha-shape.ts';

// 今日の形の記録。残すのは、この端末の中で小さなモデル（DiT）が作った形だけ（作者の決定 2026-10-28）
// あらかじめ作った 60 枚から出した形は残さない（DiT が使えるようになったら、その日のうちに DiT の形に変わるように）
export interface GachaToday {
  id: 'gachaToday';
  day: string;           // 日本時間の日付（'2026-10-28'）
  kind: 'dit';
  mask: string;          // 64×64 の形（1 画素 1 ビット・base64。packMask）
}

// 形を、1 画素 1 ビットの base64 にする（4,096 画素 → 512 バイト）
export function packMask(m: Mask): string {
  if (m.length !== SIZE * SIZE) throw new Error(`形の大きさは ${SIZE}×${SIZE}`);
  const bytes = new Uint8Array(m.length / 8);
  for (let i = 0; i < m.length; i++) if (m[i]) bytes[i >> 3] |= 1 << (i & 7);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function unpackMask(s: string): Mask {
  const bin = atob(s);
  if (bin.length !== (SIZE * SIZE) / 8) throw new Error('形の記録の長さがちがいます');
  const m = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) m[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return m;
}

export function toStored(day: string, mask: Mask): GachaToday {
  return { id: 'gachaToday', day, kind: 'dit', mask: packMask(mask) };
}

// 残っている記録が、今日の DiT の形なら、形を戻す。ちがう日のもの・こわれたもの・前の版が残した 60 枚の形は null（もう一度ひく）
export function fromStored(rec: unknown, day: string): Mask | null {
  const r = rec as Partial<GachaToday> | null | undefined;
  if (!r || r.id !== 'gachaToday' || r.day !== day || r.kind !== 'dit' || typeof r.mask !== 'string') return null;
  try {
    return unpackMask(r.mask);
  } catch {
    return null;
  }
}

// あらかじめ作った絵（RGBA。透明な背景に緑の形）を、64×64 の形にする（不透明さが半分以上 = 葉）
export function maskFromAlpha(rgba: ArrayLike<number>): Mask {
  if (rgba.length !== SIZE * SIZE * 4) throw new Error(`絵の大きさは ${SIZE}×${SIZE}`);
  const m = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) m[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}
