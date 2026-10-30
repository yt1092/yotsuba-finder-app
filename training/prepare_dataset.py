"""
学習用データをまとめるスクリプト

data/public にある Roboflow のデータセット（YOLOv8 形式）を読み、次の 2 つを作る。

    data/merged_core/  … core のデータ（findclover・rectangle_annotation・hunting-four-leaf）だけ
    data/merged_all/   … core ＋ clover-detection2（valid は merged_core と同じ）

あわせて data/merged_core.zip と data/merged_all.zip（Google Colab 用）と、
どの画像をどこに入れたかの一覧 data/merged_manifest.csv も作る。

おもな処理
    1. ラベルを読み、クラス番号を 0 = four_leaf、1 = three_leaf に付け替える。輪郭（ポリゴン）は枠に直す
    2. 長辺が 1200px を超える写真は、約 960×960 のタイルに切り分ける
    3. 見た目が似ている写真（水増しの兄弟、同じ元写真）をグループにまとめ、
       グループ単位で train と valid に分ける（同じ写真が両方に入らないようにするため）
    4. 分け終わったら、train と valid に同じグループがまたがっていないかを検査する

元データ（data/public）は読むだけで、一切変更しない。
使うライブラリは Pillow と numpy だけ（どちらも入っていなければ: pip install pillow numpy）。

実行方法（yotsuba-hunter フォルダで）:
    python training/prepare_dataset.py            # merged_core・merged_all を作る
    python training/prepare_dataset.py --hardneg  # merged_hardneg を作る（merged_core を作ったあとで）
    python training/prepare_dataset.py --hardneg2 # merged_hardneg2 を作る（窓の偏りをなくした版。make_hardneg2() を参照）

merged_hardneg（三つ葉を四つ葉と間違える癖を減らすための再学習用）
    = merged_core の train ＋ iNaturalist の「四つ葉がない」写真から切り出した窓（train だけ）。valid は merged_core と同じ
    窓の作り方は make_windows() の説明を参照。iNaturalist の写真のうち 60 枚は、学習に入れずテスト専用にする
"""

import argparse
import csv
import json
import math
import random
import re
import shutil
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# ──────────────────────────────────────────
# 設定
# ──────────────────────────────────────────

# このファイルの場所から、プロジェクトのフォルダを求める（training/ の 1 つ上）
PROJECT_DIR = Path(__file__).resolve().parent.parent
SOURCE_DIR = PROJECT_DIR / "data" / "public"   # 元データ（読むだけ）
DATA_DIR = PROJECT_DIR / "data"                # 出力先の親フォルダ

# 最終的なクラス（番号: 名前）
CLASS_NAMES = {0: "four_leaf", 1: "three_leaf"}

# 使うデータセットと、「元のクラス番号 → 新しいクラス番号」の対応表
# names は data.yaml の names と一致するかを確かめるためのもの（違えば止まる）
DATASETS = {
    "findclover": {
        "core": True,
        "names": ["------------------------------", "4 leaf clover detect - v1 2025-05-24 12-17am"],
        "map": {0: 0, 1: 0},             # 両方とも four_leaf
        "group_by_name": True,           # 水増しの兄弟（同じ元の名前）を同じグループにする
    },
    "rectangle_annotation": {
        "core": True,
        "names": ["clover3", "clover4"],
        "map": {0: 1, 1: 0},             # clover3 → three_leaf、clover4 → four_leaf
        "group_by_name": True,
    },
    "hunting-four-leaf": {
        "core": True,
        "names": ["clover-3", "clover-4"],
        "map": {0: 1, 1: 0},             # clover-3 → three_leaf、clover-4 → four_leaf
        "group_by_name": True,
    },
    "clover-detection2": {
        "core": False,
        "names": ["Four Leaf Clover", "Three Leaf Clover", "clover3", "clover4"],
        "map": {0: 0, 1: 1, 2: 1, 3: 0},  # Four Leaf・clover4 → four_leaf、Three Leaf・clover3 → three_leaf
        # このデータセットは「1_000005」のような名前が、別の写真どうしで重なっているので、名前ではまとめない
        "group_by_name": False,
    },
}
# 使わないデータセット: clover-detection（clover-detection2 と同じ写真）、Four-LeafCloverFinder、three-leaves
# three-leaves（100 枚）は、評価専用（三つ葉を四つ葉と間違える数を測る）。学習には入れない（CREDITS.md）

SPLITS = ["train", "valid", "test"]            # 元データの分割（全部まとめてから分け直す）
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

MIN_BOX_SIZE = 0.005      # 幅か高さがこれより小さい枠は捨てる（画像に対する割合）

TILE_IF_LONGER_THAN = 1200  # 長辺がこれを超える写真はタイルに切る（px）
TILE_SIZE = 960             # タイルの大きさ（px）
TILE_MIN_OVERLAP = 0.2      # タイル同士の重なり（20% 以上）
TILE_KEEP_RATIO = 0.7       # 枠の面積の 70% 以上がタイルに入っていれば、その枠を残す

HASH_SIZE = 16              # dHash の大きさ（16×16 = 256 ビット）
HASH_THRESHOLD = 20         # これ以下の距離なら「同じ写真」とみなす（下調べ: 重複は 0〜1、無関係は 100 前後）

VALID_RATIO = 0.15          # core のデータのうち、valid に回す割合（データセットごと）
RANDOM_SEED = 42            # 毎回同じ分け方になるように、乱数の種を固定する


# ──────────────────────────────────────────
# 1. ラベルの読み込み
# ──────────────────────────────────────────

def read_names(dataset_dir):
    """data.yaml の names（クラス名の一覧）を読む。"""
    text = (dataset_dir / "data.yaml").read_text(encoding="utf-8")
    match = re.search(r"names:\s*\[(.*?)\]", text)
    return [n.strip().strip("'\"") for n in match.group(1).split(",")] if match else []


def read_label(label_path, class_map, stats):
    """ラベルファイルを読み、枠のリスト [(新クラス, x0, y0, x1, y1), ...] を返す（座標は 0〜1）。

    YOLO のラベルは 1 行 = 1 つの物。
      枠の行:   クラス 中心x 中心y 幅 高さ          （数字が 5 個）
      輪郭の行: クラス x1 y1 x2 y2 x3 y3 ...       （数字が 7 個以上）
    行ごとに形を見分けるので、枠と輪郭が混ざったファイルも正しく読める。
    """
    boxes = []
    if not label_path.exists():
        return boxes  # ラベルファイルがない画像は「枠なし」

    for line in label_path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if not parts:
            continue
        old_class = int(parts[0])
        if old_class not in class_map:
            raise ValueError(f"{label_path}: 対応表にないクラス番号 {old_class}")
        values = [float(v) for v in parts[1:]]

        if len(values) == 4:
            # 枠: 中心と幅・高さ → 左上と右下
            cx, cy, w, h = values
            x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
            stats["枠の行"] += 1
        elif len(values) >= 6 and len(values) % 2 == 0:
            # 輪郭: 点の x と y の、最小・最大で囲む枠にする
            xs, ys = values[0::2], values[1::2]
            x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
            stats["輪郭→枠に変換"] += 1
        else:
            stats["形が不正な行（捨てた）"] += 1
            continue

        # 0〜1 の外にはみ出した分は切り取る
        x0, y0 = max(0.0, x0), max(0.0, y0)
        x1, y1 = min(1.0, x1), min(1.0, y1)
        if x1 - x0 < MIN_BOX_SIZE or y1 - y0 < MIN_BOX_SIZE:
            stats["小さすぎる枠（捨てた）"] += 1
            continue
        boxes.append((class_map[old_class], x0, y0, x1, y1))
    return boxes


def collect_photos():
    """使うデータセットの写真を全部集める。1 枚ごとに辞書を作って、リストで返す。"""
    photos, stats = [], Counter()
    for name, conf in DATASETS.items():
        dataset_dir = SOURCE_DIR / name
        names = read_names(dataset_dir)
        if names != conf["names"]:
            raise ValueError(f"{name} の data.yaml の names が想定と違います: {names}")
        for split in SPLITS:
            image_dir = dataset_dir / split / "images"
            if not image_dir.is_dir():
                continue  # test がないデータセットもある
            for image_path in sorted(image_dir.iterdir()):
                if image_path.suffix.lower() not in IMAGE_EXTENSIONS:
                    continue
                label_path = dataset_dir / split / "labels" / (image_path.stem + ".txt")
                photos.append({
                    "dataset": name,
                    "path": image_path,
                    "orig_name": image_path.name.split(".rf.")[0],  # Roboflow の名前の、.rf. より前 = 元の名前
                    "boxes": read_label(label_path, conf["map"], stats),
                })
    return photos, stats


# ──────────────────────────────────────────
# 2. 見た目が似ている写真のグループ作り
# ──────────────────────────────────────────

def dhash_all_orientations(path):
    """dHash（画像を縮めて、隣り合う画素の明るさの大小を並べた指紋）を、8 通りの向きで計算する。

    回転・反転した兄弟画像も見つけられるように、90° ずつの回転と左右反転の組み合わせ 8 通りを作る。
    戻り値: 8 行 × 256 列の 0/1 の配列
    """
    with Image.open(path) as im:
        gray = im.convert("L")
    hashes = []
    for k in range(8):
        t = gray.rotate(90 * (k % 4), expand=True)
        if k >= 4:
            t = t.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        a = np.asarray(t.resize((HASH_SIZE + 1, HASH_SIZE), Image.LANCZOS), dtype=np.int16)
        hashes.append((a[:, 1:] > a[:, :-1]).ravel())
    return np.array(hashes, dtype=np.float32)


class UnionFind:
    """「この 2 つは同じグループ」という情報を積み重ねて、グループを作るための道具。"""

    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, i):
        # i が属するグループの代表を探す（途中の道のりを短くしながら）
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a, b):
        # a と b を同じグループにする
        self.parent[self.find(a)] = self.find(b)


def make_groups(photos):
    """写真をグループに分け、各写真に "group"（グループ番号）を書き込む。

    同じグループにする条件（どちらか 1 つでも当てはまれば）:
      - 同じデータセットで、元の名前（.rf. より前）が同じ（水増しの兄弟）
        ※ clover-detection2 は名前が別の写真で重なっているので、この条件を使わない
      - dHash の距離が HASH_THRESHOLD 以下（向きを変えて比べた中の最小値）。データセットをまたいでも比べる
    """
    n = len(photos)
    uf = UnionFind(n)

    # 元の名前が同じもの
    by_name = defaultdict(list)
    for i, p in enumerate(photos):
        if DATASETS[p["dataset"]]["group_by_name"]:
            by_name[(p["dataset"], p["orig_name"])].append(i)
    for members in by_name.values():
        for i in members[1:]:
            uf.union(members[0], i)

    # dHash が近いもの
    print(f"  dHash を計算中（{n} 枚）...")
    hashes = np.stack([dhash_all_orientations(p["path"]) for p in photos])  # n × 8 × 256
    base = hashes[:, 0, :]                                                    # 元の向きの指紋
    bits = base.shape[1]
    min_dist = np.full((n, n), bits, dtype=np.float32)
    for k in range(8):
        other = hashes[:, k, :]
        # 2 つの 0/1 の並びの違う数（ハミング距離）を、行列の掛け算でまとめて計算する
        dist = base @ (1 - other).T + (1 - base) @ other.T
        min_dist = np.minimum(min_dist, dist)
    close = np.argwhere(np.triu(min_dist <= HASH_THRESHOLD, k=1))
    for i, j in close:
        uf.union(int(i), int(j))

    for i, p in enumerate(photos):
        p["group"] = uf.find(i)
    return len(close)


# ──────────────────────────────────────────
# 3. タイル分割
# ──────────────────────────────────────────

def tile_starts(length):
    """1 辺の長さから、タイルの開始位置の一覧を作る（重なりが TILE_MIN_OVERLAP 以上になるように）。"""
    if length <= TILE_SIZE:
        return [0], length                   # タイルより短い辺は切らない
    max_step = TILE_SIZE * (1 - TILE_MIN_OVERLAP)
    count = math.ceil((length - TILE_SIZE) / max_step) + 1
    starts = [round(i * (length - TILE_SIZE) / (count - 1)) for i in range(count)]
    return starts, TILE_SIZE


def make_outputs(photo):
    """1 枚の写真から、出力する画像の一覧を作る。

    ふつうの写真は、そのまま 1 枚。長辺が TILE_IF_LONGER_THAN を超える写真は、タイルに分けて複数枚。
    戻り値: [(出力名の末尾, 切り出す範囲 or None, 枠のリスト), ...]  枠は出力画像に対する 0〜1 の座標
    """
    with Image.open(photo["path"]) as im:
        width, height = im.size
    if max(width, height) <= TILE_IF_LONGER_THAN:
        return [("", None, photo["boxes"])]

    outputs = []
    ys, tile_h = tile_starts(height)
    xs, tile_w = tile_starts(width)
    for row, top in enumerate(ys):
        for col, left in enumerate(xs):
            kept = []
            for cls, x0, y0, x1, y1 in photo["boxes"]:
                # 枠をピクセルの座標にして、タイルと重なる部分を求める
                bx0, by0, bx1, by1 = x0 * width, y0 * height, x1 * width, y1 * height
                ix0, iy0 = max(bx0, left), max(by0, top)
                ix1, iy1 = min(bx1, left + tile_w), min(by1, top + tile_h)
                inside = max(0, ix1 - ix0) * max(0, iy1 - iy0)
                if inside < TILE_KEEP_RATIO * (bx1 - bx0) * (by1 - by0):
                    continue  # 枠の 70% 未満しかタイルに入っていなければ、このタイルでは捨てる
                # タイルの中の座標（0〜1）に直す
                tx0, ty0 = (ix0 - left) / tile_w, (iy0 - top) / tile_h
                tx1, ty1 = (ix1 - left) / tile_w, (iy1 - top) / tile_h
                if tx1 - tx0 < MIN_BOX_SIZE or ty1 - ty0 < MIN_BOX_SIZE:
                    continue
                kept.append((cls, tx0, ty0, tx1, ty1))
            if kept:  # 枠が 1 つも残らないタイルは使わない
                outputs.append((f"_t{row}_{col}", (left, top, left + tile_w, top + tile_h), kept))
    return outputs


# ──────────────────────────────────────────
# 4. train / valid への振り分け
# ──────────────────────────────────────────

def assign_splits(photos):
    """グループ単位で、各写真に "split"（train / valid / exclude）と、除いた理由を書き込む。

    - valid には core のデータのグループだけを入れる（データセットごとに、出力枚数の約 15%）
    - clover-detection2 は、valid のグループに入ったもの、rectangle_annotation と同じグループのものを除く
    """
    members = defaultdict(list)
    for p in photos:
        members[p["group"]].append(p)

    # core のデータセットごとに、グループを順番に valid に入れていき、出力枚数が 15% に達したら止める
    rng = random.Random(RANDOM_SEED)
    valid_groups = set()
    for name, conf in DATASETS.items():
        if not conf["core"]:
            continue
        groups = sorted({p["group"] for p in photos if p["dataset"] == name})
        rng.shuffle(groups)
        total = sum(p["n_out"] for p in photos if p["dataset"] == name)
        count = sum(p["n_out"] for g in valid_groups for p in members[g] if p["dataset"] == name)
        for g in groups:
            if count >= total * VALID_RATIO:
                break
            if g in valid_groups:
                continue
            valid_groups.add(g)
            count += sum(p["n_out"] for p in members[g] if p["dataset"] == name)

    # rectangle_annotation と同じグループに入った clover-detection2（重なっている写真）
    rect_groups = {p["group"] for p in photos if p["dataset"] == "rectangle_annotation"}

    for p in photos:
        p["reason"] = ""
        if p["dataset"] == "clover-detection2" and p["group"] in rect_groups:
            p["split"], p["reason"] = "exclude", "rectangle_annotation と重複"
        elif p["group"] in valid_groups:
            if DATASETS[p["dataset"]]["core"]:
                p["split"] = "valid"
            else:
                p["split"], p["reason"] = "exclude", "valid のグループと重複"
        else:
            p["split"] = "train"


# ──────────────────────────────────────────
# 5. 書き出し
# ──────────────────────────────────────────

def write_label(path, boxes):
    """枠のリストを YOLO 形式（クラス 中心x 中心y 幅 高さ）で書く。枠がなければ空のファイルになる。"""
    lines = [f"{c} {(x0 + x1) / 2:.6f} {(y0 + y1) / 2:.6f} {x1 - x0:.6f} {y1 - y0:.6f}"
             for c, x0, y0, x1, y1 in boxes]
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def write_data_yaml(folder):
    """YOLOv8 の学習で読む data.yaml を書く（path を書かないので、展開した場所を基準に読まれる）。"""
    names = "\n".join(f"  {i}: {n}" for i, n in CLASS_NAMES.items())
    (folder / "data.yaml").write_text(
        f"train: train/images\nval: valid/images\n\nnc: {len(CLASS_NAMES)}\nnames:\n{names}\n", encoding="utf-8")


def write_outputs(photos):
    """merged_core と merged_all に、画像とラベルを書き出す。一覧（manifest）の行も返す。"""
    targets = {"merged_core": lambda p: DATASETS[p["dataset"]]["core"], "merged_all": lambda p: True}
    for folder in targets:
        out = DATA_DIR / folder
        if out.exists():
            shutil.rmtree(out)  # 前回の結果が混ざらないように、作り直す
        for split in ("train", "valid"):
            (out / split / "images").mkdir(parents=True)
            (out / split / "labels").mkdir(parents=True)
        write_data_yaml(out)

    manifest = []
    for p in photos:
        if p["split"] == "exclude" or not p["outputs"]:
            # 使わなかった写真も、理由と一緒に一覧に残す
            reason = p["reason"] or "タイルに枠が 1 つも残らない（枠がタイルより大きい）"
            manifest.append({"file": "", "dataset": p["dataset"], "source": p["path"].name,
                             "group": p["group"], "split": "exclude", "reason": reason, "boxes": 0})
            continue
        image = None
        for suffix, crop, boxes in p["outputs"]:
            # ファイル名は「データセット名_元の名前」（タイルは _t行_列 を付ける）
            stem = f"{p['dataset']}_{p['path'].stem}{suffix}"
            if crop is None:
                file_name = stem + p["path"].suffix
            else:
                file_name = stem + ".jpg"
                if image is None:
                    image = Image.open(p["path"]).convert("RGB")
            for folder, use in targets.items():
                if not use(p):
                    continue
                split_dir = DATA_DIR / folder / p["split"]
                if crop is None:
                    shutil.copy2(p["path"], split_dir / "images" / file_name)  # 元のファイルはコピーするだけ
                else:
                    image.crop(crop).save(split_dir / "images" / file_name, quality=95)
                write_label(split_dir / "labels" / (stem + ".txt"), boxes)
            manifest.append({"file": file_name, "dataset": p["dataset"], "source": p["path"].name,
                             "group": p["group"], "split": p["split"], "reason": "", "boxes": len(boxes)})
        if image is not None:
            image.close()
    return manifest


# ──────────────────────────────────────────
# 6. 検査と、結果の表
# ──────────────────────────────────────────

def check_no_leak(manifest):
    """train と valid に、同じグループがまたがっていないかを、2 つの方法で検査する。"""
    print("\n■ 検査: train と valid に同じグループがまたがっていないか")
    ok = True

    # (1) 一覧（manifest）のグループ番号で調べる
    for folder, use_all in (("merged_core", False), ("merged_all", True)):
        rows = [r for r in manifest if r["split"] in ("train", "valid")
                and (use_all or DATASETS[r["dataset"]]["core"])]
        train_g = {r["group"] for r in rows if r["split"] == "train"}
        valid_g = {r["group"] for r in rows if r["split"] == "valid"}
        both = train_g & valid_g
        print(f"  {folder}: train のグループ {len(train_g)} / valid のグループ {len(valid_g)} / 両方にあるグループ {len(both)}")
        ok &= not both

    # (2) 書き出した画像そのものの dHash を計算し直して、valid の各画像に近い train の画像がないか調べる
    #     （グループ分けの仕組みとは別の方法で確かめる）
    for folder in ("merged_core", "merged_all"):
        hashes = {}
        for split in ("train", "valid"):
            files = sorted((DATA_DIR / folder / split / "images").iterdir())
            hashes[split] = (files, np.stack([dhash_all_orientations(f) for f in files]))
        train_files, train_h = hashes["train"]
        valid_files, valid_h = hashes["valid"]
        base = valid_h[:, 0, :]
        min_dist = np.full((len(valid_files), len(train_files)), base.shape[1], dtype=np.float32)
        for k in range(8):
            other = train_h[:, k, :]
            min_dist = np.minimum(min_dist, base @ (1 - other).T + (1 - base) @ other.T)
        near = int((min_dist.min(axis=1) <= HASH_THRESHOLD).sum())
        print(f"  {folder}: valid {len(valid_files)} 枚のうち、train に見た目がほぼ同じ画像がある枚数: {near}")
        ok &= near == 0

    # (3) merged_core と merged_all の valid が同じか
    core_valid = {f.name: f.read_bytes() for f in (DATA_DIR / "merged_core" / "valid" / "images").iterdir()}
    all_valid = {f.name: f.read_bytes() for f in (DATA_DIR / "merged_all" / "valid" / "images").iterdir()}
    same = core_valid == all_valid
    print(f"  merged_core と merged_all の valid が同じ: {'はい' if same else 'いいえ'}（{len(core_valid)} 枚）")
    ok &= same

    print("  → 検査に合格" if ok else "  → ⚠ 検査で問題が見つかりました")
    return ok


def count_folder(folder):
    """出力フォルダの、分割ごと・データセットごとの画像数と、クラスごとの枠の数を数える。"""
    table = defaultdict(Counter)
    for split in ("train", "valid"):
        for label in (DATA_DIR / folder / split / "labels").glob("*.txt"):
            dataset = next(name for name in DATASETS if label.stem.startswith(name + "_"))
            classes = [int(line.split()[0]) for line in label.read_text(encoding="utf-8").splitlines() if line.strip()]
            for key in ((split, dataset), (split, "合計")):
                table[key]["画像"] += 1
                table[key]["four_leaf"] += classes.count(0)
                table[key]["three_leaf"] += classes.count(1)
    return table


def print_summary(stats, photos, n_hash_pairs):
    """処理の記録と、出力フォルダごとの表を表示する。"""
    print("\n■ ラベルの処理")
    for key, value in stats.items():
        print(f"  {key}: {value}")
    tiled = [p for p in photos if p["outputs"] and p["outputs"][0][1] is not None]
    print(f"  タイルに分けた写真: {len(tiled)} 枚 → タイル {sum(len(p['outputs']) for p in tiled)} 枚"
          f"（枠が残らず使わなかった写真: {sum(1 for p in photos if not p['outputs'])} 枚）")

    print("\n■ グループ分け")
    groups = Counter(p["group"] for p in photos)
    print(f"  写真 {len(photos)} 枚 → グループ {len(groups)} 個（2 枚以上のグループ {sum(1 for c in groups.values() if c > 1)} 個）"
          f" / dHash が近かった組 {n_hash_pairs}")
    for reason, n in Counter(p["reason"] for p in photos if p["split"] == "exclude").items():
        print(f"  clover-detection2 から除いた写真（{reason}）: {n} 枚")

    for folder in ("merged_core", "merged_all"):
        table = count_folder(folder)
        print(f"\n■ {folder}")
        print(f"  {'分割':<6}{'データセット':<24}{'画像':>7}{'four_leaf':>11}{'three_leaf':>12}")
        for split in ("train", "valid"):
            for dataset in list(DATASETS) + ["合計"]:
                row = table.get((split, dataset))
                if row:
                    print(f"  {split:<6}{dataset:<24}{row['画像']:>7}{row['four_leaf']:>11}{row['three_leaf']:>12}")


def write_manifest(manifest):
    """どの写真を、どのグループで、どこに入れたかの一覧を CSV で保存する。"""
    with open(DATA_DIR / "merged_manifest.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["file", "dataset", "source", "group", "split", "reason", "boxes"])
        writer.writeheader()
        writer.writerows(manifest)


def make_zips():
    """merged_core と merged_all を zip にまとめる（展開すると merged_core/ などのフォルダができる）。"""
    for folder in ("merged_core", "merged_all"):
        shutil.make_archive(str(DATA_DIR / folder), "zip", root_dir=DATA_DIR, base_dir=folder)
        size = (DATA_DIR / f"{folder}.zip").stat().st_size / 1e6
        print(f"  zip を作成しました: data/{folder}.zip（{size:.0f} MB）")


def main():
    print("■ 写真とラベルの読み込み")
    photos, stats = collect_photos()
    print(f"  {len(photos)} 枚")

    for p in photos:
        p["outputs"] = make_outputs(p)     # タイル分割（ふつうの写真は 1 枚のまま）
        p["n_out"] = len(p["outputs"])

    print("■ 見た目が似ている写真のグループ作り")
    n_hash_pairs = make_groups(photos)

    assign_splits(photos)
    print("■ 書き出し")
    manifest = write_outputs(photos)
    write_manifest(manifest)

    print_summary(stats, photos, n_hash_pairs)
    ok = check_no_leak(manifest)
    if ok:
        print()
        make_zips()
    else:
        print("\n検査に合格しなかったので、zip は作りませんでした。")


# ──────────────────────────────────────────
# 7. merged_hardneg（iNaturalist の「四つ葉がない」写真から切り出した窓を足す）
# ──────────────────────────────────────────

INAT_DIR = DATA_DIR / "inat_negatives"
HARDNEG_DIR = DATA_DIR / "merged_hardneg"
WINDOW_FRACTIONS = (0.2, 0.35, 0.5)  # 枠の長い辺が、窓の幅のこの割合になるように切る（アプリの「確かめる」と同じ）
WINDOW_SIZE = 960                    # 窓は、この大きさにそろえる
LABEL_INSIDE = 0.8                   # ほかの「使う枠」は、80% 以上が窓に入っていればラベルにする（足りなければ目隠し）
MASK_GROW = 0.10                     # 目隠しは、枠を 10% 広げて塗る
MASK_COLOR = (114, 114, 114)         # 目隠しの色（学習時の余白と同じ灰色）
INAT_TEST_COUNT = 60                 # テスト専用にする写真の数（学習に入れない）
MAX_WINDOWS_PER_PHOTO = 20           # 1 枚の写真から作る窓の上限（超えたら無作為に選ぶ。1 枚の写真に偏らないように）
SAME_AS_USE_IOU = 0.5                # 目隠し用の枠のうち、使う枠とこれ以上重なるものは、使う枠と同じ葉とみなす
THREE_LEAF = 1


def inat_inputs():
    """iNaturalist の写真の一覧・v2 の検出枠・確認の結果を読み、写真ごとに「使う枠」と「目隠しする枠」を返す。

    使う枠: v2 が四つ葉と検出し（スコア 0.3 以上）、確認シートで外さなかった枠（三つ葉のラベルにする）。
            写真を取り直したあとは、training/remap_review.py で対応づけた結果（reviewed.json）を使う
    目隠しする枠: それ以外の v2 の検出枠（candidates-mask.json: スコア 0.15 以上。三つ葉・確認で外した枠・確認していない枠）
    """
    with open(INAT_DIR / "manifest.csv", encoding="utf-8") as f:
        manifest = list(csv.DictReader(f))
    candidates = json.loads((INAT_DIR / "candidates.json").read_text(encoding="utf-8"))
    use_ids = set(json.loads((INAT_DIR / "reviewed.json").read_text(encoding="utf-8"))["use"])
    photos = {r["file"]: {"row": r, "use": [], "mask": []} for r in manifest}
    for c in candidates:
        if c["id"] in use_ids:
            photos[c["file"]]["use"].append(c)
    for c in json.loads((INAT_DIR / "candidates-mask.json").read_text(encoding="utf-8")):
        uses = photos[c["file"]]["use"]
        if not any(box_iou(c["box"], u["box"]) >= SAME_AS_USE_IOU for u in uses):
            photos[c["file"]]["mask"].append(c)
    return photos


def box_iou(a, b):
    """枠 [x, y, w, h] どうしの IoU"""
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    return w * h / (a[2] * a[3] + b[2] * b[3] - w * h)


def choose_inat_test(photos):
    """テスト専用の写真を返す。split.csv があれば、そのまま使う（写真を取り直しても、同じ 60 枚のまま）。
    なければ、無作為に選ぶ（半分は、使う枠がある写真から）。毎回同じになるように種を固定する。"""
    split = INAT_DIR / "split.csv"
    if split.exists():
        with open(split, encoding="utf-8") as f:
            return {r["file"] for r in csv.DictReader(f) if r["split"] == "test"}
    rng = random.Random(RANDOM_SEED)
    with_use = sorted(f for f, p in photos.items() if p["use"])
    without = sorted(f for f, p in photos.items() if not p["use"])
    half = INAT_TEST_COUNT // 2
    return set(rng.sample(with_use, half)) | set(rng.sample(without, INAT_TEST_COUNT - half))


def grow(box, ratio):
    """枠 [x, y, w, h] を、中心をそのままに ratio だけ広げる。"""
    x, y, w, h = box
    return [x - w * ratio / 2, y - h * ratio / 2, w * (1 + ratio), h * (1 + ratio)]


def inside_ratio(box, win):
    """枠のうち、窓（x0, y0, x1, y1）の中に入っている面積の割合。"""
    x, y, w, h = box
    iw = max(0.0, min(x + w, win[2]) - max(x, win[0]))
    ih = max(0.0, min(y + h, win[3]) - max(y, win[1]))
    return iw * ih / (w * h) if w * h > 0 else 0.0


def make_windows(image, photo, stats, rng):
    """1 枚の写真から、使う枠ごとに 3 通りの大きさの窓を作る。

    - 窓は枠の中心を中心にした正方形。枠の長い辺が、窓の幅の 20%・35%・50% になる大きさ
    - 窓が写真の外に出る大きさは作らない
    - 窓が MAX_WINDOWS_PER_PHOTO 枚を超える写真は、無作為にその枚数に絞る
    - 窓の中の、使う枠（80% 以上が窓に入るもの）は、三つ葉のラベルにする
    - 窓の中の、それ以外の検出枠（使う枠で窓からはみ出すものを含む）は、10% 広げて灰色で塗る
      ただし、ラベルにする枠の中は塗らない（となりの枠の目隠しが、ラベルの葉にかからないように）
    戻り値: [(名前の末尾, 960×960 の画像, ラベルの枠 [(クラス, x0, y0, x1, y1) 0〜1], 目隠しの数, 元の窓の大きさ), ...]
    """
    width, height = image.size
    specs = []
    for k, target in enumerate(photo["use"]):
        x, y, w, h = target["box"]
        cx, cy = x + w / 2, y + h / 2
        for frac in WINDOW_FRACTIONS:
            side = max(w, h) / frac
            win = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
            if win[0] < 0 or win[1] < 0 or win[2] > width or win[3] > height:
                stats["窓が写真の外に出る（作らない）"] += 1
                continue
            specs.append((k, target, frac, side, win))
    if len(specs) > MAX_WINDOWS_PER_PHOTO:
        stats["上限を超えて減らした窓"] += len(specs) - MAX_WINDOWS_PER_PHOTO
        stats["窓を減らした写真"] += 1
        specs = sorted(rng.sample(specs, MAX_WINDOWS_PER_PHOTO), key=lambda s: (s[0], s[2]))

    out = []
    for k, target, frac, side, win in specs:
        labels, masks = [], []
        for c in photo["use"]:
            ratio = inside_ratio(c["box"], win)
            if c is target or ratio >= LABEL_INSIDE:
                labels.append(c["box"])
            elif inside_ratio(grow(c["box"], MASK_GROW), win) > 0:
                masks.append(c["box"])
        masks += [c["box"] for c in photo["mask"] if inside_ratio(grow(c["box"], MASK_GROW), win) > 0]

        crop = image.crop(tuple(round(v) for v in win))
        original = crop.copy()
        draw = ImageDraw.Draw(crop)
        sx = crop.width / side

        def to_win(b):
            return [(b[0] - win[0]) * sx, (b[1] - win[1]) * sx, (b[0] + b[2] - win[0]) * sx, (b[1] + b[3] - win[1]) * sx]

        for m in masks:
            draw.rectangle(to_win(grow(m, MASK_GROW)), fill=MASK_COLOR)
        for b in labels:  # ラベルの葉の上にかかった目隠しは、元に戻す
            x0, y0, x1, y1 = (round(v) for v in to_win(b))
            crop.paste(original.crop((x0, y0, x1, y1)), (x0, y0))
        crop = crop.resize((WINDOW_SIZE, WINDOW_SIZE), Image.LANCZOS)

        boxes = []
        for b in labels:
            x0, y0 = (b[0] - win[0]) / side, (b[1] - win[1]) / side
            x1, y1 = (b[0] + b[2] - win[0]) / side, (b[1] + b[3] - win[1]) / side
            boxes.append((THREE_LEAF, max(0.0, x0), max(0.0, y0), min(1.0, x1), min(1.0, y1)))
        out.append((f"_{k}_w{round(frac * 100)}", crop, boxes, len(masks), side))
    return out


def near_duplicates(paths_a, paths_b):
    """paths_a のそれぞれに、見た目がほぼ同じ画像が paths_b にあるか（dHash）。ある数を返す。"""
    if not paths_a or not paths_b:
        return 0
    ha = np.stack([dhash_all_orientations(p) for p in paths_a])
    hb = np.stack([dhash_all_orientations(p) for p in paths_b])
    base = ha[:, 0, :]
    min_dist = np.full((len(paths_a), len(paths_b)), base.shape[1], dtype=np.float32)
    for k in range(8):
        other = hb[:, k, :]
        min_dist = np.minimum(min_dist, base @ (1 - other).T + (1 - base) @ other.T)
    return int((min_dist.min(axis=1) <= HASH_THRESHOLD).sum())


def make_hardneg():
    """merged_hardneg を作る: merged_core の train・valid ＋ iNaturalist の窓（学習に使う写真だけ）。

    iNaturalist の写真のうち INAT_TEST_COUNT 枚はテスト専用（data/inat_negatives/split.csv）。
    three-leaves の 100 枚と data/hardcases の写真は、もともと入れない（評価専用）。
    """
    core = DATA_DIR / "merged_core"
    if not (core / "train" / "images").is_dir():
        raise FileNotFoundError("先に python training/prepare_dataset.py で merged_core を作ってください")
    photos = inat_inputs()
    test = choose_inat_test(photos)
    if not (INAT_DIR / "split.csv").exists():
        with open(INAT_DIR / "split.csv", "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["file", "photo_id", "split", "use_boxes"])
            for file, p in sorted(photos.items()):
                writer.writerow([file, p["row"]["photo_id"], "test" if file in test else "train", len(p["use"])])

    print("■ merged_core をコピー")
    if HARDNEG_DIR.exists():
        shutil.rmtree(HARDNEG_DIR)
    shutil.copytree(core, HARDNEG_DIR)

    print("■ iNaturalist の写真から窓を切り出す")
    stats, counts = Counter(), Counter()
    rng = random.Random(RANDOM_SEED)
    out_img, out_lbl = HARDNEG_DIR / "train" / "images", HARDNEG_DIR / "train" / "labels"
    for file, p in sorted(photos.items()):
        if file in test or not p["use"]:
            continue
        with Image.open(INAT_DIR / file) as im:
            image = im.convert("RGB")
        made = 0
        for suffix, crop, boxes, n_mask, side in make_windows(image, p, stats, rng):
            stem = f"inat_{p['row']['photo_id']}{suffix}"
            crop.save(out_img / f"{stem}.jpg", quality=95)
            write_label(out_lbl / f"{stem}.txt", boxes)
            made += 1
            counts["窓"] += 1
            counts[f"窓（{suffix.rsplit('_', 1)[1]}）"] += 1
            counts["三つ葉のラベル"] += len(boxes)
            counts["目隠しした枠"] += n_mask
            counts["元の大きさが 500px 以下の窓（960 に拡大）"] += side <= 500
        counts["学習に使う写真（使う枠あり）"] += 1
        counts["学習に使う写真の、使う枠"] += len(p["use"])
        counts["窓が 1 つも作れなかった写真"] += made == 0

    print("\n■ merged_hardneg")
    print(f"  テスト専用にした iNaturalist の写真: {len(test)} 枚（使う枠あり {sum(1 for f in test if photos[f]['use'])} 枚）")
    for key, value in list(stats.items()) + list(counts.items()):
        print(f"  {key}: {value}")
    table = Counter()
    for split in ("train", "valid"):
        for label in (HARDNEG_DIR / split / "labels").glob("*.txt"):
            classes = [int(l.split()[0]) for l in label.read_text(encoding="utf-8").splitlines() if l.strip()]
            src = "inat" if label.stem.startswith("inat_") else "core"
            table[(split, src, "画像")] += 1
            table[(split, src, "four_leaf")] += classes.count(0)
            table[(split, src, "three_leaf")] += classes.count(1)
    for split, src in (("train", "core"), ("train", "inat"), ("valid", "core")):
        print(f"  {split:<6}{src:<6} 画像 {table[(split, src, '画像')]:>5} / four_leaf {table[(split, src, 'four_leaf')]:>5}"
              f" / three_leaf {table[(split, src, 'three_leaf')]:>5}")

    print("\n■ 検査")
    test_paths = sorted(INAT_DIR / f for f in test)
    train_paths = sorted(INAT_DIR / f for f, p in photos.items() if f not in test and p["use"])
    valid_paths = sorted((HARDNEG_DIR / "valid" / "images").iterdir())
    dup_test = near_duplicates(test_paths, train_paths)
    dup_valid = near_duplicates(train_paths, valid_paths)
    print(f"  テスト専用の写真 {len(test_paths)} 枚のうち、学習に使う写真にほぼ同じものがある枚数: {dup_test}")
    print(f"  学習に使う iNaturalist の写真 {len(train_paths)} 枚のうち、valid にほぼ同じものがある枚数: {dup_valid}")
    if dup_test or dup_valid:
        print("  → ⚠ 検査で問題が見つかったので、zip は作りませんでした。")
        return
    shutil.make_archive(str(HARDNEG_DIR), "zip", root_dir=DATA_DIR, base_dir=HARDNEG_DIR.name)
    size = (DATA_DIR / "merged_hardneg.zip").stat().st_size / 1e6
    print(f"  → 検査に合格\n  zip を作成しました: data/merged_hardneg.zip（{size:.0f} MB）")


# ──────────────────────────────────────────
# 8. merged_hardneg2（窓の偏りをなくした版）
# ──────────────────────────────────────────
# merged_hardneg で学習した v3 は、窓が三つ葉のラベルだけで、作り方が「確かめる」の切り抜きと同じだったため、
# 「この形の窓のまん中の葉は三つ葉」と覚えてしまった。そこで、次のようにする
#   - core の train からも、同じ作り方の窓を作る（四つ葉の枠すべてと、同じ数ほどの三つ葉の枠）。窓の中の、ほかの枠は本物のクラス
#   - すべての窓で、葉をまん中に置かない（窓の幅の最大 25% まで、無作為にずらす）
#   - 窓の中の、四つ葉と三つ葉のラベルの数を、同じくらいにそろえる（core の三つ葉の窓の数で合わせる）

HARDNEG2_DIR = DATA_DIR / "merged_hardneg2"
WINDOW_SHIFT = 0.25      # 葉の中心を、窓のまん中から、窓の幅のこの割合まで（縦横それぞれ）ずらす
SHIFT_TRIES = 10         # ずらした窓が写真の外に出たら、ずらし方を変えて、この回数まで試す
FOUR_LEAF = 0


def window_specs(boxes, width, height, rng, stats):
    """目当ての枠ごとに、3 通りの大きさの窓を、まん中から無作為にずらして作る。写真の外に出るものは作らない。
    boxes: [(目当ての番号, [x, y, w, h])] → [(番号, 割合, 窓の幅, (x0, y0, x1, y1)), ...]"""
    specs = []
    for k, (x, y, w, h) in boxes:
        for frac in WINDOW_FRACTIONS:
            side = max(w, h) / frac
            for _ in range(SHIFT_TRIES):
                cx = x + w / 2 - rng.uniform(-WINDOW_SHIFT, WINDOW_SHIFT) * side
                cy = y + h / 2 - rng.uniform(-WINDOW_SHIFT, WINDOW_SHIFT) * side
                win = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
                if win[0] >= 0 and win[1] >= 0 and win[2] <= width and win[3] <= height:
                    specs.append((k, frac, side, win))
                    break
            else:
                stats["窓が写真の外に出る（作らない）"] += 1
    return specs


def cut_window(image, side, win, labeled, masked):
    """窓を切り出し、目隠しを塗って 960×960 にする。
    labeled: [(クラス, [x, y, w, h])] ラベルにする枠（その上の目隠しは元に戻す）、masked: [[x, y, w, h]] 10% 広げて灰色で塗る枠
    戻り値: (画像, [(クラス, x0, y0, x1, y1) 0〜1])"""
    crop = image.crop(tuple(round(v) for v in win))
    original = crop.copy()
    draw = ImageDraw.Draw(crop)
    sx = crop.width / side

    def to_win(b):
        return [(b[0] - win[0]) * sx, (b[1] - win[1]) * sx, (b[0] + b[2] - win[0]) * sx, (b[1] + b[3] - win[1]) * sx]

    for m in masked:
        draw.rectangle(to_win(grow(m, MASK_GROW)), fill=MASK_COLOR)
    for _, b in labeled:  # ラベルの葉の上にかかった目隠しは、元に戻す
        x0, y0, x1, y1 = (round(v) for v in to_win(b))
        crop.paste(original.crop((x0, y0, x1, y1)), (x0, y0))
    boxes = []
    for cls, b in labeled:
        x0, y0 = (b[0] - win[0]) / side, (b[1] - win[1]) / side
        x1, y1 = (b[0] + b[2] - win[0]) / side, (b[1] + b[3] - win[1]) / side
        boxes.append((cls, max(0.0, x0), max(0.0, y0), min(1.0, x1), min(1.0, y1)))
    return crop.resize((WINDOW_SIZE, WINDOW_SIZE), Image.LANCZOS), boxes


def split_in_window(win, target, candidates):
    """窓の中の枠を、ラベルにするもの（目当て・80% 以上が窓に入るもの）と、目隠しするもの（入りきらないもの）に分ける。
    candidates: [(クラス, [x, y, w, h])]"""
    labeled, masked = [], []
    for i, (cls, box) in enumerate(candidates):
        if i == target or inside_ratio(box, win) >= LABEL_INSIDE:
            labeled.append((cls, box))
        elif inside_ratio(grow(box, MASK_GROW), win) > 0:
            masked.append(box)
    return labeled, masked


def core_train_boxes():
    """merged_core の train の画像ごとの、正解の枠 [(クラス, [x, y, w, h]) ピクセル]"""
    out = {}
    for label in sorted((DATA_DIR / "merged_core" / "train" / "labels").glob("*.txt")):
        image = next((DATA_DIR / "merged_core" / "train" / "images").glob(label.stem + ".*"))
        with Image.open(image) as im:
            W, H = im.size
        boxes = []
        for line in label.read_text(encoding="utf-8").splitlines():
            if line.strip():
                c, cx, cy, w, h = (float(v) for v in line.split())
                boxes.append((int(c), [(cx - w / 2) * W, (cy - h / 2) * H, w * W, h * H]))
        out[image] = boxes
    return out


def make_hardneg2():
    """merged_hardneg2 を作る: merged_core の train・valid ＋ iNaturalist の窓（ずらしたもの）＋ core の窓。

    テスト専用の写真（three-leaves の 100 枚・iNaturalist の 60 枚・data/hardcases）は入れない。
    """
    core = DATA_DIR / "merged_core"
    if not (core / "train" / "images").is_dir():
        raise FileNotFoundError("先に python training/prepare_dataset.py で merged_core を作ってください")
    photos = inat_inputs()
    test = choose_inat_test(photos)
    rng = random.Random(RANDOM_SEED)
    stats = Counter()

    # ── 1. 窓の設計（まだ切り出さない）──
    # iNaturalist: 使う枠（三つ葉のラベル）ごと。1 枚の写真から MAX_WINDOWS_PER_PHOTO 枚まで
    inat_jobs = []
    for file, p in sorted(photos.items()):
        if file in test or not p["use"]:
            continue
        with Image.open(INAT_DIR / file) as im:
            W, H = im.size
        specs = window_specs([(k, c["box"]) for k, c in enumerate(p["use"])], W, H, rng, stats)
        if len(specs) > MAX_WINDOWS_PER_PHOTO:
            stats["上限を超えて減らした iNaturalist の窓"] += len(specs) - MAX_WINDOWS_PER_PHOTO
            specs = sorted(rng.sample(specs, MAX_WINDOWS_PER_PHOTO), key=lambda s: (s[0], s[1]))
        cands = [(THREE_LEAF, c["box"]) for c in p["use"]]
        inat_jobs += [("inat", INAT_DIR / file, f"inat_{p['row']['photo_id']}", s, cands, p["mask"]) for s in specs]

    # core: 四つ葉の枠すべてと、同じ数の三つ葉の枠（無作為）
    core_boxes = core_train_boxes()
    fours = [(img, i) for img, bs in core_boxes.items() for i, (c, _) in enumerate(bs) if c == FOUR_LEAF]
    threes = [(img, i) for img, bs in core_boxes.items() for i, (c, _) in enumerate(bs) if c == THREE_LEAF]
    threes = rng.sample(threes, min(len(fours), len(threes)))
    core_jobs = {FOUR_LEAF: [], THREE_LEAF: []}
    sizes = {}
    for cls, targets in ((FOUR_LEAF, fours), (THREE_LEAF, threes)):
        for img, i in targets:
            if img not in sizes:
                with Image.open(img) as im:
                    sizes[img] = im.size
            for s in window_specs([(i, core_boxes[img][i][1])], *sizes[img], rng, stats):
                core_jobs[cls].append(("core", img, f"win_{img.stem}", s, core_boxes[img], []))

    # ── 2. ラベルの数をそろえる（窓の中の、四つ葉と三つ葉）──
    def count(jobs):
        n = Counter()
        for _, _, _, (k, frac, side, win), cands, _ in jobs:
            for cls, _ in split_in_window(win, k, cands)[0]:
                n[cls] += 1
        return n

    def threes_in(job):
        return sum(1 for c, _ in split_in_window(job[3][3], job[3][0], job[4])[0] if c == THREE_LEAF)

    base = count(inat_jobs) + count(core_jobs[FOUR_LEAF])
    rng.shuffle(core_jobs[THREE_LEAF])
    chosen_three, n_three = [], base[THREE_LEAF]
    if n_three > base[FOUR_LEAF]:
        # 三つ葉のほうが多い（core の四つ葉は大きく写っていて、写真の中に収まる窓が少ない）→ iNaturalist の窓を無作為に減らす
        rng.shuffle(inat_jobs)
        while inat_jobs and n_three - threes_in(inat_jobs[-1]) >= base[FOUR_LEAF]:
            n_three -= threes_in(inat_jobs.pop())
            stats["そろえるために使わなかった iNaturalist の窓"] += 1
    for job in core_jobs[THREE_LEAF]:
        if n_three >= base[FOUR_LEAF]:
            break
        chosen_three.append(job)
        n_three += threes_in(job)
    stats["そろえるために使わなかった core の三つ葉の窓"] = len(core_jobs[THREE_LEAF]) - len(chosen_three)
    jobs = inat_jobs + core_jobs[FOUR_LEAF] + chosen_three

    # ── 3. 書き出し ──
    print("■ merged_core をコピー")
    if HARDNEG2_DIR.exists():
        shutil.rmtree(HARDNEG2_DIR)
    shutil.copytree(core, HARDNEG2_DIR)
    print(f"■ 窓を切り出す（{len(jobs)} 枚）")
    out_img, out_lbl = HARDNEG2_DIR / "train" / "images", HARDNEG2_DIR / "train" / "labels"
    counts = Counter()
    current, image = None, None
    for kind, path, stem, (k, frac, side, win), cands, mask in sorted(jobs, key=lambda j: (str(j[1]), j[3][0], j[3][1])):
        if path != current:
            with Image.open(path) as im:
                image = im.convert("RGB")
            current = path
        labeled, masked = split_in_window(win, k, cands)
        masked += [c["box"] for c in mask if inside_ratio(grow(c["box"], MASK_GROW), win) > 0]
        crop, boxes = cut_window(image, side, win, labeled, masked)
        name = f"{stem}_{k}_w{round(frac * 100)}"
        crop.save(out_img / f"{name}.jpg", quality=95)
        write_label(out_lbl / f"{name}.txt", boxes)
        group = "iNaturalist" if kind == "inat" else ("core（四つ葉が目当て）" if cands[k][0] == FOUR_LEAF else "core（三つ葉が目当て）")
        counts[(group, "窓")] += 1
        counts[(group, "four_leaf")] += sum(1 for b in boxes if b[0] == FOUR_LEAF)
        counts[(group, "three_leaf")] += sum(1 for b in boxes if b[0] == THREE_LEAF)
        counts[(group, "目隠し")] += len(masked)
        counts[(group, "500px 以下")] += side <= 500

    print("\n■ merged_hardneg2")
    for key, value in stats.items():
        print(f"  {key}: {value}")
    print(f"  {'窓の種類':<22}{'窓':>6}{'four_leaf':>11}{'three_leaf':>12}{'目隠し':>8}{'500px以下':>10}")
    total = Counter()
    for group in ("iNaturalist", "core（四つ葉が目当て）", "core（三つ葉が目当て）"):
        row = [counts[(group, k)] for k in ("窓", "four_leaf", "three_leaf", "目隠し", "500px 以下")]
        for k, v in zip(("窓", "four_leaf", "three_leaf", "目隠し", "500px 以下"), row):
            total[k] += v
        print(f"  {group:<22}{row[0]:>6}{row[1]:>11}{row[2]:>12}{row[3]:>8}{row[4]:>10}")
    print(f"  {'合計':<22}{total['窓']:>6}{total['four_leaf']:>11}{total['three_leaf']:>12}{total['目隠し']:>8}{total['500px 以下']:>10}")
    for split in ("train", "valid"):
        n = len(list((HARDNEG2_DIR / split / "images").iterdir()))
        print(f"  {split}: 画像 {n} 枚")

    print("\n■ 検査")
    test_paths = sorted(INAT_DIR / f for f in test)
    train_paths = sorted({j[1] for j in inat_jobs})
    valid_paths = sorted((HARDNEG2_DIR / "valid" / "images").iterdir())
    dup_test = near_duplicates(test_paths, train_paths)
    dup_valid = near_duplicates(train_paths, valid_paths)
    print(f"  テスト専用の写真 {len(test_paths)} 枚のうち、学習に使う写真にほぼ同じものがある枚数: {dup_test}")
    print(f"  学習に使う iNaturalist の写真 {len(train_paths)} 枚のうち、valid にほぼ同じものがある枚数: {dup_valid}")
    if dup_test or dup_valid:
        print("  → ⚠ 検査で問題が見つかったので、zip は作りませんでした。")
        return
    shutil.make_archive(str(HARDNEG2_DIR), "zip", root_dir=DATA_DIR, base_dir=HARDNEG2_DIR.name)
    size = (DATA_DIR / "merged_hardneg2.zip").stat().st_size / 1e6
    print(f"  → 検査に合格\n  zip を作成しました: data/merged_hardneg2.zip（{size:.0f} MB）")


# ──────────────────────────────────────────
# 9. merged_hardneg2b（写真の外も灰色で埋める窓・灰色の偏りをなくす・近道の検査）
# ──────────────────────────────────────────
# merged_hardneg2 では、core の四つ葉は大きく写っているため、写真の中に収まる窓が少なく、
# 数をそろえるために iNaturalist の窓を減らしていた。また、灰色（目隠し）は iNaturalist の窓（三つ葉）に多かった。
#   - 写真の外に出る窓も、外側を灰色で埋めて作る（「確かめる」の切り抜きと同じ）。埋める面積が窓の 50% を超える窓は作らない
#   - iNaturalist の窓は減らさない。四つ葉のラベルが三つ葉と同じくらいになるまで、core の四つ葉の窓を作る
#   - 灰色の割合（外側の埋め＋目隠し）の分布を、四つ葉の窓と三つ葉の窓でそろえる（少ないほうに、背景に灰色の四角を足す）
#   - 近道の検査: 窓の簡単な特徴だけで、四つ葉の窓か三つ葉の窓かを当てられないか（ロジスティック回帰の AUC）を調べる

HARDNEG2B_DIR = DATA_DIR / "merged_hardneg2b"
MAX_PAD = 0.5            # 写真の外を灰色で埋める面積が、窓のこの割合を超える窓は作らない
GRID = 120               # 灰色の割合を計算するときの、窓のます目の数（1 辺）
EXTRA_SIZE = (0.8, 1.5)  # 足す灰色の四角の大きさ（目当ての葉の長い辺に対する倍率）
EXTRA_TRIES = 300        # 灰色の四角を置く場所を探す回数
SHORTCUT_AUC_LIMIT = 0.6


def padded_specs(boxes, width, height, rng, stats):
    """目当ての枠ごとに、3 通りの大きさの窓を、まん中から無作為にずらして作る。
    写真の外に出てもよいが、外側（灰色で埋める所）が窓の MAX_PAD を超えるものは、ずらし方を変えて試し、だめなら作らない。
    boxes: [(目当ての番号, [x, y, w, h])] → [(番号, 割合, 窓の幅, (x0, y0, x1, y1), ずれ dx, ずれ dy), ...]"""
    specs = []
    for k, (x, y, w, h) in boxes:
        for frac in WINDOW_FRACTIONS:
            side = max(w, h) / frac
            for _ in range(SHIFT_TRIES):
                dx, dy = rng.uniform(-WINDOW_SHIFT, WINDOW_SHIFT), rng.uniform(-WINDOW_SHIFT, WINDOW_SHIFT)
                cx, cy = x + w / 2 - dx * side, y + h / 2 - dy * side
                win = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
                inside = max(0.0, min(win[2], width) - max(win[0], 0)) * max(0.0, min(win[3], height) - max(win[1], 0))
                if 1 - inside / (side * side) <= MAX_PAD:
                    specs.append((k, frac, side, win, dx, dy))
                    break
            else:
                stats["灰色の埋めが 50% を超える（作らない）"] += 1
    return specs


def to_cells(box, win, side):
    """枠 [x, y, w, h]（元の写真の座標）を、窓のます目（0〜GRID）の範囲 (c0, r0, c1, r1) にする"""
    s = GRID / side
    return (max(0, int((box[0] - win[0]) * s)), max(0, int((box[1] - win[1]) * s)),
            min(GRID, int(math.ceil((box[0] + box[2] - win[0]) * s))), min(GRID, int(math.ceil((box[1] + box[3] - win[1]) * s))))


def gray_map(job, size):
    """窓の灰色の所（外側の埋め＋目隠し＋足した四角。ラベルの葉の上は除く）を、ます目の True で返す"""
    width, height = size
    side, win = job["side"], job["win"]
    g = np.ones((GRID, GRID), dtype=bool)
    c0, r0, c1, r1 = to_cells([0, 0, width, height], win, side)
    g[r0:r1, c0:c1] = False                       # 写真がある所
    for m in job["masked"]:
        c0, r0, c1, r1 = to_cells(grow(m, MASK_GROW), win, side)
        g[r0:r1, c0:c1] = True
    for e in job["extra"]:
        c0, r0, c1, r1 = to_cells(e, win, side)
        g[r0:r1, c0:c1] = True
    photo = np.zeros((GRID, GRID), dtype=bool)
    c0, r0, c1, r1 = to_cells([0, 0, width, height], win, side)
    photo[r0:r1, c0:c1] = True
    for _, b in job["labeled"]:                   # ラベルの葉の上は、元に戻す（写真がある所だけ）
        c0, r0, c1, r1 = to_cells(b, win, side)
        g[r0:r1, c0:c1] &= ~photo[r0:r1, c0:c1]
    return g


def add_gray_squares(job, size, target, rng):
    """背景（ラベルの葉に重ならない所）に、葉と同じくらいの大きさの灰色の四角を足して、灰色の割合を target に近づける"""
    side, win = job["side"], job["win"]
    leaf = max(job["target_box"][2], job["target_box"][3])
    avoid = [grow(b, MASK_GROW) for _, b in job["labeled"]]
    for _ in range(EXTRA_TRIES):
        if job["gray"] >= target:
            break
        s = leaf * rng.uniform(*EXTRA_SIZE)
        x, y = rng.uniform(win[0], win[2] - s), rng.uniform(win[1], win[3] - s)
        sq = [x, y, s, s]
        if any(inside_ratio(sq, (a[0], a[1], a[0] + a[2], a[1] + a[3])) > 0 for a in avoid):
            continue
        job["extra"].append(sq)
        job["gray"] = float(gray_map(job, size).mean())


def render_padded(image, job):
    """窓を 960×960 に描く: 写真の外は灰色・目隠し・ラベルの葉の上は元に戻す・足した灰色の四角。戻り値: (画像, ラベル)"""
    side, win = job["side"], job["win"]
    k = WINDOW_SIZE / side
    canvas = Image.new("RGB", (WINDOW_SIZE, WINDOW_SIZE), MASK_COLOR)
    ix0, iy0 = max(0.0, win[0]), max(0.0, win[1])
    ix1, iy1 = min(float(image.width), win[2]), min(float(image.height), win[3])
    piece = image.crop((round(ix0), round(iy0), round(ix1), round(iy1)))
    pw, ph = max(1, round((ix1 - ix0) * k)), max(1, round((iy1 - iy0) * k))
    if job["eff"] < side:  # くっきり具合をそろえる: いったん eff 画素の窓の大きさまで縮めてから、960 にする
        e = job["eff"] / side
        piece = piece.resize((max(1, round(piece.width * e)), max(1, round(piece.height * e))), Image.LANCZOS)
    canvas.paste(piece.resize((pw, ph), Image.LANCZOS), (round((ix0 - win[0]) * k), round((iy0 - win[1]) * k)))
    original = canvas.copy()
    draw = ImageDraw.Draw(canvas)

    def to_win(b):
        return [(b[0] - win[0]) * k, (b[1] - win[1]) * k, (b[0] + b[2] - win[0]) * k, (b[1] + b[3] - win[1]) * k]

    for m in job["masked"]:
        draw.rectangle(to_win(grow(m, MASK_GROW)), fill=MASK_COLOR)
    for _, b in job["labeled"]:  # ラベルの葉の上にかかった目隠しは、元に戻す（写真の外の灰色はそのまま）
        x0, y0, x1, y1 = (min(WINDOW_SIZE, max(0, round(v))) for v in to_win(b))
        if x1 > x0 and y1 > y0:
            canvas.paste(original.crop((x0, y0, x1, y1)), (x0, y0))
    for e in job["extra"]:
        draw.rectangle(to_win(e), fill=MASK_COLOR)
    boxes = []
    for cls, b in job["labeled"]:
        x0, y0 = (b[0] - win[0]) / side, (b[1] - win[1]) / side
        x1, y1 = (b[0] + b[2] - win[0]) / side, (b[1] + b[3] - win[1]) / side
        boxes.append((cls, max(0.0, x0), max(0.0, y0), min(1.0, x1), min(1.0, y1)))
    return canvas, boxes


def auc_score(y, s):
    """AUC（順位で計算。同じ値は平均の順位）"""
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s))
    sorted_s = s[order]
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    pos = y == 1
    n_pos, n_neg = pos.sum(), (~pos).sum()
    return float((ranks[pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def logistic_cv_auc(X, y, folds=5, seed=RANDOM_SEED):
    """ロジスティック回帰（勾配降下・L2 少し）を、5 分割の交差検証で当てたときの AUC"""
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(y))
    scores = np.zeros(len(y))
    for f in range(folds):
        test = idx[f::folds]
        train = np.setdiff1d(idx, test)
        mu, sd = X[train].mean(0), X[train].std(0) + 1e-9
        A = np.c_[np.ones(len(train)), (X[train] - mu) / sd]
        w = np.zeros(A.shape[1])
        for _ in range(2000):
            p = 1 / (1 + np.exp(-A @ w))
            w -= 0.5 * (A.T @ (p - y[train]) / len(train) + 1e-3 * np.r_[0, w[1:]])
        B = np.c_[np.ones(len(test)), (X[test] - mu) / sd]
        scores[test] = B @ w
    return auc_score(y, scores)


SHORTCUT_FEATURES = ["灰色の割合", "窓の元の大きさ(px。縮めたあと)", "ずれ dx", "ずれ dy", "ずれの大きさ", "枠の大きさ(窓に対する割合)"]


def shortcut_features(jobs):
    X = np.array([[j["gray"], j["eff"], j["dx"], j["dy"], math.hypot(j["dx"], j["dy"]), j["frac"]] for j in jobs])
    y = np.array([1 if j["cls"] == FOUR_LEAF else 0 for j in jobs])
    return X, y


def report_shortcut(jobs):
    X, y = shortcut_features(jobs)
    total = logistic_cv_auc(X, y)
    print(f"  すべての特徴で当てたときの AUC: {total:.3f}（{SHORTCUT_AUC_LIMIT} 以下なら偏りがない）")
    for i, name in enumerate(SHORTCUT_FEATURES):
        a = auc_score(y, X[:, i])
        print(f"    {name}: 1 つだけの AUC {max(a, 1 - a):.3f}")
    return total


def gray_summary(jobs, title):
    print(f"  {title}")
    for cls, name in ((FOUR_LEAF, "四つ葉の窓"), (THREE_LEAF, "三つ葉の窓")):
        g = np.array([j["gray"] for j in jobs if j["cls"] == cls])
        print(f"    {name}: {len(g)} 枚 / 平均 {g.mean():.3f}・中央値 {np.median(g):.3f}・四分位 {np.percentile(g, 25):.3f}〜{np.percentile(g, 75):.3f}")


def make_hardneg2b():
    """merged_hardneg2b を作る: merged_core の train・valid ＋ iNaturalist の窓（すべて）＋ core の窓。
    テスト専用の写真（three-leaves の 100 枚・iNaturalist の 60 枚・data/hardcases）は入れない。"""
    core = DATA_DIR / "merged_core"
    if not (core / "train" / "images").is_dir():
        raise FileNotFoundError("先に python training/prepare_dataset.py で merged_core を作ってください")
    photos = inat_inputs()
    test = choose_inat_test(photos)
    rng = random.Random(RANDOM_SEED)
    stats = Counter()
    sizes = {}

    def size_of(path):
        if path not in sizes:
            with Image.open(path) as im:
                sizes[path] = im.size
        return sizes[path]

    def job(path, stem, spec, cands, mask, cls):
        k, frac, side, win, dx, dy = spec
        labeled, masked = split_in_window(win, k, cands)
        masked += [m["box"] for m in mask if inside_ratio(grow(m["box"], MASK_GROW), win) > 0]
        j = {"path": path, "name": f"{stem}_{k}_w{round(frac * 100)}", "k": k, "frac": frac, "side": side, "win": win,
             "dx": dx, "dy": dy, "labeled": labeled, "masked": masked, "extra": [], "cls": cls, "target_box": cands[k][1],
             "eff": side}  # eff: 窓の元の大きさ（くっきり具合をそろえるために縮めたら、その大きさ）
        j["gray"] = float(gray_map(j, size_of(path)).mean())
        return j

    # ── 1. iNaturalist の窓（すべて。1 枚の写真から MAX_WINDOWS_PER_PHOTO 枚まで）──
    jobs = []
    for file, p in sorted(photos.items()):
        if file in test or not p["use"]:
            continue
        path = INAT_DIR / file
        specs = padded_specs([(k, c["box"]) for k, c in enumerate(p["use"])], *size_of(path), rng, stats)
        if len(specs) > MAX_WINDOWS_PER_PHOTO:
            stats["上限を超えて減らした iNaturalist の窓（1 枚 20 枚まで）"] += len(specs) - MAX_WINDOWS_PER_PHOTO
            specs = sorted(rng.sample(specs, MAX_WINDOWS_PER_PHOTO), key=lambda s: (s[0], s[1]))
        cands = [(THREE_LEAF, c["box"]) for c in p["use"]]
        jobs += [job(path, f"inat_{p['row']['photo_id']}", s, cands, p["mask"], THREE_LEAF) for s in specs]
    n_inat = len(jobs)

    # ── 2. core の四つ葉の窓を、四つ葉のラベルが三つ葉と同じくらいになるまで足す ──
    def labels(js):
        n = Counter()
        for j in js:
            for c, _ in j["labeled"]:
                n[c] += 1
        return n

    core_boxes = core_train_boxes()
    targets = {cls: [(img, i) for img, bs in core_boxes.items() for i, (c, _) in enumerate(bs) if c == cls]
               for cls in (FOUR_LEAF, THREE_LEAF)}
    four_specs = [(img, i, s) for img, i in targets[FOUR_LEAF]
                  for s in padded_specs([(i, core_boxes[img][i][1])], *size_of(img), rng, stats)]
    rng.shuffle(four_specs)
    # 窓の大きさ（20%・35%・50%）の割合を、iNaturalist の窓と同じにする（四つ葉は 20% の窓が作れないことが多いため）
    want = Counter(j["frac"] for j in jobs)
    buckets = {f: [x for x in four_specs if x[2][1] == f] for f in WINDOW_FRACTIONS}
    used = Counter()
    n = labels(jobs)
    while n[FOUR_LEAF] < n[THREE_LEAF]:
        open_f = [f for f in WINDOW_FRACTIONS if buckets[f]]
        if not open_f:
            break
        f = min(open_f, key=lambda f: used[f] / want[f] if want[f] else float("inf"))
        img, i, s = buckets[f].pop()
        used[f] += 1
        j = job(img, f"win_{img.stem}", s, core_boxes[img], [], FOUR_LEAF)
        jobs.append(j)
        n += labels([j])
    stats["使わなかった core の四つ葉の窓"] = sum(len(b) for b in buckets.values())
    # 四つ葉が多くなりすぎたら、core の三つ葉の枠から、三つ葉のラベルを作る窓を足す
    if n[FOUR_LEAF] > n[THREE_LEAF] * 1.05:
        three_targets = rng.sample(targets[THREE_LEAF], len(targets[THREE_LEAF]))
        for img, i in three_targets:
            if n[THREE_LEAF] >= n[FOUR_LEAF]:
                break
            for s in padded_specs([(i, core_boxes[img][i][1])], *size_of(img), rng, stats)[:1]:
                j = job(img, f"win_{img.stem}", s, core_boxes[img], [], THREE_LEAF)
                jobs.append(j)
                n += labels([j])
                stats["core の三つ葉の窓"] += 1

    # ── 3a. くっきり具合をそろえる（窓の元の大きさの分布を、クラスどうしで合わせる。大きいほうを縮める）──
    by_cls = {c: [j for j in jobs if j["cls"] == c] for c in (FOUR_LEAF, THREE_LEAF)}
    small, big = sorted(by_cls, key=lambda c: np.median([j["side"] for j in by_cls[c]]))
    ref_side = np.sort([j["side"] for j in by_cls[small]])
    for rank, j in enumerate(sorted(by_cls[big], key=lambda j: j["side"])):
        j["eff"] = min(j["side"], float(np.quantile(ref_side, (rank + 0.5) / len(by_cls[big]))))
        stats["くっきり具合をそろえるために縮めた窓"] += j["eff"] < j["side"]
    for c, name in ((FOUR_LEAF, "四つ葉の窓"), (THREE_LEAF, "三つ葉の窓")):
        e = [j["eff"] for j in by_cls[c]]
        print(f"  窓の元の大きさ（縮めたあと）: {name} 中央値 {np.median(e):.0f}px")

    # ── 3. 灰色の偏りをなくす（少ないほうのクラスの窓に、灰色の四角を足して、分布を合わせる）──
    print("\n■ 灰色の割合（外側の埋め＋目隠し）")
    gray_summary(jobs, "調整の前")
    by_cls = {c: [j for j in jobs if j["cls"] == c] for c in (FOUR_LEAF, THREE_LEAF)}
    low, high = sorted(by_cls, key=lambda c: np.mean([j["gray"] for j in by_cls[c]]))
    ref = np.sort([j["gray"] for j in by_cls[high]])
    for rank, j in enumerate(sorted(by_cls[low], key=lambda j: j["gray"])):
        target = float(np.quantile(ref, (rank + 0.5) / len(by_cls[low])))
        if j["gray"] < target:
            add_gray_squares(j, size_of(j["path"]), target, rng)
            stats["灰色の四角を足した窓"] += 1 if j["extra"] else 0
            stats["足した灰色の四角"] += len(j["extra"])
    gray_summary(jobs, "調整の後")

    # ── 4. 近道の検査 ──
    print("\n■ 近道の検査（窓の簡単な特徴だけで、四つ葉の窓か三つ葉の窓かを当てる）")
    auc = report_shortcut(jobs)
    if auc > SHORTCUT_AUC_LIMIT:
        print(f"  → ⚠ AUC が {SHORTCUT_AUC_LIMIT} を超えたので、窓は書き出しませんでした（効いている特徴を直してください）")
        return

    # ── 5. 書き出し ──
    print("\n■ merged_core をコピー")
    if HARDNEG2B_DIR.exists():
        shutil.rmtree(HARDNEG2B_DIR)
    shutil.copytree(core, HARDNEG2B_DIR)
    print(f"■ 窓を切り出す（{len(jobs)} 枚）")
    out_img, out_lbl = HARDNEG2B_DIR / "train" / "images", HARDNEG2B_DIR / "train" / "labels"
    counts = Counter()
    current, image = None, None
    for j in sorted(jobs, key=lambda j: (str(j["path"]), j["name"])):
        if j["path"] != current:
            with Image.open(j["path"]) as im:
                image = im.convert("RGB")
            current = j["path"]
        canvas, boxes = render_padded(image, j)
        canvas.save(out_img / f"{j['name']}.jpg", quality=95)
        write_label(out_lbl / f"{j['name']}.txt", boxes)
        group = "iNaturalist（三つ葉）" if j["name"].startswith("inat_") else (
            "core（四つ葉が目当て）" if j["cls"] == FOUR_LEAF else "core（三つ葉が目当て）")
        counts[(group, "窓")] += 1
        counts[(group, "four_leaf")] += sum(1 for b in boxes if b[0] == FOUR_LEAF)
        counts[(group, "three_leaf")] += sum(1 for b in boxes if b[0] == THREE_LEAF)
        counts[(group, "目隠し")] += len(j["masked"])
        counts[(group, "灰色の四角")] += len(j["extra"])

    print("\n■ merged_hardneg2b")
    for key, value in stats.items():
        print(f"  {key}: {value}")
    keys = ("窓", "four_leaf", "three_leaf", "目隠し", "灰色の四角")
    print("  " + "窓の種類".ljust(22) + "".join(k.rjust(12) for k in keys))
    total = Counter()
    for group in ("iNaturalist（三つ葉）", "core（四つ葉が目当て）", "core（三つ葉が目当て）"):
        row = [counts[(group, k)] for k in keys]
        total.update(dict(zip(keys, row)))
        print("  " + group.ljust(22) + "".join(str(v).rjust(12) for v in row))
    print("  " + "合計".ljust(22) + "".join(str(total[k]).rjust(12) for k in keys))
    for split in ("train", "valid"):
        print(f"  {split}: 画像 {len(list((HARDNEG2B_DIR / split / 'images').iterdir()))} 枚")
    (HARDNEG2B_DIR.parent / "merged_hardneg2b_windows.json").write_text(json.dumps(
        [{"name": j["name"], "cls": j["cls"], "gray": j["gray"], "side": j["side"], "dx": j["dx"], "dy": j["dy"],
          "frac": j["frac"]} for j in jobs], ensure_ascii=False), encoding="utf-8")

    print("\n■ 検査")
    test_paths = sorted(INAT_DIR / f for f in test)
    train_paths = sorted({j["path"] for j in jobs if j["name"].startswith("inat_")})
    valid_paths = sorted((HARDNEG2B_DIR / "valid" / "images").iterdir())
    dup_test = near_duplicates(test_paths, train_paths)
    dup_valid = near_duplicates(train_paths, valid_paths)
    print(f"  テスト専用の写真 {len(test_paths)} 枚のうち、学習に使う写真にほぼ同じものがある枚数: {dup_test}")
    print(f"  学習に使う iNaturalist の写真 {len(train_paths)} 枚のうち、valid にほぼ同じものがある枚数: {dup_valid}")
    print(f"  近道の検査の AUC: {auc:.3f}（{SHORTCUT_AUC_LIMIT} 以下で合格）")
    if dup_test or dup_valid or auc > SHORTCUT_AUC_LIMIT:
        print("  → ⚠ 検査で問題が見つかったので、zip は作りませんでした。")
        return
    shutil.make_archive(str(HARDNEG2B_DIR), "zip", root_dir=DATA_DIR, base_dir=HARDNEG2B_DIR.name)
    size = (DATA_DIR / "merged_hardneg2b.zip").stat().st_size / 1e6
    print(f"  → 検査に合格\n  zip を作成しました: data/merged_hardneg2b.zip（{size:.0f} MB）")


# このファイルを直接実行したときだけ動かす
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--hardneg", action="store_true", help="merged_hardneg を作る（merged_core を作ったあとで）")
    parser.add_argument("--hardneg2", action="store_true", help="merged_hardneg2 を作る（merged_core を作ったあとで）")
    parser.add_argument("--hardneg2b", action="store_true", help="merged_hardneg2b を作る（merged_core を作ったあとで）")
    args = parser.parse_args()
    if args.hardneg2b:
        make_hardneg2b()
    elif args.hardneg2:
        make_hardneg2()
    elif args.hardneg:
        make_hardneg()
    else:
        main()
