// 初めて開いたときの説明（src/lib/tutorial.ts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUTORIAL_IMAGES, fitBackground, markTutorialSeen, shouldShowTutorial, type SeenStore, homeScreenGuide } from '../src/lib/tutorial.ts';

const memory = (): SeenStore & { seen: boolean } => {
  const s = { seen: false, get: async () => s.seen, set: async () => { s.seen = true; } };
  return s;
};
const broken = (): SeenStore => ({ get: async () => { throw new Error('使えない'); }, set: async () => { throw new Error('使えない'); } });

test('初めてのときだけ出す: 見た（はじめる）あとは、次に開いても出さない', async () => {
  const local = memory(), idb = memory();
  assert.equal(await shouldShowTutorial([local, idb], { shown: false }), true);
  await markTutorialSeen([local, idb], { shown: false });
  assert.equal(await shouldShowTutorial([local, idb], { shown: false }), false); // 次に開いたとき
});

test('スキップも「見た」になる。片方の印だけ残っていても出さない', async () => {
  const local = memory(), idb = memory();
  await markTutorialSeen([local, idb], { shown: false });
  local.seen = false; // localStorage が消された
  assert.equal(await shouldShowTutorial([local, idb], { shown: false }), false);
});

test('印を残せない端末: その回だけ出さない（次に開くと、また出る）', async () => {
  const stores = [broken(), broken()];
  const session = { shown: false };
  assert.equal(await shouldShowTutorial(stores, session), true);
  assert.equal(await markTutorialSeen(stores, session), false);
  assert.equal(await shouldShowTutorial(stores, session), false);
  assert.equal(await shouldShowTutorial(stores, { shown: false }), true);
});

test('設定から、もういちど見る: 印があっても、開けば出る（出すかどうかの判定を通さない）。きろくのリセットとは別', async () => {
  // 設定の「つかいかたを、もういちど見る」は shouldShowTutorial を通さずに開く。開いたあとも印は残る
  const local = memory();
  await markTutorialSeen([local], { shown: false });
  assert.equal(local.seen, true);
  await markTutorialSeen([local], { shown: false }); // もういちど見て、閉じた
  assert.equal(await shouldShowTutorial([local], { shown: false }), false);
});

test('背景の置き方: 390×844 では、どの画像も、顔が見出しとカードのあいだにあり、端のキャラクターも切れない', () => {
  for (const img of TUTORIAL_IMAGES) {
    const f = fitBackground(390, 844, img, 150, 844 - 0.4 * 844);
    assert.equal(f.faceVisible, true);
    assert.ok(f.sideCut < 0.5);
    assert.ok(f.y <= 0 && f.y + img.height * f.scale >= 844 - 0.01); // すき間がない
  }
});

test('背景の置き方: 小さい画面（320×568）でも、顔は見える', () => {
  for (const img of TUTORIAL_IMAGES) {
    const f = fitBackground(320, 568, img, 110, 568 - 0.5 * 568);
    assert.equal(f.faceVisible, true, img.src);
  }
});

test('背景の置き方: カードが大きく、顔が隠れるときは、少し大きくして顔を上げる（すき間はつくらない）', () => {
  for (const img of TUTORIAL_IMAGES) {
    const f = fitBackground(320, 568, img, 107, 196);
    assert.equal(f.faceVisible, true, img.src);
    assert.ok(f.y + img.height * f.scale >= 568 - 0.01);
    assert.ok(f.scale <= Math.max(320 / img.width, 568 / img.height) * 1.6 + 1e-9);
  }
});

test('「ホーム画面に追加」の案内: ホーム画面から開いたときは出さない。iPhone の Safari は手順、ほかは Safari で開く案内', () => {
  const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
  const LINE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.0';
  const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  const g = (userAgent: string, standalone = false, maxTouchPoints = 5) => homeScreenGuide({ userAgent, standalone, maxTouchPoints });
  assert.equal(g(SAFARI), 'ios-safari');
  assert.equal(g(SAFARI, true), 'none');
  assert.equal(g(ANDROID, true), 'none');
  assert.equal(g(CHROME_IOS), 'ios-other');
  assert.equal(g(LINE), 'ios-other');
  assert.equal(g(IPAD), 'ios-safari');
  assert.equal(g(IPAD, false, 0), 'other'); // さわれない画面の Mac
  assert.equal(g(ANDROID), 'other');
});
