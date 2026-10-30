# YOTSUBA FINDER

スマートフォンのカメラや写真から、四つ葉のクローバーを探すアプリです。ブラウザで開くだけで使えます。

**アプリ: https://yotsuba-finder.vercel.app/**

## できること

- **カメラや写真から四つ葉を探す**: カメラを草むらに向けると、四つ葉の候補を金色の枠で知らせます。撮った写真から探すこともできます。
- **群生地をまとめて探す**: クローバーが一面に生えた場所を1枚撮れば、写真の全体と、写真を4つに分けた部分の両方を調べて、まとめて探します。三つ葉の本数も数えます。
- **自分の目で確かめて、図鑑に入れる**: 見つかった候補を1つずつ大きく見せるので、本当に四つ葉かを自分で確かめて「図鑑に入れる」か「入れない」を選びます。AIのたしかさの目安は、●●●・●●○・●○○の3段階で示します（数字やパーセントは出しません）。
- **図鑑・日記カード・レベル**: 見つけた四つ葉は図鑑に残り、ひとことや手書きを添えた日記カードを作れます。見つけるとレベルが上がり、バッジがもらえます。
- **今日のよつば**: 1日に1回、端末の中の小さなAIが、その日だけの四つ葉の形を作ります。

## 使い方

1. iPhoneならSafariで https://yotsuba-finder.vercel.app/ を開きます（Androidやパソコンのブラウザでも動きます）。
2. 共有ボタンから「ホーム画面に追加」を選ぶと、アプリのように使えます。初めて開いたときの説明の最後にも、手順が出ます。
3. 初めて使うときだけ、電波のある場所で開いてください。アプリと、四つ葉を見つけるAI（検出のモデル）が端末に入ります。検出のモデルは「写真から探す」かカメラを初めて開いたときに、今日のよつばのモデルは、そのあと背景で入ります。
4. 一度入れば、そのあとは電波のない公園や野原でも、オフラインで使えます。

## プライバシー

- 写真は端末の外に出ません。四つ葉を見つける処理は、すべて端末のブラウザの中で行います。
- 外部のAIサービスやAPIは使いません。アプリとモデルを、このアプリのサイトから取るほかは、通信しません（自動のテストで、外部への通信が0件であることを確かめています）。
- 図鑑・日記・レベル・設定は、その端末のブラウザの中にだけ保存します。設定の「すべてのデータを消す」で、いつでも消せます。
- 設定の「書き出しと読み込み」で、データを1つのファイルにして手元に保存できます。ファイルを外に出すのは、使う人がボタンを押したときだけです。

## しくみ

- **検出のモデル**: Ultralytics の YOLO11n をもとに、四つ葉と三つ葉を見分けるように自分で学習しました。学習には、Roboflow Universe で公開されているクローバーのデータセットと、iNaturalist の CC0 の写真（カタバミやシロツメクサ。四つ葉とまちがえやすい葉）を使いました。学習の詳細は [training/](training/README.md) を参照してください。
- **ブラウザの中で動かす**: モデルを ONNX 形式にして、onnxruntime-web で、ブラウザの中（Web Worker）で動かします。モデルや実行に必要なファイルも、すべてこのアプリのサイトから配ります。
- **カメラは WASM、写真は WebGPU**: iPhone の Safari で、カメラの検出に WebGPU を使うと、約10秒で強制終了しました。WASM では211秒（推論180回）続けても止まらなかったので、カメラはどの端末でも WASM で動かします。写真から探すは、同じ写真で10回続けても落ちなかったので、速い WebGPU を使い、使えないときは WASM にします。
- **今日のよつば**: 自分で書いた小さな DiT（画像を作るAIの一種。約420万パラメータ・64×64）を使います。このモデルは、数式で作った四つ葉の形（2,622個）だけで学習しました。本物の四つ葉の写真は学習には使わず、数式で作る形の範囲を決めるための測定にだけ使いました。形は日付と端末ごとの値から決まり、端末どうしは通信しません。モデルが使えないときは、あらかじめ数式で作った60個の形から1つを出します。
- **画面**: Vite と TypeScript で、フレームワークを使わずに作りました。オフラインでは Service Worker のキャッシュを使います。

## 精度と限界

- 学習に使っていない写真157枚に写った、本物の四つ葉199個のうち、126個（約63%）を見つけました（写真から探すと同じ処理で測定）。3個に1個は見落とします。
- ぼやけた写真や、小さく写った葉は苦手です。見落とした四つ葉を調べると、ぼやけた写真の四つ葉の64%、小さく写った四つ葉の36%を見落としていました。
- 四つ葉ではないものを、四つ葉の候補として出すこともあります。三つ葉だけが写った写真100枚では、四つ葉の候補が30個出ました。大きくはっきり写った三つ葉の葉や、三つ葉が一面に密集した場面で起きやすいです。最後は、使う人が目で確かめて選ぶ前提です。
- たしかさの目安（●●●など）は確率の保証ではなく、測定に使った写真での目安です。
- 「ミスも含めて育てる」でできるのは、**その端末の中で、候補を出すしきい値を少し調整することだけ**です。「入れない」を選んだ内容を、学習データに戻してモデルを学習し直す機能はありません。

## 開発者向け

### 必要なもの

- Node.js 20以上と npm
- e2e テストには、Playwright の Chromium（`npx playwright install chromium`）
- Python 3（学習とフォントの作り直し、Python のテストのときだけ。テストには numpy・opencv-python・Pillow が要ります）

### インストール・ビルド・テスト

```bash
npm ci
npm run dev        # 開発用のサーバー（https://localhost:5173/。スマホからは https://<PCのIP>:5173/）
npm run build      # 型チェックのあと、dist/ に出力（onnxruntime-web の wasm のコピーと、ライセンスの一覧も作ります）
npm run preview    # ビルドしたものを確認（Service Worker も動きます）

npm test           # 単体テスト
npm run test:e2e   # e2e テスト（先に npm run build。外部への通信0件・オフラインで動くことなどを確かめます）
python -m unittest discover -s training/tests   # Python のテスト

# 本番と同じ設定のビルドで、診断用のコードが入っていないことを確かめる
VERCEL_ENV=production npm run build && npm run check:no-diag && npm run check:no-debug && node tests-e2e/prod-no-diag.mjs
```

- 開発中は、URL に `?detector=dummy` を付けると、ダミーの検出器に切り替えられます。

### フォルダ

- `*.html`・`src/`: 画面と、アプリの処理（`src/pages/` が画面ごと、`src/lib/` が処理、`src/components/` が部品）
- `public/`: モデル・フォント・絵・アイコン（そのまま配る）
- `sw/`: Service Worker のひな形（ビルドのときに、キャッシュするファイルの一覧を書き込みます）
- `scripts/`: ビルドの前処理と確認のスクリプト
- `tests/`・`tests-e2e/`: 単体テストと、ブラウザを使うテスト
- `training/`: モデルの学習と評価のスクリプト（説明は [training/README.md](training/README.md)）

## ライセンスとクレジット

- このアプリのソースコードは、GNU Affero General Public License v3.0（AGPL-3.0）で公開しています（[LICENSE](LICENSE)）。検出のモデルの学習と書き出しに、AGPL-3.0 の Ultralytics を使っているためです。
- 学習に使ったデータセット、フォント、絵の出どころとライセンスは [CREDITS.md](CREDITS.md) にまとめています。アプリと一緒に配る部品のライセンスは、アプリの「このアプリについて」（設定から開く）で見られます。
- アプリの中のイラスト（初めて開いたときの説明の背景とキャラクター）は、ChatGPT（OpenAI）で生成したものです。

## English summary

YOTSUBA FINDER is a web app that finds four-leaf clovers with your phone's camera or in your photos. Open https://yotsuba-finder.vercel.app/ in a browser to use it.

- **What it does**: It finds four-leaf candidates live through the camera, or in a photo. One photo of a whole clover patch is checked both as a whole and in four parts, so a patch can be searched at once. You check each candidate with your own eyes and choose whether to keep it. Kept clovers go into a collection, and you can make diary cards and level up. "Today's clover" makes one new four-leaf shape a day with a small AI on your device.
- **How to use it**: Open it in Safari on iPhone and choose "Add to Home Screen". The first time, open it where there is a network connection so the app and the models are saved on the device. After that it works offline.
- **Privacy**: Photos never leave the device. All detection runs inside the browser. It uses no external AI services or APIs, and it makes no network requests other than loading the app and models from its own site.
- **How it works**: The detector is a YOLO11n model that we trained ourselves on public clover datasets from Roboflow Universe and CC0 photos from iNaturalist. It runs in the browser with onnxruntime-web. The camera uses WASM, because WebGPU made iPhone Safari crash after about 10 seconds of camera use. Photos use WebGPU, falling back to WASM. "Today's clover" uses a small DiT trained only on shapes generated from math formulas, not on real clover photos.
- **Accuracy and limits**: On photos not used for training, it found 126 of 199 real four-leaf clovers (about 63%), so it misses about one in three. It is weak on blurry photos and small leaves, and it also shows some false candidates (30 on 100 photos with only three-leaf clovers). "Learning from mistakes" only adjusts a detection threshold on your device; your answers are not used to retrain the model.
