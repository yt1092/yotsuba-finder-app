// 使うほど合う、端末内の調整（画面や DB に頼らない計算だけ。tests/tuning.test.ts）
// 確認のポップアップで選んだ「図鑑に入れる／入れない」（スコアと、選んだ結果）から、
// 「入れる」と選ばれやすいスコアの境目を推定し、四つ葉の候補を出すしきい値を、少しだけ動かす
// - 十分な数が貯まるまでは動かさない（「入れる」5 件以上・「入れない」5 件以上・合計 20 件以上）
// - もとの値に強く引き寄せる（正則化）。動かせる幅は ±0.1 まで
// - 「入れない」は、必ずしも誤検出ではない（好みのこともある）ので、しきい値を上げる向き（候補を減らす向き）の動きは半分にする
// 選んだ記録は、この端末の IndexedDB だけに残す（外には送らない。src/lib/tuning-db.ts）

export interface Choice {
  score: number;  // 候補のスコア（0〜1）
  keep: boolean;  // 図鑑に入れた
}

export const MIN_KEEP = 5;
export const MIN_SKIP = 5;
export const MIN_TOTAL = 20;
export const MAX_SHIFT = 0.1;     // 動かせる幅（もとの値から ±0.1）
const SKIP_WEIGHT = 1;             // 「入れない」1 件の重み（当てはめでは同じにする。半分にすると、半々に選ぶ人で、しきい値が下がってしまうため）
const RAISE_FACTOR = 0.5;          // しきい値を上げる向き（「入れない」が多い）の動きは半分にする
const PRIOR_SLOPE = 10;            // 正則化: 傾きを、なだらかに上がる値に引き寄せる
const SLOPE_SD = 10;               //   傾きの引き寄せのゆるさ（大きいほどゆるい）
const BOUNDARY_SD = 0.1;           // 正則化: 境目を、もとの値に引き寄せる強さ（小さいほど強い）
const SHRINK_N = 40;               // 件数が少ないうちは、さらにもとの値に寄せる（n / (n + 40)）

export interface TuningResult {
  threshold: number;  // 使うしきい値
  shift: number;      // もとの値からの差
  ready: boolean;     // 十分な数が貯まった
  boundary?: number;  // 推定した「入れる」と選ばれやすい境目（参考）
}

// 「入れる」の確からしさ = σ(a·(スコア − b)) を、重みと正則化つきで当てはめ、境目 b を返す
// 正則化: 境目 b はもとの値に、傾き a は「なだらかに上がる」値に引き寄せる（スコアと関係なく選ぶ人では、b はほとんど動かない）
// 当てはめは、勾配の向きに、損失が下がる歩幅で進む（行きすぎたら歩幅を半分にする）
export function estimateBoundary(choices: readonly Choice[], base: number): number | undefined {
  const loss = (a: number, b: number) => {
    let l = ((a - PRIOR_SLOPE) / SLOPE_SD) ** 2 / 2 + ((b - base) / BOUNDARY_SD) ** 2 / 2;
    for (const ch of choices) {
      const z = a * (ch.score - b);
      const t = ch.keep ? -z : z; // 入れた: log(1 + e^-z)・入れなかった: log(1 + e^z)
      l += (ch.keep ? 1 : SKIP_WEIGHT) * (t > 0 ? t + Math.log1p(Math.exp(-t)) : Math.log1p(Math.exp(t)));
    }
    return l;
  };
  const grad = (a: number, b: number): [number, number] => {
    let ga = (a - PRIOR_SLOPE) / SLOPE_SD ** 2, gb = (b - base) / BOUNDARY_SD ** 2;
    for (const ch of choices) {
      const w = ch.keep ? 1 : SKIP_WEIGHT;
      const p = 1 / (1 + Math.exp(-a * (ch.score - b)));
      const r = w * (p - (ch.keep ? 1 : 0));
      ga += r * (ch.score - b);
      gb += -r * a;
    }
    return [ga, gb];
  };
  let a = PRIOR_SLOPE, b = base, step = 0.01;
  let cur = loss(a, b);
  for (let iter = 0; iter < 2000; iter++) {
    const [ga, gb] = grad(a, b);
    // a と b は大きさがちがうので、b の向きを大きくする（b は 0〜1、a は 0〜数十）
    let na = a - step * ga, nb = b - step * gb * 0.01;
    let next = loss(na, nb);
    while (next > cur && step > 1e-8) {
      step /= 2;
      na = a - step * ga; nb = b - step * gb * 0.01;
      next = loss(na, nb);
    }
    if (cur - next < 1e-10) break;
    a = na; b = nb; cur = next;
    step *= 1.5;
  }
  if (!(a > 0.5) || !Number.isFinite(b)) return undefined; // スコアが高いほど入れる、という向きが読めない
  return b;
}

export function tuneThreshold(choices: readonly Choice[], base: number, enabled = true): TuningResult {
  const keeps = choices.filter(c => c.keep).length;
  const skips = choices.length - keeps;
  const ready = keeps >= MIN_KEEP && skips >= MIN_SKIP && choices.length >= MIN_TOTAL;
  if (!enabled || !ready) return { threshold: base, shift: 0, ready };
  const boundary = estimateBoundary(choices, base);
  if (boundary === undefined) return { threshold: base, shift: 0, ready };
  let shift = boundary - base;
  if (shift > 0) shift *= RAISE_FACTOR;
  shift *= choices.length / (choices.length + SHRINK_N);
  shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, shift));
  shift = Math.round(shift * 1000) / 1000;
  return { threshold: Math.round((base + shift) * 1000) / 1000, shift, ready, boundary };
}
