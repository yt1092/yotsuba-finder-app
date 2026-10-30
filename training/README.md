# training — 四つ葉検出モデルの学習

YOTSUBA FINDER で使う検出モデル（ONNX）を、Google Colab で学習して作るためのフォルダです。

| ファイル | 役割 | 実行する場所 |
|---|---|---|
| `prepare_dataset.py` | `data/public` のデータセットをまとめて、`data/merged_core/`・`data/merged_all/` と、それぞれの zip を作る | 自分のパソコン |
| `train_yotsuba.ipynb` | 学習・評価・ONNX への書き出し | Google Colab |
| `predict_photos.ipynb` | 自分で撮った写真（`MyDrive/yotsuba/own_photos/`）で、全体検出とタイル検出を比べる。結果を Roboflow 用の YOLO txt でも保存する | Google Colab |

クラスは `0 = four_leaf`（四つ葉）、`1 = three_leaf`（三つ葉）です。

---

## Colab での実行手順

### 1. 学習データを用意する（パソコン）

```bash
python training/prepare_dataset.py
```

次の 2 つの zip ができます（valid は両方とも同じなので、成績をそのまま比べられます）。

| zip | 中身 | 大きさ |
|---|---|---|
| `data/merged_core.zip` | findclover・rectangle_annotation・hunting-four-leaf | 約 320 MB |
| `data/merged_all.zip` | core ＋ clover-detection2（train だけに入る） | 約 490 MB |

このスクリプトは、見た目が似ている写真（水増しの兄弟や同じ元の写真）をグループにまとめ、グループ単位で train と valid に分けます。最後に「train と valid に同じグループがまたがっていないか」を検査し、合格したときだけ zip を作ります。どの写真をどこに入れたかは `data/merged_manifest.csv` に残ります。

### 2. Google ドライブに置く

ドライブの「マイドライブ」に `yotsuba` フォルダを作り、使う方の zip（`merged_core.zip` か `merged_all.zip`）をアップロードします。ノートブックのセクション 3 の `DATASET_ZIP` で、どちらを使うかを選びます。

```
マイドライブ/
└── yotsuba/
    ├── merged_core.zip ← 自分でアップロードする（merged_all.zip も同じ場所に）
    ├── runs/                   ← 学習の結果（実行名ごとのフォルダ。ノートブックが自動で作る）
    └── yotsuba_<RUN_TAG>.onnx  ← 書き出したモデル（例: yotsuba_scale09.onnx。前のものは上書きしない）
```

### 3. ノートブックを開く

[Google Colab](https://colab.research.google.com/) を開き、「ファイル」→「ノートブックをアップロード」で `training/train_yotsuba.ipynb` を選びます。
（GitHub の非公開リポジトリから開く場合は、「GitHub」タブで「非公開リポジトリを含める」にチェックを入れ、GitHub へのアクセスを許可します）

### 4. GPU を選ぶ

「ランタイム」→「ランタイムのタイプを変更」→「ハードウェア アクセラレータ」で GPU を選んで保存します。

| GPU | 目安 | 備考 |
|---|---|---|
| **T4** | merged_core で 2〜3 時間、merged_all で 4〜5 時間（見込み） | 無料版で使える。まずはこれで十分 |
| L4 | T4 の半分ほど | 有料プラン（Colab Pro など） |
| A100 | さらに速い | 有料プラン。コンピューティング ユニットの消費が多い |

時間はあくまで目安です。成績が伸びなくなると（`patience=30`）、100 周より前に自動で打ち切られます。

### 5. 上から順に実行する

「ランタイム」→「すべてのセルを実行」でも、1 セルずつ実行（Shift + Enter）でもかまいません。
途中でドライブへのアクセスの許可と、最後に ONNX（`yotsuba_<RUN_TAG>.onnx`）のダウンロードの確認が出ます。

**学習し直すとき**は、セクション 3 の `RUN_TAG` を新しい名前に変え、`PREV_BEST` に比べる相手（前のモデル）の `best.pt` を指定してください。前の学習結果と ONNX は上書きされません。

**注意**
- 無料版は、しばらく操作しないと接続が切れます。学習中はタブを開いたままにしてください
- 接続が切れても、学習の途中経過はドライブの `runs/` に残っています。**セクション 1〜4 を実行し直し、学習のセルの代わりにセクション 5-2 の再開のセルを実行**すると、続きから学習できます

---

## ノートブックの各セクション

| セクション | 内容 |
|---|---|
| 1. GPU の確認 | `nvidia-smi` で GPU が使えるかを確認する |
| 2. ライブラリのインストール | `ultralytics`（YOLO）と `onnxruntime`（ONNX の動作確認用）を入れる |
| 3. Google ドライブの接続 | ドライブをつなぎ、保存場所・モデル名・画像サイズ・使う学習データ（`DATASET_ZIP`）・今回の実行名（`RUN_TAG`）・比べる相手（`PREV_BEST`）を設定する。`merged.zip` があるかを確かめる |
| 4. 学習データの展開 | zip を Colab のローカルに展開し、`path:` を書き込んだ `data_colab.yaml` を作る。枚数と枠の数を表示する |
| 5. 学習 | `yolo11n.pt`（事前学習済みの nano モデル）から学習する。`imgsz=960`、`epochs=80`、`batch=16`、`patience=25`、上下反転 `flipud=0.5`、回転 `degrees=15`、拡大縮小 `scale=0.9`、位置のずらし `translate=0.2`、`close_mosaic=15`。結果は `runs/<RUN_NAME>/` に保存する |
| 5-1. 今回の変更点と理由 | 「葉の大きさで三つ葉と四つ葉を決めてしまう癖」を弱めるために、`scale`・`translate`・`close_mosaic` を変えた理由 |
| 5-2. 途中で切れたとき（再開のセル） | セクション 1〜4 を実行し直したあと、学習のセルの代わりにこのセルを実行すると、ドライブに残った `last.pt` から続きを学習する（`resume=True`）。途中経過がないときや、もう終わっているときは、そう表示するだけ |
| 6. 学習の経過 | `results.png`（損失と mAP の推移）を表示し、グラフの読み方を説明する |
| 7. 成績と混同行列 | `best.pt` で valid を評価し、クラスごとの適合率・再現率・mAP50 の表と、混同行列を表示する |
| 7-3. 前のモデルと比べる | 前のモデル（`PREV_BEST`）と今回のモデルを同じ valid で評価し、クラスごとの適合率・再現率・mAP50 と、三つ葉を四つ葉と間違えた数を並べる |
| 8. 目で確認 | valid からランダムに 10 枚選び、検出結果の枠を描いて表示する |
| 9. ONNX に書き出す | `imgsz=960`、`opset=12`、`simplify=True`、入力サイズ固定で書き出し、ドライブに `yotsuba_<RUN_TAG>.onnx` として保存する。出力の形を表示し、パソコンにダウンロードする |
| 10. おわりに | できたファイルの場所の一覧 |

## モデルについて

- **`yolo11n` を選んだ理由**：nano はいちばん小さいサイズで、スマホのブラウザでも動かしやすいです。YOLO11 は ONNX の出力の形（`(1, 6, 18900)`）がよく知られていて、アプリ側の処理を書きやすいです。
- 別のモデルを試すときは、セクション 3 の `MODEL_NAME` を書き換えます。ただし、モデルの種類によって ONNX の出力の形が変わることがあり、そのときはアプリ側の処理も合わせて直す必要があります。

## できたモデルの使い道

書き出した ONNX は、**版を上げた名前**（例: `yotsuba-v4.onnx`）にしてアプリの `public/models/` に置き、`src/lib/detector-config.ts` の `MODEL_URL` を直します。同じ名前のまま入れ替えると、キャッシュに残った古いモデルが使われ続けます。
アプリでは、モデルが出すスコアはしきい値として内部で使うだけで、画面には表示しません（CLAUDE.md のルール）。

---

## 再学習用の「四つ葉がない」写真（hardneg）

モデルは、カタバミなどの三つ葉を、自信を持って四つ葉と間違える。これを学習で減らすために、「四つ葉がない」と言える写真を集め、モデルが出した枠を「三つ葉」として学習に足す。

1. **写真を集める**（パソコン）: `python training/collect_inat_negatives.py`
   - iNaturalist の研究グレードの観察（カタバミ属・シロツメクサ）のうち、写真のライセンスが CC0 のものだけ。約 600 枚
   - 説明文・タグに「四つ葉」「four-leaf」「four leaf」「4-leaf」「lucky」がある観察は除く。1 人の撮影者からは 10 枚まで
   - API は 1 秒に 1 回まで。写真は公式の公開データの置き場から取る
   - 出力: `data/inat_negatives/images/`・`manifest.csv`（写真 ID・観察のページ・ライセンス・撮影者・種名）・`summary.json`
2. **v2 を通す**: アプリと同じ処理（全体＋タイル 80%）で、スコア 0.3 以上の枠（四つ葉・三つ葉）を `data/inat_negatives/candidates.json` に書き出す
3. **確認シートで確かめる**（パソコン）: `python training/make_review_sheet.py` で `data/inat_negatives/review/index.html` を作り、ブラウザで開く（四つ葉の枠の残りは `--part 2` で `review2/` に作る）
   - 四つ葉として検出された枠（多いときは 400 個まで）と、三つ葉として検出された枠から無作為に 150 個を並べる
   - カタバミ・シロツメクサの葉でない枠をタップして「外す」の印をつけ、「保存（JSON）」で `review-excluded.json` を保存する
   - 外した枠は、学習データに入れない

**テスト専用（学習に入れない）**: three-leaves の 100 枚、`data/hardcases/` の写真（ライセンスが不明なものを含む）。CREDITS.md を参照。
4. **学習用のデータを作る**（パソコン）: `python training/prepare_dataset.py --hardneg` → `data/merged_hardneg/` と `data/merged_hardneg.zip`
   - merged_core の train ＋ iNaturalist の窓（train だけ）。valid は merged_core と同じ
   - 写真は元の大きさ（長い辺 2048px）で取り直したもの（`collect_inat_negatives.py --redownload --size original`）。確認シートの結果は、取り直す前の枠と位置で対応づけて使う（`python training/remap_review.py` → `reviewed.json`。IoU 0.7 以上。対応づけられなかった枠は確認済みにしない）
   - 使う枠: 四つ葉と検出され（スコア 0.3 以上）、確認シートで外さなかった枠だけ（「三つ葉」のラベルにする）。三つ葉と検出された枠は使わない（確認で、半分ほどが葉でなかったため）
   - 窓: 使う枠ごとに、枠の長い辺が窓の幅の 20%・35%・50% になる正方形を切り、960×960 にそろえる。写真の外に出る窓は作らない。1 枚の写真から 20 枚まで（超えたら無作為に選ぶ）
   - 目隠し: 窓の中の、ほかの v2 の検出枠（スコア 0.15 以上。`candidates-mask.json`）は、10% 広げて灰色（114）で塗る。ただし、使う枠で 80% 以上が窓に入るものは、塗らずに「三つ葉」のラベルにする。ラベルの葉にかかった目隠しは元に戻す
   - iNaturalist の 60 枚（半分は使う枠がある写真）は学習に入れず、テスト専用にする（`data/inat_negatives/split.csv`。一度作ったら変えない）
5. **学習する**（Colab）: `train_yotsuba.ipynb` で `DATASET_ZIP = 'merged_hardneg.zip'`・`START_FROM = 'v2'`（v2 の best.pt から 30 周・学習率 0.001）
6. **評価する**（パソコン）: 書き出した ONNX をダウンロードして、
   ```
   pip install onnxruntime numpy pillow
   git show 84a0386:public/models/yotsuba-v2.onnx > data/models/yotsuba-v2.onnx   # v2 は Git の履歴から取り出す（初回だけ。data/models/ を先に作る）
   python training/eval_hardneg.py data/models/yotsuba-v2.onnx <ダウンロードした ONNX>
   ```
   - (a) valid の mAP50 と混同行列 … ノートブックのセクション 7・7-3（v2 と同じ valid で比べる）
   - (b) 四つ葉の誤検出の数 … three-leaves の 100 枚・iNaturalist のテスト専用 60 枚・`data/hardcases/` の写真（アプリと同じ処理）
   - (c) 本物の四つ葉が残る割合 … `training/eval_four_leaf_photos.json`（v2 の学習に使っていない写真 157 枚・正解 199 個）。README の「写真から探す」の節と同じ測り方

**採用の目安**（v2 と比べて）

必須（1 つでも外れたら採用しない）
- three-leaves の 100 枚の、四つ葉の誤検出（確かめる前）が、206 個以下（v2 は 412 個）
- valid の four_leaf の mAP50 が、0.01 以上下がらない
- valid の three_leaf の mAP50 が、0.03 以上下がらない

目標
- three-leaves の 100 枚の、四つ葉の誤検出（確かめたあと）が、90 個以下（v2 は 183 個）
- 本物の四つ葉が残る割合が、84% から下がらない

---

## merged_hardneg2（窓の偏りをなくした版）

merged_hardneg で学習した v3 は、窓が三つ葉のラベルだけで、作り方が「確かめる」の切り抜きと同じ（葉がまん中・枠が窓の 20%・35%・50%）だったため、「この形の窓のまん中の葉は三つ葉」と覚えてしまった（確かめると、本物の四つ葉が 73.3% しか残らない）。そこで、次のように作り直す。

- 作り方: `python training/prepare_dataset.py --hardneg2` → `data/merged_hardneg2/` と `data/merged_hardneg2.zip`
- 中身: merged_core の train ＋ iNaturalist の窓 ＋ core の窓。valid は merged_core と同じ
- **core の窓**: merged_core の train の、四つ葉の枠すべてと、同じ数の三つ葉の枠（無作為）について、iNaturalist と同じ作り方の窓を作る。窓の中の、ほかの枠は、80% 以上が窓に入るものだけ本物のクラスのラベルにし、入りきらないものは灰色で目隠しする
- **ずらす**: すべての窓で、目当ての葉を窓のまん中に置かない（縦横それぞれ、窓の幅の最大 25% まで無作為にずらす。写真の外に出たら、ずらし方を変えて 10 回まで試す）
- **数をそろえる**: 窓の中の、四つ葉と三つ葉のラベルの数を同じにする。三つ葉が多いときは iNaturalist の窓を、四つ葉が多いときは core の三つ葉の窓の数で、無作為に合わせる
- テスト専用の写真（three-leaves の 100 枚・iNaturalist の 60 枚・`data/hardcases/`）は入れない
- 学習（Colab）: `DATASET_ZIP = 'merged_hardneg2.zip'`・`RUN_TAG = 'hardneg2'`・`START_FROM = 'v2'`
- 評価（パソコン）: `python training/eval_hardneg.py data/models/yotsuba-v2.onnx public/models/yotsuba-v3.onnx <ダウンロードした ONNX>`

**採用の目安**（v2 と比べて）
- 必須: valid の mAP50 が、四つ葉で 0.01 以上、三つ葉で 0.03 以上下がらない。three-leaves の誤検出（確かめる前）が 63 個以下
- 「確かめる」を使うための目安: 確かめたあと、本物の四つ葉が 90% 以上残り、three-leaves の誤検出が 30 個以下。届かなければ、「確かめる」を機能ごと外すことを相談する

---

## merged_hardneg2b（hardneg2 の作り直し）

merged_hardneg2 では、core の四つ葉が大きく写っていて写真の中に収まる窓が少なく、数をそろえるために iNaturalist の窓を減らしていた。また、灰色（目隠し）が三つ葉の窓にだけ多かった。そこで、次のように作り直す。

- 作り方: `python training/prepare_dataset.py --hardneg2b` → `data/merged_hardneg2b/` と `data/merged_hardneg2b.zip`（窓ごとの特徴は `data/merged_hardneg2b_windows.json`）
- **写真の外も灰色で埋める**: 写真の外に出る窓も、外側を灰色（114）で埋めて作る（「確かめる」の切り抜きと同じ）。埋める面積が窓の 50% を超える窓は作らない
- **iNaturalist の窓はすべて使う**（1 枚の写真から 20 枚まで）。四つ葉のラベルが三つ葉と同じくらいになるまで、core の四つ葉の窓を足す。窓の大きさ（20%・35%・50%）の割合は、iNaturalist の窓に合わせて選ぶ
- 葉は窓のまん中に置かない（窓の幅の最大 25% まで、無作為にずらす）
- **くっきり具合をそろえる**: 窓の元の大きさ（画素の数）の分布を、四つ葉の窓と三つ葉の窓で合わせる（大きいほうの窓を、いったん縮めてから 960 にする）
- **灰色をそろえる**: 窓ごとの灰色の割合（外側の埋め＋目隠し）の分布を合わせる。少ないほうのクラスの窓に、背景（ラベルの葉に重ならない所）に、葉と同じくらいの大きさの灰色の四角を足す
- **近道の検査**: 窓の簡単な特徴（灰色の割合・窓の元の大きさ・葉のずれ・枠の大きさ）だけで、四つ葉の窓か三つ葉の窓かを当てるロジスティック回帰（5 分割の交差検証）の AUC が 0.6 を超えたら、窓を書き出さない
- 学習（Colab）: `DATASET_ZIP = 'merged_hardneg2b.zip'`・`RUN_TAG = 'hardneg2b'`・`START_FROM = 'v2'`
- 採用の目安: merged_hardneg2 と同じ ＋ 代わりの写真（IMG_1403）の誤検出（確かめる前）が 12 本より少ない
