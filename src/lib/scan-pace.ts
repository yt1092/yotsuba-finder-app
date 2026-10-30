// カメラの検出（WASM）で、推論が終わってから、次の推論を始めるまでの間を決める（src/pages/scan.ts）
// ふだんは「直前の推論の時間の半分、ただし最小 200ms」（1 回 約 400ms の iPhone なら、約 200ms 休む）。
// 推論が、いちばん速かったときより、極端に遅くなったら（熱くなった など）、休みを長くして、計算に使う時間を減らす
// モデルや画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/scan-pace.test.ts）

// 推論が、いちばん速かったときの slowFactor 倍以上かかったら、直前の推論の時間と同じだけ休む（計算に使う時間を半分に）。
// verySlowFactor 倍以上なら、2 倍だけ休む（3 分の 1 に）。どんなときも maxMs より長くは休まない
export const WASM_PACE = { ratio: 0.5, minMs: 200, slowFactor: 2, verySlowFactor: 3, maxMs: 5000 } as const;

// lastMs: 直前の推論の時間・fastestMs: これまででいちばん速かった推論の時間（まだ無ければ 0）
export function wasmGapMs(lastMs: number, fastestMs: number, pace: typeof WASM_PACE = WASM_PACE): number {
  let gap = Math.max(pace.minMs, lastMs * pace.ratio);
  if (fastestMs > 0 && lastMs >= fastestMs * pace.verySlowFactor) gap = Math.max(gap, lastMs * 2);
  else if (fastestMs > 0 && lastMs >= fastestMs * pace.slowFactor) gap = Math.max(gap, lastMs);
  return Math.round(Math.min(pace.maxMs, gap));
}
