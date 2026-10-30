// 写真から探したあと、四つ葉の候補を自動で「確かめる」（3 回中 2 回・途中で決まったら止める）
// 確かめて通ったものだけを「四つ葉」として出し、図鑑に自動で保存する。落ちたものは出さない
// 時間の上限を超えそうなら、残りは確かめずに「候補」のままにする（スコアの高い順に確かめる）
// 画面やモデルに頼らない手順だけを置く（Node.js でテストできるように: tests/auto-verify.test.ts）
import type { Detection } from './detector';

export interface AutoVerifyResult {
  confirmed: Detection[];  // 確かめて通った（四つ葉として出す・自動で保存する）
  rejected: Detection[];   // 確かめて落ちた（出さない）
  candidates: Detection[]; // 時間の上限で、確かめなかった（候補として出す。使う人がタップして確かめる）
}

export interface AutoVerifyOptions {
  budgetMs: number;                              // 確かめる時間の上限
  now: () => number;                             // 時計（テストで差し替える）
  verify: (d: Detection) => Promise<boolean>;    // 1 つを確かめる（通ったら true）
  onProgress?: (done: number, total: number) => void; // 「確かめています 3/13」
}

// 候補をスコアの高い順に確かめる。次の 1 つが上限に収まらなさそうなら（今までの 1 つあたりの時間で見積もる）、そこで止める
export async function autoVerify(fours: readonly Detection[], opts: AutoVerifyOptions): Promise<AutoVerifyResult> {
  const order = [...fours].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const result: AutoVerifyResult = { confirmed: [], rejected: [], candidates: [] };
  const start = opts.now();
  let done = 0;
  opts.onProgress?.(0, order.length);
  for (const d of order) {
    const elapsed = opts.now() - start;
    const perOne = done > 0 ? elapsed / done : 0;
    if (done > 0 && elapsed + perOne > opts.budgetMs) {
      result.candidates.push(d);
      continue;
    }
    (await opts.verify(d) ? result.confirmed : result.rejected).push(d);
    done++;
    opts.onProgress?.(done, order.length);
  }
  return result;
}

// 結果の種類と、画面の見出し
export type ResultKind = 'found' | 'candidates' | 'none';

export function resultKind(r: Pick<AutoVerifyResult, 'confirmed' | 'candidates'>): ResultKind {
  if (r.confirmed.length > 0) return 'found';
  if (r.candidates.length > 0) return 'candidates';
  return 'none';
}

export const RESULT_TEXT: Record<ResultKind, { title: string; lead: string }> = {
  found: { title: '四つ葉が見つかりました！', lead: '' },
  candidates: { title: '四つ葉の候補が、ありました。', lead: '拡大して、よく見て、確かめてください' },
  none: { title: '四つ葉は、見つかりませんでした', lead: '' },
};

// 確かめたあとの枠の一覧: 通ったもの（四つ葉）・落ちたもの（三つ葉として数える）・確かめなかったもの（候補の印）
export function finalDetections(others: readonly Detection[], r: AutoVerifyResult): Detection[] {
  return [
    ...others,
    ...r.rejected.map(d => ({ ...d, label: '三つ葉' as const })),
    ...r.confirmed.map(d => ({ ...d, candidate: undefined })),
    ...r.candidates.map(d => ({ ...d, candidate: true })),
  ];
}

// 候補の 1 つを、確かめて通ったことにする（候補の印を外す）
export function confirmCandidate(dets: readonly Detection[], index: number): Detection[] {
  return dets.map((d, i) => (i === index ? { ...d, candidate: undefined } : d));
}

// 本数: 四つ葉は確かめて通ったものだけ、三つ葉は三つ葉の枠だけ（候補は、まだわからないので数えない）
export function confirmedCounts(dets: readonly Detection[]): { three: number; four: number } {
  return {
    three: dets.filter(d => d.label === '三つ葉').length,
    four: dets.filter(d => d.label === '四つ葉' && !d.candidate).length,
  };
}
