// src/lib/backup.ts のテスト（データの書き出しと読み込み: 形の確かめ・何を書くか）
// 実行方法: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_SCHEMA, backupFileName, backupText, base64ToBuffer, bufferToBase64, buildBackup, parseBackup, planImport, remapFeedbackKey, sizeLabel,
  type BackupSource,
} from '../src/lib/backup.ts';

const PHOTO = 'data:image/jpeg;base64,AAAA';
const GACHA = 'data:image/png;base64,BBBB';

// 図鑑の写真（records）と、今日のよつばの一覧（gacha。DB の版 5 から別の入れ物）
const source = (): BackupSource => ({
  records: [
    { id: 1, date: 1000, imageDataUrl: PHOTO, label: '四つ葉', source: 'photo', counts: { three: 5, four: 1 }, note: 'こうえん', detections: [{ label: '四つ葉', score: 0.9, bbox: { x: 1, y: 2, w: 3, h: 4 } }] },
    { id: 3, date: 3000, imageDataUrl: PHOTO, label: '四つ葉', source: 'camera', ink: { strokes: [], stickers: [] } as never },
  ],
  gacha: [
    { id: 2, date: 2000, imageDataUrl: GACHA, label: '四つ葉', source: 'gacha', gachaDay: '2026-10-29', gachaKind: 'dit', note: 'かたち', shape64: 'data:image/png;base64,SS' },
  ],
  feedback: [
    { key: 'record:1', date: 1500, photo: new Uint8Array([1, 2, 3, 250]).buffer, width: 10, height: 20, detections: [], answers: [] },
    { key: 'photo:99', date: 1600, photo: new Uint8Array([9]).buffer, width: 1, height: 1, detections: [], answers: [] },
  ],
  progress: { id: 'me', leaves: 6, fours: 2, diaryCards: 1, xp: 236, badges: [], photoHashes: ['h'], photoFourXp: { h: 1 }, diaryRecordIds: [1], wroteNote: true, drewInk: false },
  tuning: { id: 'tuning', enabled: true, choices: [{ score: 0.5, keep: true, at: 1 }], model: '/models/yotsuba-v5mix.onnx' },
  settings: { saveMode: 'auto' },
});

const exported = (withPhotos = true) => buildBackup(source(), { withPhotos, now: 5000, appVersion: '0.9.6' });
const roundTrip = (withPhotos = true) => {
  const text = backupText(exported(withPhotos));
  const r = parseBackup(text, text.length);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.data;
};

test('base64: 写真のバイトが、そのまま戻る', () => {
  const buf = new Uint8Array(70_000).map((_, i) => (i * 7) % 256).buffer;
  assert.deepEqual(new Uint8Array(base64ToBuffer(bufferToBase64(buf))), new Uint8Array(buf));
});

test('書き出し → 読み込み（上書き）: 図鑑・日記・まちがいの記録・きろく・調整・設定が、同じに戻る', () => {
  const data = roundTrip();
  assert.equal(data.schemaVersion, BACKUP_SCHEMA);
  const plan = planImport(data, 'replace', [], []);
  const src = source();
  assert.deepEqual(plan.records.map(r => r.record), src.records); // id・ひとこと・手書き・枠・本数もそのまま
  assert.deepEqual(plan.gacha.map(r => r.record), src.gacha);     // 今日のよつばも、id・ひとこと・形のまま
  assert.deepEqual(plan.progress, src.progress);
  assert.deepEqual(plan.tuning, src.tuning);
  assert.deepEqual(plan.settings, { saveMode: 'auto' });
  assert.deepEqual(plan.feedback.map(f => [f.key, [...new Uint8Array(base64ToBuffer(f.photo))]]), [['record:1', [1, 2, 3, 250]], ['photo:99', [9]]]);
});

test('入れないもの: 今日のよつばの端末ごとの値・今日の形・最後に調べた写真・チュートリアルの印', () => {
  const text = backupText(exported());
  for (const word of ['gachaDevice', 'gachaToday', 'lastPhoto', 'tutorial']) assert.ok(!text.includes(word), word);
  for (const word of ['gachaMove', 'reserved']) assert.ok(!text.includes(word), word); // 版 5 へ上げたときの元の値・番号を取るための仮の記録
  assert.deepEqual(Object.keys(exported()).sort(), ['app', 'appVersion', 'exportedAt', 'feedback', 'gacha', 'progress', 'records', 'schemaVersion', 'settings', 'tuning', 'withPhotos']);
});

test('写真なし: 写真の記録は写真を入れず、まちがいの記録も入れない。今日のよつばの絵は入れる。読み込むと、写真の代わりの目印', () => {
  const data = roundTrip(false);
  assert.equal(data.withPhotos, false);
  assert.deepEqual(data.records.map(r => r.imageDataUrl), ['', '']);
  assert.deepEqual(data.gacha.map(r => r.imageDataUrl), [GACHA]);
  assert.deepEqual(data.feedback, []);
  const plan = planImport(data, 'replace', [], []);
  assert.deepEqual(plan.records.map(r => r.record.photoMissing ?? false), [true, true]);
  assert.equal(plan.gacha[0].record.photoMissing, undefined);
  assert.deepEqual(plan.records[0].record.detections, []); // 写真が無いので、枠は使わない
  assert.equal(plan.records[0].record.note, 'こうえん');    // ひとことは残る
  assert.ok(backupText(exported(false)).length < backupText(exported(true)).length);
});

test('足す: 同じ記録は足さない。id は付け直し、まちがいの記録の名前も直す。きろく・調整・設定は今のまま', () => {
  const data = roundTrip();
  const plan = planImport(data, 'add', [{ date: 1000, source: 'photo', label: '四つ葉' }], ['photo:99']);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.records.map(r => [r.oldId, r.record.date, 'id' in r.record]), [[3, 3000, false]]);
  assert.deepEqual(plan.gacha.map(r => [r.record.date, 'id' in r.record]), [[2000, false]]); // id は、足すときに付け直す
  // 今ある今日のよつばと同じものは、足さない
  const again = planImport(data, 'add', [{ date: 2000, source: 'gacha', label: '四つ葉', gachaDay: '2026-10-29' }], []);
  assert.deepEqual([again.gacha.length, again.skipped], [0, 1]);
  assert.deepEqual(plan.feedback.map(f => f.key), ['record:1']); // photo:99 は、もうある
  assert.equal(plan.progress, 'keep');
  assert.equal(plan.tuning, 'keep');
  assert.equal(plan.settings, 'keep');
  // 記録 1 は足さなかったので、その記録のまちがいの記録も足さない
  assert.equal(remapFeedbackKey('record:1', new Map([[2, 10], [3, 11]]), 'add'), null);
  assert.equal(remapFeedbackKey('record:3', new Map([[2, 10], [3, 11]]), 'add'), 'record:11');
  assert.equal(remapFeedbackKey('photo:99', new Map(), 'add'), 'photo:99');
  assert.equal(remapFeedbackKey('record:1', new Map(), 'replace'), 'record:1');
});

test('こわれたファイル・ちがうファイル・新しすぎる版・大きすぎる: はっきりしたエラー（何も書かない）', () => {
  const good = exported();
  const check = (text: string, re: RegExp, bytes = text.length) => {
    const r = parseBackup(text, bytes);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, re);
  };
  check('{"app":"yotsuba-fin', /こわれている/);
  check('[]', /このアプリで 書き出した/);
  check(JSON.stringify({ ...good, app: 'other' }), /このアプリで 書き出した/);
  check(JSON.stringify({ ...good, schemaVersion: BACKUP_SCHEMA + 1 }), /新しい アプリ/);
  check(JSON.stringify({ ...good, schemaVersion: 0 }), /こわれています/);
  check(JSON.stringify({ ...good, records: [{ ...good.records[0], label: 'x' }] }), /図鑑/);
  check(JSON.stringify({ ...good, records: [{ ...good.records[0], imageDataUrl: 'https://example.com/a.jpg' }] }), /図鑑/); // 外の URL は読まない
  check(JSON.stringify({ ...good, records: [good.records[0], good.records[0]] }), /図鑑/); // 同じ id が 2 つ
  check(JSON.stringify({ ...good, feedback: [{ ...good.feedback[0], photo: '***' }] }), /写真/);
  check(JSON.stringify({ ...good, progress: { xp: 'a' } }), /きろく/);
  // 今日のよつば（版 2）: 無い・形がちがう・写真が入っている・図鑑の記録と id が重なる・形の絵が外の URL
  const { gacha: _g, ...noGacha } = good;
  check(JSON.stringify(noGacha), /今日のよつば/);
  check(JSON.stringify({ ...good, gacha: [{ ...good.gacha[0], label: 'x' }] }), /今日のよつば/);
  check(JSON.stringify({ ...good, gacha: [{ ...good.gacha[0], source: 'photo' }] }), /今日のよつば/);
  check(JSON.stringify({ ...good, gacha: [{ ...good.gacha[0], id: 1 }] }), /図鑑/);
  check(JSON.stringify({ ...good, gacha: [{ ...good.gacha[0], shape64: 'https://example.com/a.png' }] }), /今日のよつば/);
  check('{}', /大きすぎ/, 2 * 1024 * 1024 * 1024);
});

test('ファイル名と大きさの出し方', () => {
  assert.equal(backupFileName('2026-10-30'), 'yotsuba-backup-2026-10-30.json');
  assert.equal(sizeLabel(300 * 1024), '1MB より 小さい');
  assert.equal(sizeLabel(52.4 * 1024 * 1024), '約 52MB');
});

// 版 1 のファイル（DB の版 5 より前の書き出し）: 今日のよつばも records に入っていて、gacha は無い
const v1File = () => {
  const src = source();
  const { gacha: _g, ...rest } = buildBackup(src, { withPhotos: true, now: 5000, appVersion: '0.9.6' });
  return { ...rest, schemaVersion: 1, records: [src.records[0], { ...src.gacha[0], shape64: undefined }, src.records[1]].map(r => JSON.parse(JSON.stringify(r))) };
};

test('版 1 のファイルも読める: records の中の今日のよつばを、今日のよつばの一覧に分ける（上書き・足す）', () => {
  const text = JSON.stringify(v1File());
  const r = parseBackup(text, text.length);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.data.records.map(x => x.id), [1, 3]);
  assert.deepEqual(r.data.gacha.map(x => [x.id, x.source, x.note]), [[2, 'gacha', 'かたち']]);
  const replace = planImport(r.data, 'replace', [], []);
  assert.deepEqual(replace.records.map(x => x.record.id), [1, 3]);
  assert.deepEqual(replace.gacha.map(x => x.record.id), [2]);
  assert.deepEqual(replace.progress, source().progress); // 日記カードの経験値の記録（diaryRecordIds）も、そのまま
  const add = planImport(r.data, 'add', [], []);
  assert.deepEqual([add.records.length, add.gacha.length, add.skipped], [2, 1, 0]);
});

test('版 1 のファイル: こわれていれば、はっきりしたエラー（何も書かない）', () => {
  const bad = { ...v1File(), records: [{ ...v1File().records[1], source: 'other' }] };
  const t = JSON.stringify(bad);
  const r = parseBackup(t, t.length);
  assert.equal(r.ok, false);
});

test('版 2 の往復: 書き出す → 読み込むと、図鑑と今日のよつばが、それぞれの一覧に、同じに戻る', () => {
  const data = roundTrip();
  assert.equal(data.schemaVersion, 2);
  assert.deepEqual(data.records, source().records);
  assert.deepEqual(data.gacha, source().gacha);
  // 図鑑の入れ物に移せずに残った今日のよつばがあっても、書き出しでは今日のよつばの一覧に入れる
  const src = source();
  const mixed = buildBackup({ ...src, records: [...src.records, { id: 9, date: 9000, imageDataUrl: GACHA, label: '四つ葉', source: 'gacha', gachaDay: '2026-10-20' }] },
    { withPhotos: true, now: 1, appVersion: 'x' });
  assert.deepEqual(mixed.records.map(r => r.id), [1, 3]);
  assert.deepEqual(mixed.gacha.map(r => r.id), [2, 9]);
});
