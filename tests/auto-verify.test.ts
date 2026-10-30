// src/lib/auto-verify.ts のテスト（四つ葉の候補を自動で確かめる手順と、結果のことば）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoVerify, resultKind, RESULT_TEXT } from '../src/lib/auto-verify.ts';

const four = (score: number, id: number) => ({ bbox: { x: id * 10, y: 0, w: 10, h: 10 }, label: '四つ葉' as const, score });

// 1 つ確かめるのに cost ミリ秒かかる、にせの時計と判定
function fake(cost: number, pass: (score: number) => boolean) {
  let t = 0;
  const order: number[] = [];
  return {
    order,
    now: () => t,
    verify: async (d: { score?: number }) => { t += cost; order.push(d.score!); return pass(d.score!); },
  };
}

test('スコアの高い順に確かめ、通ったもの・落ちたものに分ける', async () => {
  const f = fake(100, s => s >= 0.7);
  const fours = [four(0.6, 1), four(0.9, 2), four(0.75, 3)];
  const r = await autoVerify(fours, { budgetMs: 10_000, now: f.now, verify: f.verify });
  assert.deepEqual(f.order, [0.9, 0.75, 0.6]);
  assert.deepEqual(r.confirmed.map(d => d.score), [0.9, 0.75]);
  assert.deepEqual(r.rejected.map(d => d.score), [0.6]);
  assert.equal(r.candidates.length, 0);
});

test('時間の上限: 次の 1 つが収まらなければ止め、残りは候補のままにする', async () => {
  const f = fake(3000, () => true); // 1 つ 3 秒
  const fours = [0.9, 0.8, 0.7, 0.6, 0.5].map(four);
  const r = await autoVerify(fours, { budgetMs: 10_000, now: f.now, verify: f.verify });
  assert.equal(f.order.length, 3);                       // 3 + 3 + 3 = 9 秒。4 つ目は 12 秒になるので確かめない
  assert.deepEqual(r.confirmed.map(d => d.score), [0.9, 0.8, 0.7]);
  assert.deepEqual(r.candidates.map(d => d.score), [0.6, 0.5]);
});

test('進み具合を知らせる（「確かめています 3/13」）', async () => {
  const f = fake(10, () => false);
  const seen: string[] = [];
  await autoVerify([0.9, 0.8, 0.7].map(four), { budgetMs: 10_000, now: f.now, verify: f.verify, onProgress: (d, t) => seen.push(`${d}/${t}`) });
  assert.deepEqual(seen, ['0/3', '1/3', '2/3', '3/3']);
});

test('候補が 0 なら、何もしない', async () => {
  const f = fake(10, () => true);
  const r = await autoVerify([], { budgetMs: 10_000, now: f.now, verify: f.verify });
  assert.deepEqual(r, { confirmed: [], rejected: [], candidates: [] });
});

test('結果のことば: 通ったもの → 見つかりました / 候補だけ → 候補があります / 0 → 見つかりませんでした', () => {
  const d = four(0.9, 1);
  assert.equal(resultKind({ confirmed: [d], candidates: [d] }), 'found');
  assert.equal(resultKind({ confirmed: [], candidates: [d] }), 'candidates');
  assert.equal(resultKind({ confirmed: [], candidates: [] }), 'none');
  assert.equal(RESULT_TEXT.found.title, '四つ葉が見つかりました！');
  assert.equal(RESULT_TEXT.candidates.title + RESULT_TEXT.candidates.lead, '四つ葉の候補が、ありました。拡大して、よく見て、確かめてください');
  assert.equal(RESULT_TEXT.none.title, '四つ葉は、見つかりませんでした');
});

test('確かめたあとの枠: 落ちたものは三つ葉に、確かめなかったものは候補の印。本数は、通った四つ葉と三つ葉だけ', async () => {
  const { finalDetections, confirmCandidate, confirmedCounts } = await import('../src/lib/auto-verify.ts');
  const three = { bbox: { x: 0, y: 0, w: 5, h: 5 }, label: '三つ葉' as const, score: 0.8 };
  const r = { confirmed: [four(0.9, 1)], rejected: [four(0.8, 2)], candidates: [four(0.7, 3)] };
  const dets = finalDetections([three], r);
  assert.deepEqual(dets.map(d => `${d.label}${d.candidate ? '（候補）' : ''}`), ['三つ葉', '三つ葉', '四つ葉', '四つ葉（候補）']);
  assert.deepEqual(confirmedCounts(dets), { three: 2, four: 1 });
  // 候補を確かめて通ったら、印を外し、四つ葉として数える
  const after = confirmCandidate(dets, 3);
  assert.equal(after[3].candidate, undefined);
  assert.deepEqual(confirmedCounts(after), { three: 2, four: 2 });
});
