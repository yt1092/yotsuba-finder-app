// src/lib/feedback.ts のテスト（まちがいの報告の、仮の枠・答えのまとめ方・書き出しの形）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionalBox, addAnswer, exportJson, scaleBox, initialMissedSize, moveBox, resizeBox, PROVISIONAL_FRACTION, type FeedbackEntry } from '../src/lib/feedback.ts';

test('仮の枠: 写真の短い辺の 12% の正方形で、タップした点が真ん中', () => {
  assert.equal(PROVISIONAL_FRACTION, 0.12);
  const b = provisionalBox(500, 400, 1600, 1000);
  assert.deepEqual(b, { x: 440, y: 340, w: 120, h: 120 });
});

test('仮の枠: 写真の端をタップしても、写真の中に収める', () => {
  assert.deepEqual(provisionalBox(5, 995, 1600, 1000), { x: 0, y: 880, w: 120, h: 120 });
  assert.deepEqual(provisionalBox(1599, 0, 1600, 1000), { x: 1480, y: 0, w: 120, h: 120 });
});

test('仮の枠の最初の大きさ: 見つかった枠の中央値。短い辺の 10〜25% に収める', () => {
  const box = (s: number) => ({ bbox: { x: 0, y: 0, w: s, h: s * 0.8 } });
  // 短い辺 1000 → 100〜250
  assert.equal(initialMissedSize([box(120), box(180), box(150)], 1600, 1000), 150); // 中央値
  assert.equal(initialMissedSize([box(40), box(60)], 1600, 1000), 100);             // 小さすぎ → 10%
  assert.equal(initialMissedSize([box(400)], 1600, 1000), 250);                     // 大きすぎ → 25%
  assert.equal(initialMissedSize([], 1600, 1000), 120);                             // 枠が無い → 12%
});

test('仮の枠を動かす・大きさを変える: 写真の中に収め、小さくしすぎない', () => {
  const b = { x: 100, y: 100, w: 200, h: 200 };
  assert.deepEqual(moveBox(b, 50, -30, 1000, 800), { x: 150, y: 70, w: 200, h: 200 });
  assert.deepEqual(moveBox(b, 5000, 5000, 1000, 800), { x: 800, y: 600, w: 200, h: 200 }); // 右下の端で止まる
  // 右下のつまみを外へ → 大きく（右下は写真の端まで）
  assert.deepEqual(resizeBox(b, 'se', 1200, 500, 1000, 800), { x: 100, y: 100, w: 900, h: 400 });
  // 左上のつまみを、右下の角を越えて動かしても、下限（短い辺の 4% = 32）より小さくならない
  assert.deepEqual(resizeBox(b, 'nw', 900, 900, 1000, 800), { x: 268, y: 268, w: 32, h: 32 });
});

test('答え: 同じ枠への答えは新しいほうに置きかえ、見逃しは足していく', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  let answers = addAnswer([], { kind: 'correct', index: 0, bbox: box });
  answers = addAnswer(answers, { kind: 'not-four', index: 1, bbox: box });
  answers = addAnswer(answers, { kind: 'not-four', index: 0, bbox: box }); // 0 番を言い直す
  answers = addAnswer(answers, { kind: 'missed', bbox: box, provisional: true, at: 1 });
  answers = addAnswer(answers, { kind: 'missed', bbox: box, provisional: true, at: 2 });
  assert.deepEqual(answers.map(a => a.kind === 'missed' ? `missed@${a.at}` : `${a.kind}#${a.index}`),
    ['not-four#1', 'not-four#0', 'missed@1', 'missed@2']);
});

test('縮めた写真の座標に直す', () => {
  assert.deepEqual(scaleBox({ x: 100, y: 50, w: 40, h: 20 }, 0.5), { x: 50, y: 25, w: 20, h: 10 });
});

test('書き出しの JSON: 写真のファイル名・日時・枠（スコアは入れない）・答え', () => {
  const entry: FeedbackEntry = {
    key: 'record:3', date: Date.UTC(2026, 9, 22, 3, 0, 0), photo: new ArrayBuffer(0), width: 1600, height: 1200,
    detections: [{ label: '四つ葉', bbox: { x: 1.234, y: 2, w: 3, h: 4 } }],
    answers: [{ kind: 'missed', bbox: { x: 10, y: 20, w: 144, h: 144 }, provisional: true, at: Date.UTC(2026, 9, 22, 3, 1, 0) }],
  };
  const json = exportJson([entry], i => `photos/${String(i + 1).padStart(4, '0')}.jpg`, new Date(Date.UTC(2026, 9, 23)));
  assert.equal(json.count, 1);
  assert.equal(json.items[0].photo, 'photos/0001.jpg');
  assert.equal(json.items[0].date, '2026-10-22T03:00:00.000Z');
  assert.deepEqual(json.items[0].detections, [{ label: '四つ葉', bbox: { x: 1.2, y: 2, w: 3, h: 4 } }]);
  assert.deepEqual(json.items[0].answers[0], { kind: 'missed', bbox: { x: 10, y: 20, w: 144, h: 144 }, provisional: true, at: '2026-10-22T03:01:00.000Z' });
  assert.ok(!JSON.stringify(json).includes('score'));
});
