// src/lib/diary-text.ts のテスト（日記カードに書く文）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diaryDate, diaryCountLine, cleanNote, noteLength, noteFits, wrapText, fileDate, mergeNote, fitNote, NOTE_MAX } from '../src/lib/diary-text.ts';

test('日付: 「2026年10月22日（木）」の形', () => {
  assert.equal(diaryDate(new Date(2026, 9, 22, 15, 30).getTime()), '2026年10月22日（木）');
  assert.equal(diaryDate(new Date(2027, 0, 3).getTime()), '2027年1月3日（日）');
});

test('ファイル名の日付: 端末の時計の日付（朝早くでも前の日にならない）', () => {
  assert.equal(fileDate(new Date(2026, 9, 23, 0, 30).getTime()), '2026-10-23');
  assert.equal(fileDate(new Date(2027, 0, 5, 23, 59).getTime()), '2027-01-05');
});

test('葉の数の文: 三つ葉と四つ葉', () => {
  assert.equal(diaryCountLine({ three: 47, four: 1 }), '三つ葉 47本のなかから 四つ葉を 1本 見つけた！');
  assert.equal(diaryCountLine({ three: 12, four: 3 }), '三つ葉 12本のなかから 四つ葉を 3本 見つけた！');
  assert.equal(diaryCountLine({ three: 0, four: 2 }), '四つ葉を 2本 見つけた！');
  assert.equal(diaryCountLine(undefined), '四つ葉を 見つけた！');
  assert.equal(diaryCountLine(undefined, 'camera'), '四つ葉を 見つけた！');
  assert.equal(diaryCountLine({ three: 5, four: 1 }, 'photo'), '三つ葉 5本のなかから 四つ葉を 1本 見つけた！');
});

test('今日のよつばの日記カード: 「今日のよつばが できた！」（「見つけた」と読める文にしない）', () => {
  assert.equal(diaryCountLine(undefined, 'gacha'), '今日のよつばが できた！');
  assert.equal(diaryCountLine({ three: 3, four: 1 }, 'gacha'), '今日のよつばが できた！'); // 数があっても
  assert.doesNotMatch(diaryCountLine(undefined, 'gacha'), /見つけ/);
});

test('ひとこと: 空白を整える。50 文字まで保存でき、長い文は切りつめない（前に保存した長いひとことを消さない）', () => {
  assert.equal(NOTE_MAX, 50);
  assert.equal(cleanNote('  こうえんで\n みつけた  '), 'こうえんで みつけた');
  assert.equal(cleanNote('あ'.repeat(80)), 'あ'.repeat(80)); // 切りつめない
  assert.equal(noteLength('🍀'.repeat(23)), 23);              // 絵文字も 1 文字（入力欄の「23/50」）
  assert.equal(noteFits('あ'.repeat(50)), true);
  assert.equal(noteFits('あ'.repeat(51)), false);
  assert.equal(noteFits('  ' + 'あ'.repeat(50) + '  '), true); // 前後の空白は数えない
});

test('メモとひとことをまとめる: 片方だけならそのまま、両方あれば「／」でつなげる（切りつめない）', () => {
  assert.equal(mergeNote(undefined, undefined), '');
  assert.equal(mergeNote('', '公園で'), '公園で');
  assert.equal(mergeNote('みつけた！', ''), 'みつけた！');
  assert.equal(mergeNote(' みつけた！ ', ' 公園で '), 'みつけた！ ／ 公園で');
  const long = 'あ'.repeat(100);
  assert.equal(mergeNote(long, 'い'), long + ' ／ い');
});

test('カードのひとこと: 2 行に収まる大きさを選び、収まらなければ「…」で終える', () => {
  const measureAt = (size: number) => (s: string) => [...s].length * size; // 1 文字 = 文字の大きさ
  // 20 文字は、大きい文字（10）で 1 行 10 文字 × 2 行に収まる
  assert.deepEqual(fitNote('あ'.repeat(20), 100, measureAt, [10, 5]), { size: 10, lines: ['あ'.repeat(10), 'あ'.repeat(10)] });
  // 30 文字は、小さい文字（5）にすると、1 行 20 文字 × 2 行に収まる
  assert.deepEqual(fitNote('い'.repeat(30), 100, measureAt, [10, 5]), { size: 5, lines: ['い'.repeat(20), 'い'.repeat(10)] });
  // 長い文（前に保存した 80 文字など）は収まらないので、2 行目の終わりを「…」にする
  const r = fitNote('う'.repeat(80), 100, measureAt, [10, 5]);
  assert.equal(r.size, 5);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[1], 'う'.repeat(19) + '…');
});

test('折り返し: 幅に収まるように行を分け、句読点は行の頭に来ない', () => {
  const measure = (s: string) => [...s].length * 10; // 1 文字 = 10px
  assert.deepEqual(wrapText('あいうえおかきくけこ', 50, measure), ['あいうえお', 'かきくけこ']);
  assert.deepEqual(wrapText('あいうえお。かきく', 50, measure), ['あいうえお。', 'かきく']);
  assert.deepEqual(wrapText('あ'.repeat(30), 50, measure, 2), ['あああああ', 'あああああ']); // 2 行まで
  assert.deepEqual(wrapText('', 50, measure), []);
});

test('葉の数の文を、空白のところで 2 行に分ける（長さがそろう所で）', async () => {
  const { splitAtSpace } = await import('../src/lib/diary-text.ts');
  const measure = (s: string) => [...s].length * 10;
  assert.deepEqual(splitAtSpace('四つ葉を 見つけた！', 200, measure), ['四つ葉を 見つけた！']);          // 収まる
  assert.deepEqual(splitAtSpace('三つ葉 10本のなかから 四つ葉を 3本 見つけた！', 150, measure),
    ['三つ葉 10本のなかから', '四つ葉を 3本 見つけた！']);
  assert.deepEqual(splitAtSpace('あいうえおかきくけこさしすせそ', 100, measure), ['あいうえおかきくけこさしすせそ']); // 空白が無い
});
