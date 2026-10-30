# CREDITS

YOTSUBA FINDER で使っているデータ・絵・モデル・フォントの出どころです。

検出モデルの学習と評価には、Roboflow Universe で公開されているデータセットを使っています（Roboflow から YOLOv8 形式で書き出し）。
下の URL は、それぞれの元の公開ページです（2026-10-30 に、写真の数とクラスの名前が、手元の書き出しと同じことを確かめた）。
ライセンスは、Roboflow から書き出したときに、データセットに付いていた設定のファイル（`data.yaml`。データセットといっしょに配られるもので、このリポジトリには入れていない）の表記です。データセットそのもの（写真とラベル）は、このリポジトリには入れていません。

CC BY 4.0（https://creativecommons.org/licenses/by/4.0/）のデータセットは、作者名・題名・元の URL・ライセンスを、ここに表示します。
変更したこと（すべてのデータセットに共通）: YOLOv8 形式で書き出し、クラスを four_leaf（四つ葉）と three_leaf（三つ葉）の 2 つにまとめた（`training/prepare_dataset.py`）。一部は、葉のまわりを切り出した「窓」にして学習に使った。

## 検出モデル（`public/models/yotsuba-v5mix.onnx`）の学習に使ったデータ

検出モデルは、Ultralytics の YOLO11n（`yolo11n.pt`）から、下の 3 つのデータセット（merged_core）で学習した v2 をもとに、iNaturalist の写真を足して学習した v3 と v4 の重みを混ぜたものです（下の「ソフトウェア・モデル」）。

- **rectangle_annotation**
  - 作者: university（Roboflow Universe）
  - URL: https://universe.roboflow.com/university-rqtzy/rectangle_annotation
  - ライセンス: CC BY 4.0
  - 写真 38 枚。クラス clover4 → four_leaf、clover3 → three_leaf
- **findclover**
  - 作者: Workspace1（Roboflow Universe）
  - URL: https://universe.roboflow.com/workspace1-d5rlr/findclover-swgym
  - ライセンス: Public Domain
  - 写真 913 枚。2 つのクラスとも four_leaf
- **Hunting for four-leaf clovers**
  - 作者: Adam Fonagy
  - URL: https://universe.roboflow.com/adam-fonagy/hunting-for-four-leaf-clovers
  - ライセンス: CC BY 4.0
  - 写真 486 枚。クラス clover-4 → four_leaf、clover-3 → three_leaf
- **iNaturalist の観察の写真**（カタバミ属・シロツメクサ。研究グレード）
  - 作者: 写真ごとの撮影者（200 人）。一覧は `CREDITS-inaturalist.csv`（写真の ID・観察の URL・撮影者・ライセンス・使い方）
  - URL: https://www.inaturalist.org/ （観察ごとの URL は、上の一覧）
  - ライセンス: CC0（写真ごとに確かめて、CC0 のものだけを使った）
  - 600 枚のうち 540 枚を、v3・v4 の学習に使った（四つ葉ではない葉の「窓」として）。残りの 60 枚は評価だけ
  - 集め方: `training/collect_inat_negatives.py`（iNaturalist の API・公式の公開データの置き場から。1 秒に 1 回まで）

## 評価だけに使ったデータ（学習には使っていない）

評価と、たしかさのめやす（●●● など）の境目を決めるのに使いました（`training/eval_hardneg.py`・`training/calibrate.py`）。アプリの中には、境目の数字だけが入り、写真は入りません。

- **Clover detection2**
  - 作者: Project1
  - URL: https://universe.roboflow.com/project1-graic/clover-detection2
  - ライセンス: `data.yaml` の表記は Public Domain（元のページでの表記は、確かめられなかった）
  - 写真 1,403 枚。merged_all の学習用には入るが、アプリの検出モデルの系統（v2・v3・v4・v5mix）は merged_core で学習しているので、学習には使っていない
- **Four-Leaf Clover Finder**
  - 作者: 不明（元の公開ページは、検索しても見つからなかった）
  - ライセンス: CC BY 4.0（`data.yaml` の表記）
  - 写真 68 枚。本物の四つ葉の検出率を測る写真のうち、正解 26 個がこのデータセット
- **three leaves**（三つ葉だけの写真）
  - 作者: clover detection（Roboflow Universe）
  - URL: https://universe.roboflow.com/clover-detection/three-leaves
  - ライセンス: CC BY 4.0
  - 写真 100 枚。三つ葉を四つ葉とまちがえる数を測る。枠がずれている・別の植物が混じるため、枠は使わない
- **iNaturalist の観察の写真**（上の 600 枚のうちの 60 枚。CC0）
- **カタバミの写真 5 枚**（作者の手元にだけある写真）
  - 作者・ライセンス: 不明（ネットで見つけた写真）
  - テストで数を測るだけ。学習にも、動画にも使わない。このリポジトリには入れていない

## 使っていないデータセット

- **Clover detection**
  - 作者: Project1
  - URL: https://universe.roboflow.com/project1-graic/clover-detection
  - ライセンス: CC BY 4.0
  - 使っていない（Clover detection2 と同じ写真のため）

## 今日のよつば（`gacha.html`）

- 形を作るモデル（`public/models/gacha-pretrain-fp32.onnx`）: 作者が、自分で書いた小さな DiT（`training/gacha_dit_src.py`）を、Colab で学習したもの。PyTorch（BSD-3-Clause）で学習し、ONNX に書き出した（`training/gacha_export_onnx.py`。書き出しの確かめに onnxruntime（MIT）・onnxconverter-common（MIT））
  - **学習データは、数式で作った形だけ**（`training/gacha_synth.py`。作者の自作の式。2,622 個）
- あらかじめ作った形 60 個（`public/gacha/`。モデルで作れないときに出す）: 同じ数式で作ったもの（`training/gacha_export.py`）
- 本物の四つ葉の写真: iNaturalist の観察の写真（CC0 のものだけ。写真ごとの撮影者・観察の URL・ライセンスは `CREDITS-inaturalist.csv`。写真そのものは、このリポジトリには入れていない）。**学習には使っていない**。写真から取り出した形（28 枚）の特徴を測って、数式の形の範囲を決めるため（と、学習の結果を比べる物差し）にだけ使った。アプリにも入れていない
  - 集め方: `training/collect_inat_fourleaf.py`（iNaturalist の API）・形の取り出し `training/gacha_masks.py`・`training/gacha_masks_fix.py`

## 画像（アプリの中の絵）

**イラスト：ChatGPT（OpenAI）で生成**

アプリの中のイラストは、人が描いたものではありません。ChatGPT（OpenAI）の画像生成で作り、作者が選んで使っています。

- チュートリアルの背景 4 枚（`assets-src/tutorial-1-welcome.png`〜`tutorial-4-diary.png` → `public/images/tutorial-*.webp`）
  - ChatGPT（OpenAI）の画像生成で作成（2026-10-26）
  - WebP への変換と大きさの調整だけをした（`scripts/make_images.py`）
- キャラクターの表情 4 枚（`assets-src/mascot-*.png` → `public/images/mascot/*.webp`）
  - ChatGPT（OpenAI）の画像生成で作成（2026-10-26）
  - 背景を透明にし、縁を整えて切り抜き、大きさをそろえて WebP にした（`scripts/make_mascots.py`。絵そのものは描き足していない）
- 公開の前に、作者が逆画像検索で、よく似た既存の絵が無いことを確かめた（2026-10-30）

## アイコンと、画面の中の図形

- アプリのアイコン（`public/icon-192.png`・`public/icon-512.png`・`public/apple-touch-icon.png`・`public/favicon.ico`・`public/favicon.svg`）
  - このアプリのために作ったもの。ホームのロゴと同じ四つ葉の図形（SVG のパス。`src/components/svg-defs.ts` の `#cH`）を、淡い緑の背景に置いた（`public/favicon.svg`）。PNG と ICO は、それを書き出したもの
- 画面の中の四つ葉・アイコンの図形: SVG のコードで描いたもの（`src/`）
- 今日のよつばの形 60 個（`public/gacha/`）: 数式で作ったもの（上の「今日のよつば」）

## ソフトウェア・モデル

- 検出モデル（`public/models/yotsuba-v5mix.onnx`。2026-10-27 から）: 作者が、Ultralytics の YOLO11n をもとに、上の「検出モデルの学習に使ったデータ」で学習した v3 と v4 の重みを混ぜたもの（v4 が 25%。`training/mix_models.py`。学習は Colab。`training/`）
  - Ultralytics（学習と ONNX への書き出しに使用）: AGPL-3.0（https://github.com/ultralytics/ultralytics）。そのため、このアプリも AGPL-3.0（LICENSE）
  - 事前学習の重み（yolo11n.pt）: Ultralytics。AGPL-3.0
- onnxruntime-web 1.30.0（ブラウザで推論。wasm も同梱）: MIT（https://github.com/microsoft/onnxruntime）
- そのほかの npm の依存: MIT・Apache-2.0・BSD-3-Clause・ISC・OFL-1.1。アプリと一緒に配る部品の一覧と、それぞれのライセンスの全文は、アプリの「このアプリについて」（設定から開く）の「使っている 部品の ライセンス」にある（onnxruntime-web は、wasm に入っている部品のライセンス（ThirdPartyNotices）も）
  - 一覧は `scripts/make-licenses.mjs` が、ビルドのときに `node_modules` から作る（`public/about/licenses.json`）。onnxruntime の ThirdPartyNotices は `scripts/third-party/` に写したもの
  - 開発用の Vite・TypeScript・Playwright は、配るものには入らない

## フォント

アプリに同梱し、自分のサイトから配っています（外部への通信はしません）。

| フォント | 使う場所 | パッケージ（版は固定） | ライセンス |
|---|---|---|---|
| Zen Maru Gothic（作者: The Zen Maru Gothic Authors・Yoshimichi Ohira。https://github.com/googlefonts/zen-marugothic） | 画面の文字すべて（チュートリアルも。500・700） | @fontsource/zen-maru-gothic 5.3.0 を元に、アプリの固定の文字だけに減らして `public/fonts/` に置いたもの（scripts/make_fonts.py） | SIL Open Font License 1.1（文書: `public/fonts/OFL-zen-maru-gothic.txt`） |
| Nunito（Copyright 2014 The Nunito Project Authors。https://github.com/googlefonts/nunito） | 画面の数字・英字、日記カードのスタンプ | @fontsource/nunito 5.3.0 | SIL Open Font License 1.1（文書: `public/fonts/OFL-nunito.txt`） |
| Klee One（Fontworks。Copyright 2020 The Klee Project Authors。https://github.com/fontworks-fonts/Klee） | 日記カードの中の文字と、初めて開いたときの説明（チュートリアル） | @fontsource/klee-one 5.3.1 | SIL Open Font License 1.1（文書: `public/fonts/OFL-klee-one.txt`） |

### Klee One を選んだ理由

- 鉛筆で書いたような、やわらかい手書きの形で、ひらがなが読みやすい（小さな子でも読める）
- 日本語を文字の範囲ごとに分けた版（unicode-range 付きの woff2）があり、カードに書く文字を含むファイルだけが読み込まれる
- canvas に描いても形が崩れない（候補の Yomogi と、同じ文で描いて比べた）
- 太さは 400（普通）と 600（やや太い）の 2 種類だけを使う

### 大きさ

| | Klee One 400 | Klee One 600 | （比較）Yomogi 400 |
|---|---|---|---|
| 分割されたファイルの数 | 121 | 121 | 120 |
| いちばん大きいファイル | 55KB | 59KB | 32KB |
| 全部の合計（ディスク上） | 3,252KB | 3,389KB | 2,080KB |
| 1 枚のカードで実際に読み込んだ分（例） | 8 ファイル・約 170KB | 8 ファイル・約 175KB | 8 ファイル・約 130KB |

オフラインでもカードを作れるように、ホームの画面が出たあと、手の空いたときに、日付・曜日・葉の数の文の文字と、ひらがな・カタカナ・数字・英字を含むファイルを先読みします（`src/lib/diary-fonts-prefetch.ts`）。読み込んだファイルは、サービスワーカーがキャッシュに入れます。データ節約の設定がオンのときは先読みしません。ひとことの漢字のファイルは、カードを作るときに、その場で必要な分だけを読み込みます。
