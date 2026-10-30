// src/lib/progress.ts のテスト（レベル・経験値・バッジ）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptyProgress, levelInfo, mergeResults, rankName, xpForNext, xpToReach, MAX_FOURS_PER_PHOTO, MAX_LEAF_XP_PER_PHOTO } from '../src/lib/progress.ts';

test('次のレベルまでの点: Lv1→2 は 100、そのあと 50 ずつ増える', () => {
  assert.equal(xpForNext(1), 100);
  assert.equal(xpForNext(2), 150);
  assert.equal(xpForNext(3), 200);
  assert.equal(xpToReach(1), 0);
  assert.equal(xpToReach(2), 100);
  assert.equal(xpToReach(3), 250);
  assert.equal(xpToReach(4), 450);
});

test('0 点は Lv1・たね、次まで あと 100', () => {
  assert.deepEqual(levelInfo(0), { level: 1, rank: 'たね', into: 0, need: 100, toNext: 100 });
});

test('境目の点: 99 は Lv1、100 で Lv2、249 は Lv2、250 で Lv3', () => {
  assert.equal(levelInfo(99).level, 1);
  assert.equal(levelInfo(99).toNext, 1);
  assert.equal(levelInfo(100).level, 2);
  assert.equal(levelInfo(100).into, 0);
  assert.equal(levelInfo(249).level, 2);
  assert.equal(levelInfo(250).level, 3);
  assert.equal(levelInfo(250).rank, 'めばえ');
});

test('大きな点: どの Lv でも、その Lv の始まりちょうどで上がり、1 点前はひとつ下', () => {
  for (let L = 2; L <= 200; L++) {
    assert.equal(levelInfo(xpToReach(L)).level, L);
    assert.equal(levelInfo(xpToReach(L) - 1).level, L - 1);
  }
  const big = levelInfo(10_000_000);
  assert.ok(big.level > 100);
  assert.ok(big.into >= 0 && big.into < big.need);
  assert.equal(big.rank, 'よつばマスター');
});

test('ランクの名前', () => {
  assert.equal(rankName(2), 'たね');
  assert.equal(rankName(5), 'めばえ');
  assert.equal(rankName(6), 'わかば');
  assert.equal(rankName(14), 'みつば');
  assert.equal(rankName(15), 'よつば');
  assert.equal(rankName(24), 'よつば');
  assert.equal(rankName(25), 'よつばマスター');
});

test('写真から探す: 葉 1 本で 1 点、四つ葉の保存は 1 つで 100 点（2 つを 1 つの知らせにまとめる）', () => {
  const leaves = applyEvent(emptyProgress(), { kind: 'photo', hash: 'aaa', leaves: 42 }, 1);
  assert.equal(leaves.gained, 42);
  const four = applyEvent(leaves.progress, { kind: 'four', count: 1, photoHash: 'aaa' }, 1);
  const r = mergeResults(leaves, four);
  assert.equal(r.gained, 142);
  assert.equal(r.progress.leaves, 42);
  assert.equal(r.progress.fours, 1);
  assert.equal(r.progress.xp, 142);
  assert.equal(r.levelUp?.level, 2);
  assert.deepEqual(r.newBadges.map(b => b.id), ['first-photo', 'first-four']);
});

test('上限: 1 枚の写真の葉の分は 200 点まで（本数はそのまま数える）', () => {
  const r = applyEvent(emptyProgress(), { kind: 'photo', hash: 'many', leaves: 950 }, 1);
  assert.equal(MAX_LEAF_XP_PER_PHOTO, 200);
  assert.equal(r.gained, 200);
  assert.equal(r.progress.leaves, 950);
});

test('上限: 1 枚の写真の四つ葉の分は 3 つ（300 点）まで。分けて保存しても合わせて 3 つ', () => {
  const p = applyEvent(emptyProgress(), { kind: 'photo', hash: 'oxalis', leaves: 46 }, 1).progress;
  const twelve = applyEvent(p, { kind: 'four', count: 12, photoHash: 'oxalis' }, 2);
  assert.equal(MAX_FOURS_PER_PHOTO, 3);
  assert.equal(twelve.gained, 300);
  assert.equal(twelve.progress.fours, 12);
  const a = applyEvent(p, { kind: 'four', count: 2, photoHash: 'oxalis' }, 2);
  const b = applyEvent(a.progress, { kind: 'four', count: 2, photoHash: 'oxalis' }, 3);
  const c = applyEvent(b.progress, { kind: 'four', count: 1, photoHash: 'oxalis' }, 4);
  assert.deepEqual([a.gained, b.gained, c.gained], [200, 100, 0]);
});

test('カメラの四つ葉（写真のハッシュなし）は、上限なしで 1 つ 100 点', () => {
  let p = emptyProgress();
  for (let i = 0; i < 5; i++) p = applyEvent(p, { kind: 'four', count: 1 }, i).progress;
  assert.equal(p.xp, 500);
  assert.equal(p.fours, 5);
});

test('同じ写真の 2 回目は 0 点で、本数も増えない（四つ葉の分も）', () => {
  const first = applyEvent(emptyProgress(), { kind: 'photo', hash: 'aaa', leaves: 10 }, 1);
  const second = applyEvent(first.progress, { kind: 'photo', hash: 'aaa', leaves: 10 }, 2);
  assert.equal(second.gained, 0);
  assert.equal(second.repeated, true);
  const four = applyEvent(second.progress, { kind: 'four', count: 1, photoHash: 'aaa' }, 3);
  assert.equal(four.gained, 0);
  assert.equal(four.repeated, true);
  assert.equal(four.progress.leaves, 10);
  assert.equal(four.progress.fours, 0);
  assert.equal(four.progress.xp, 10);
  assert.equal(four.newBadges.length, 0);
});

test('1 回目に四つ葉を 1 つ保存したあと、同じ写真を調べ直しても、四つ葉の分は入らない', () => {
  let p = applyEvent(emptyProgress(), { kind: 'photo', hash: 'b', leaves: 5 }, 1).progress;
  p = applyEvent(p, { kind: 'four', count: 1, photoHash: 'b' }, 2).progress;
  p = applyEvent(p, { kind: 'photo', hash: 'b', leaves: 5 }, 3).progress;
  const again = applyEvent(p, { kind: 'four', count: 1, photoHash: 'b' }, 4);
  assert.equal(again.gained, 0);
  assert.equal(again.progress.fours, 1);
});

test('葉が 0 本の写真は 0 点（でも「はじめての しゃしん」は取れる）', () => {
  const r = applyEvent(emptyProgress(), { kind: 'photo', hash: 'zero', leaves: 0 }, 1);
  assert.equal(r.gained, 0);
  assert.equal(r.repeated, false);
  assert.equal(r.levelUp, undefined);
  assert.deepEqual(r.newBadges.map(b => b.id), ['first-photo']);
});

test('日記カードは 1 つの記録につき 1 回だけ 30 点。3 まいでバッジ', () => {
  let p = emptyProgress();
  const a = applyEvent(p, { kind: 'diary', recordId: 7 }, 1);
  assert.equal(a.gained, 30);
  const again = applyEvent(a.progress, { kind: 'diary', recordId: 7 }, 2);
  assert.equal(again.gained, 0);
  assert.equal(again.progress.diaryCards, 1);
  p = applyEvent(again.progress, { kind: 'diary', recordId: 8 }, 3).progress;
  const third = applyEvent(p, { kind: 'diary', recordId: 9 }, 4);
  assert.equal(third.progress.diaryCards, 3);
  assert.deepEqual(third.newBadges.map(b => b.id), ['diary-3']);
});

test('バッジは 1 回だけ。取った日時が残る', () => {
  const a = applyEvent(emptyProgress(), { kind: 'note' }, 123);
  assert.deepEqual(a.progress.badges, [{ id: 'note', date: 123 }]);
  const b = applyEvent(a.progress, { kind: 'note' }, 456);
  assert.equal(b.newBadges.length, 0);
  assert.equal(b.progress.badges.length, 1);
});

test('元の中身は変えない', () => {
  const p = emptyProgress();
  applyEvent(p, { kind: 'photo', hash: 'x', leaves: 5 }, 1);
  assert.deepEqual(p, emptyProgress());
});

test('確認のポップアップ: 「図鑑に入れる」を選んだ数だけ、四つ葉の経験値が入る（1 枚の写真で 3 つまで）', () => {
  // 写真から探す（葉の分）→ ポップアップで 2 つ入れる → 1 つ 100 点
  const p = applyEvent(emptyProgress(), { kind: 'photo', hash: 'img1403', leaves: 46 }, 1).progress;
  const two = applyEvent(p, { kind: 'four', count: 2, photoHash: 'img1403' }, 2);
  assert.equal(two.gained, 200);
  assert.equal(two.progress.xp, 46 + 200);
  // 4 つ入れても、300 点まで
  const four = applyEvent(p, { kind: 'four', count: 4, photoHash: 'img1403' }, 2);
  assert.equal(four.gained, 300);
  // 1 つも入れなければ、四つ葉の経験値は入らない（ポップアップは、入れた数が 0 のとき保存も経験値も呼ばない）
  assert.equal(p.xp, 46);
});

test('「入れない」を選んで記録された（teach）: 初めてのときだけ、バッジ「はじめて まちがいを おしえた」。経験値は付けない', () => {
  const first = applyEvent(emptyProgress(), { kind: 'teach' }, 1);
  assert.equal(first.gained, 0);
  assert.equal(first.progress.xp, 0);
  assert.deepEqual(first.newBadges.map(b => b.id), ['first-teach']);
  const second = applyEvent(first.progress, { kind: 'teach' }, 2);
  assert.equal(second.gained, 0);
  assert.deepEqual(second.newBadges, []);
});
