// 確認のポップアップで、四つ葉の候補を 1 つずつ決めていく動き（入れる／入れない／ぜんぶ入れない／決めた結果）
// 画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/four-review.test.ts）

export type ReviewChoice = 'keep' | 'skip';

export interface ReviewState {
  index: number;                    // 今見ている候補（0 から）
  choices: (ReviewChoice | null)[]; // 候補ごとの答え（まだなら null）
  done: boolean;                    // すべて決めた
}

// 候補が多いときは、最初の画面に「ぜんぶ入れない」を出す
export const SKIP_ALL_FROM = 10;

export function startReview(count: number): ReviewState {
  return { index: 0, choices: Array(count).fill(null), done: count === 0 };
}

// 今の候補を決めて、まだ決めていない次の候補へ進む（うしろに無ければ、前にもどって探す）。全部決めたら done
export function decide(s: ReviewState, choice: ReviewChoice): ReviewState {
  if (s.done) return s;
  const choices = [...s.choices];
  choices[s.index] = choice;
  const n = choices.length;
  for (let k = 1; k <= n; k++) {
    const i = (s.index + k) % n;
    if (choices[i] === null) return { index: i, choices, done: false };
  }
  return { index: s.index, choices, done: true };
}

// まえへ・つぎへ（はしでは止まる）
export function move(s: ReviewState, delta: number): ReviewState {
  if (s.done) return s;
  return { ...s, index: Math.min(s.choices.length - 1, Math.max(0, s.index + delta)) };
}

// ぜんぶ入れない（まだ決めていない候補を、すべて「入れない」にする）
export function skipAll(s: ReviewState): ReviewState {
  return { index: s.index, choices: s.choices.map(c => c ?? 'skip'), done: true };
}

// 「ぜんぶ入れない」を出すか（候補が多く、まだ 1 つも決めていないとき）
export const showSkipAll = (s: ReviewState): boolean => !s.done && s.choices.length >= SKIP_ALL_FROM && s.choices.every(c => c === null);

export interface ReviewSummary {
  kept: number[];     // 「図鑑に入れる」を選んだ候補の番号
  skipped: number[];  // 「入れない」を選んだ候補の番号
  complete: boolean;  // 全部の候補を決めた（false なら、× で閉じた）
}

export function summarize(s: ReviewState): ReviewSummary {
  const kept = s.choices.flatMap((c, i) => (c === 'keep' ? [i] : []));
  const skipped = s.choices.flatMap((c, i) => (c === 'skip' ? [i] : []));
  return { kept, skipped, complete: s.done };
}

// たしかさのめやす（3 段階）。数字は画面に出さない。境目は src/lib/detector-config.ts の CONFIDENCE_LEVELS（実測で決めた）
export type Confidence = 3 | 2 | 1;
export function confidenceLevel(score: number | undefined, levels: { high: number; mid: number }): Confidence {
  const s = score ?? 0;
  return s >= levels.high ? 3 : s >= levels.mid ? 2 : 1;
}
export const CONFIDENCE_TEXT: Record<Confidence, { dots: string; word: string }> = {
  3: { dots: '●●●', word: '高め' },
  2: { dots: '●●○', word: 'ふつう' },
  1: { dots: '●○○', word: '低め' },
};
