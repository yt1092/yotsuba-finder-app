"""
再学習したモデルを、アプリと同じ処理で評価する（パソコンで実行。学習データ・評価用の写真が data/ にある前提）

    pip install onnxruntime numpy pillow
    python training/eval_hardneg.py data/models/yotsuba-v2.onnx path/to/yotsuba_hardneg_hardneg2.onnx
    （v3 とも比べるときは、真ん中に public/models/yotsuba-v3.onnx を足す。合否は、最初と最後のモデルで見る）

v2 は配っていないので、Git の履歴から取り出す: git show 84a0386:public/models/yotsuba-v2.onnx > data/models/yotsuba-v2.onnx

いちばん最初に書いたモデル（ふつうは v2）を「比べるもと」にする。

測るもの（モデルごと）
  (b) 四つ葉の誤検出の数（「四つ葉がない」写真で、四つ葉として出た枠の数）
        - three-leaves の 100 枚（三つ葉だけの写真。評価専用）
        - iNaturalist のテスト専用の 60 枚（data/inat_negatives/split.csv の test）
        - data/hardcases/ の写真（あれば。評価専用）
      「確かめる前」= 写真から探すの検出（全体＋タイル 80%）の数。採用の目安の「必須」はこちら（three-leaves で 63 個以下）
      「確かめたあと」= アプリが四つ葉として出す数（自動で確かめて通ったもの。時間の上限なし）
  (c) 本物の四つ葉が残る割合（training/eval_four_leaf_photos.json: v2 の学習に使っていない写真 157 枚・正解の四つ葉 199 個）
      アプリが四つ葉として出す（確かめて通った）正解の数 ÷ 比べるもと（最初のモデル）の「全体＋タイル 60%・確かめなし」で
      当たった正解の数。README の「写真から探す」の節（v2 で 84.0%）と同じ測り方

アプリの処理（src/lib/onnx-detector.worker.ts・verify-run.ts・verify-crops.ts）を Python に写したもの:
  - 960×960 にレターボックス（灰色 114）、しきい値 0.4、いちばんスコアの高いクラスをラベルにする
  - 全体 1 回＋2×2 のタイル（元画像の 80%）の枠を合わせて、重なりをまとめる（IoU 0.5 超・小さいほうの重なり 0.6 以上）
  - 確かめる: 枠の長い辺が 20%・35%・50% になる正方形の切り抜き（最大 1280px）で 3 回判定し、
    同じ場所（IoU 0.3 以上・小さいほうの重なり 0.6 以上）に四つ葉が出た回数が 2 回以上なら通す。
    四つ葉の候補が 5 個を超える写真では 3 回とも
画像の縮め方（ブラウザの canvas と Pillow）の違いで、ブラウザでの測定と数が少しずれることがある。
  v2 での確かめ（2026-10-23）: three-leaves の誤検出 確かめる前 418 個（ブラウザ 412）・確かめたあと 176 個（ブラウザ 183）、
  iNaturalist のテスト専用 60 枚 111 個（ブラウザ 107）、本物の四つ葉が残る 110/131 = 84.0%（ブラウザと同じ）
かかる時間: この PC の CPU で、モデル 1 つあたり約 25 分
途中保存: 写真 1 枚ごとに、結果を data/eval_cache/<モデルの名前>-<ハッシュ>.jsonl に足していく。
  止まっても、同じコマンドをもう一度実行すれば、続きから測る（モデルの中身が変わると、ハッシュも変わるので、測り直しになる）。
  モデルごとに別々に実行して（並べて実行してもよい）、最後に全部を並べて実行すると、保存した結果だけで表を作る
"""

import argparse
import csv
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

PROJECT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_DIR / "data"

INPUT_SIZE = 960
PAD_VALUE = 114
THRESHOLD = 0.4                     # 写真のしきい値（SCORE_THRESHOLD.photo）
MERGE_IOU, MERGE_SMALLER, MAX_DETECTIONS = 0.5, 0.6, 100
TILE_FRAC = 0.8                     # 今のアプリのタイル
OLD_TILE_FRAC = 0.6                 # 比べるもと（以前のアプリ）のタイル
VERIFY_FRACTIONS = (0.2, 0.35, 0.5)
MAX_CROP_PX = 1280
SAME_IOU, SAME_SMALLER = 0.3, 0.6
MANY_CANDIDATES = 5
# 採用の目安（merged_hardneg2 で学習したモデル。v2 と比べる）
#   必須: three-leaves の四つ葉の誤検出（確かめる前）が THREE_LEAVES_FP_LIMIT 以下（v3 の 63 個から増えない）
#         ＋ valid の mAP50 が four_leaf で 0.01 以上、three_leaf で 0.03 以上、v2 から下がらない（ノートブックのセクション 7-3）
#   「確かめる」を使うための目安: 確かめたあと、本物の四つ葉が VERIFY_KEPT_GOAL 以上残り、
#         three-leaves の誤検出が VERIFY_FP_GOAL 以下。届かなければ、「確かめる」を機能ごと外すことを相談する
#   （merged_hardneg（v3）のときの目安: 必須 206 個以下、目標 90 個以下・84% から下がらない）
THREE_LEAVES_FP_LIMIT = 63
# 必須: 代わりの写真（three-leaves の IMG_1403。カタバミが一面に生えた写真）の誤検出（確かめる前）が、これより少ない（v3 は 12 本）
HARD_PHOTO = "IMG_1403"
HARD_PHOTO_FP_BELOW = 12
VERIFY_KEPT_GOAL = 0.90
VERIFY_FP_GOAL = 30
FOUR = 0


# ── 枠の計算（src/lib/box-utils.ts と同じ）── 枠は (x, y, w, h)

def inter(a, b):
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def iou(a, b):
    i = inter(a, b)
    return i / (a[2] * a[3] + b[2] * b[3] - i) if i > 0 else 0.0


def overlap_of_smaller(a, b):
    i = inter(a, b)
    s = min(a[2] * a[3], b[2] * b[3])
    return i / s if i > 0 and s > 0 else 0.0


def merge(dets):
    kept = []
    for d in sorted(dets, key=lambda d: -d["score"]):
        if all(not (iou(k["box"], d["box"]) > MERGE_IOU or overlap_of_smaller(k["box"], d["box"]) >= MERGE_SMALLER) for k in kept):
            kept.append(d)
        if len(kept) >= MAX_DETECTIONS:
            break
    return kept


def same_place(a, b):
    return iou(a, b) >= SAME_IOU or overlap_of_smaller(a, b) >= SAME_SMALLER


# ── 検出（src/lib/onnx-detector.worker.ts と同じ）──

class Detector:
    def __init__(self, path, threads=0):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        self._path, self._opts = str(path), opts
        self._session = None

    @property
    def session(self):
        # 全部の結果が途中保存にあるときは、モデルを読みこまない
        if self._session is None:
            self._session = ort.InferenceSession(self._path, self._opts, providers=["CPUExecutionProvider"])
        return self._session

    @property
    def input_name(self):
        return self.session.get_inputs()[0].name

    def region(self, image, rx, ry, rw, rh):
        """画像の一部を 960×960 にレターボックスして判定し、元画像の座標の枠を返す"""
        scale = min(INPUT_SIZE / rw, INPUT_SIZE / rh)
        dw, dh = round(rw * scale), round(rh * scale)
        pad_x, pad_y = (INPUT_SIZE - dw) // 2, (INPUT_SIZE - dh) // 2
        canvas = Image.new("RGB", (INPUT_SIZE, INPUT_SIZE), (PAD_VALUE,) * 3)
        canvas.paste(image.crop((rx, ry, rx + rw, ry + rh)).resize((dw, dh), Image.BILINEAR), (pad_x, pad_y))
        x = (np.asarray(canvas, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]
        out = self.session.run(None, {self.input_name: x})[0][0]  # 6 × 18900
        scores = out[4:]
        cls = scores.argmax(axis=0)
        best = scores.max(axis=0)
        found = []
        for i in np.nonzero(best >= THRESHOLD)[0]:
            cx, cy, w, h = out[:4, i]
            x0 = max(0.0, rx + (cx - w / 2 - pad_x) / scale)
            y0 = max(0.0, ry + (cy - h / 2 - pad_y) / scale)
            x1 = min(image.width, rx + (cx + w / 2 - pad_x) / scale)
            y1 = min(image.height, ry + (cy + h / 2 - pad_y) / scale)
            if x1 <= x0 or y1 <= y0:
                continue
            found.append({"box": (x0, y0, x1 - x0, y1 - y0), "cls": int(cls[i]), "score": float(best[i])})
        return found

    def detect(self, image, tile_frac=None):
        """全体 1 回（tile_frac があれば、2×2 のタイルも）を判定して、重なりをまとめる"""
        W, H = image.size
        dets = self.region(image, 0, 0, W, H)
        if tile_frac:
            tw, th = -(-W * tile_frac // 1), -(-H * tile_frac // 1)
            tw, th = int(tw), int(th)
            for ty in (0, H - th):
                for tx in (0, W - tw):
                    dets += self.region(image, tx, ty, tw, th)
        return merge(dets)

    def verify(self, image, box, needed):
        """「確かめる」: 3 通りの大きさの切り抜きで判定し、その場所で四つ葉が出た回数が needed 以上なら True"""
        x, y, w, h = box
        cx, cy, side = x + w / 2, y + h / 2, max(w, h)
        hits = 0
        for k, f in enumerate(VERIFY_FRACTIONS):
            size = side / f
            out = min(round(size), MAX_CROP_PX)
            s = out / size
            left, top = cx - size / 2, cy - size / 2
            # 切り抜き（はみ出した所は灰色）。canvas の drawImage と同じく、全体を s 倍にして貼る
            canvas = Image.new("RGB", (out, out), (PAD_VALUE,) * 3)
            src = (max(0, int(left)), max(0, int(top)), min(image.width, int(left + size) + 1), min(image.height, int(top + size) + 1))
            if src[2] > src[0] and src[3] > src[1]:
                piece = image.crop(src)
                pw, ph = max(1, round(piece.width * s)), max(1, round(piece.height * s))
                canvas.paste(piece.resize((pw, ph), Image.BILINEAR), (round((src[0] - left) * s), round((src[1] - top) * s)))
            target = ((x - left) * s, (y - top) * s, w * s, h * s)
            if any(d["cls"] == FOUR and same_place(d["box"], target) for d in self.detect(canvas)):
                hits += 1
            if hits >= needed or (k + 1 - hits) > len(VERIFY_FRACTIONS) - needed:
                break  # 答えが決まったら、残りは判定しない（結果は同じ）
        return hits >= needed


def open_image(path):
    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).convert("RGB")


def app_result(detector, image):
    """アプリの「写真から探す」: 検出（全体＋タイル 80%）→ 四つ葉の候補を全部確かめる（時間の上限なし）"""
    dets = detector.detect(image, TILE_FRAC)
    fours = sorted((d for d in dets if d["cls"] == FOUR), key=lambda d: -d["score"])
    needed = 3 if len(fours) > MANY_CANDIDATES else 2
    confirmed = [d for d in fours if detector.verify(image, d["box"], needed)]
    return fours, confirmed


# ── 評価する写真 ──

def negative_sets():
    """「四つ葉がない」写真の組: 名前 → 写真の一覧"""
    sets = {"three-leaves（100 枚）": sorted((DATA_DIR / "public" / "three-leaves").glob("*/images/*"))}
    split = DATA_DIR / "inat_negatives" / "split.csv"
    if split.exists():
        with open(split, encoding="utf-8") as f:
            sets["iNaturalist のテスト専用"] = [DATA_DIR / "inat_negatives" / r["file"] for r in csv.DictReader(f) if r["split"] == "test"]
    hard = sorted(p for p in (DATA_DIR / "hardcases").glob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
    if hard:
        sets["data/hardcases"] = hard
    return sets


class Cache:
    """写真 1 枚ごとの結果の途中保存（1 行 1 枚の JSON）"""

    def __init__(self, model_path):
        digest = hashlib.sha256(Path(model_path).read_bytes()).hexdigest()[:12]
        self.path = DATA_DIR / "eval_cache" / f"{Path(model_path).stem}-{digest}.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.items = {}
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    e = json.loads(line)
                    self.items[e["key"]] = e

    def get(self, key, compute):
        if key not in self.items:
            e = {"key": key, **compute()}
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
            self.items[key] = e
        return self.items[key]


def evaluate(model_path, reference_hits=None, threads=0):
    detector = Detector(model_path, threads)
    cache = Cache(model_path)
    print(f"  途中保存: {cache.path}（保存ずみ {len(cache.items)} 件）")
    result = {"model": str(model_path)}
    t0 = time.time()

    def negative(p):
        fours, confirmed = app_result(detector, open_image(p))
        return {"before": len(fours), "after": len(confirmed)}

    for name, paths in negative_sets().items():
        before = after = 0
        per_photo = {}
        for p in paths:
            e = cache.get("neg:" + p.relative_to(DATA_DIR).as_posix(), lambda: negative(p))
            before += e["before"]
            after += e["after"]
            per_photo[p.name] = {"before": e["before"], "after": e["after"]}
            if HARD_PHOTO in p.name:
                result["IMG_1403"] = {"before": e["before"], "after": e["after"]}
        result[name] = {"photos": len(paths), "before": before, "after": after}
        if name == "data/hardcases":
            result[name]["per_photo"] = per_photo
        print(f"  {name}: 写真 {len(paths)} 枚 / 四つ葉の誤検出 確かめる前 {before} 個・確かめたあと {after} 個（{time.time() - t0:.0f} 秒）")
    if "IMG_1403" in result:
        print(f"  代わりの写真（{HARD_PHOTO}）: 四つ葉の誤検出 確かめる前 {result['IMG_1403']['before']} 本・確かめたあと {result['IMG_1403']['after']} 本")

    photos = json.loads((PROJECT_DIR / "training" / "eval_four_leaf_photos.json").read_text(encoding="utf-8"))

    def positive(e):
        image = open_image(DATA_DIR / "public" / e["img"])
        W, H = image.size
        gts = [(x * W, y * H, w * W, h * H) for x, y, w, h in e["gt4"]]
        fours, confirmed = app_result(detector, image)
        # 比べるもと: 全体＋タイル 60%・確かめなし（最初のモデルで使う。どのモデルでも保存しておく）
        old = [d for d in detector.detect(image, OLD_TILE_FRAC) if d["cls"] == FOUR]
        return {"total": len(gts),
                "before": sum(any(same_place(d["box"], g) for d in fours) for g in gts),
                "after": sum(any(same_place(d["box"], g) for d in confirmed) for g in gts),
                "old": sum(any(same_place(d["box"], g) for d in old) for g in gts)}

    total = hit_before = hit_after = old_hits = 0
    for e in photos:
        r = cache.get("pos:" + e["img"], lambda: positive(e))
        total += r["total"]
        hit_before += r["before"]
        hit_after += r["after"]
        old_hits += r["old"]
    reference_hits = reference_hits or old_hits
    result["four_leaf"] = {"total": total, "before": hit_before, "after": hit_after, "reference": reference_hits,
                           "kept": hit_after / reference_hits if reference_hits else 0.0,
                           "kept_no_verify": hit_before / reference_hits if reference_hits else 0.0}
    print(f"  本物の四つ葉 {total} 個: 確かめる前に当たった {hit_before} 個・確かめたあと残った {hit_after} 個"
          f"（比べるもと {reference_hits} 個に対して 確かめなし {100 * hit_before / reference_hits:.1f}%・"
          f"確かめたあと {100 * hit_after / reference_hits:.1f}%）（{time.time() - t0:.0f} 秒）")
    return result, reference_hits


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("models", nargs="+", help="ONNX のモデル（最初のものを、比べるもとにする。ふつうは v2）")
    ap.add_argument("--out", default=str(DATA_DIR / "eval_hardneg.json"), help="結果を保存する JSON")
    ap.add_argument("--threads", type=int, default=0, help="計算に使うスレッドの数（0 = おまかせ。並べて実行するときに減らす）")
    args = ap.parse_args()

    results, reference = [], None
    for m in args.models:
        print(f"■ {m}")
        r, reference = evaluate(m, reference, args.threads)
        results.append(r)
    Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    if len(results) >= 2:
        base, new = results[0], results[-1]
        key = "three-leaves（100 枚）"
        before, after, kept = new[key]["before"], new[key]["after"], new["four_leaf"]["kept"]

        def ok(good):
            return "合格" if good else "不合格"

        ref = new["four_leaf"]["reference"]
        kept_no_verify = new["four_leaf"]["before"] / ref if ref else 0.0
        print("\n■ 採用の目安 — 必須（1 つでも不合格なら採用しない）")
        print(f"  three-leaves の四つ葉の誤検出（確かめる前）: {base[key]['before']} → {before} 個"
              f"（{THREE_LEAVES_FP_LIMIT} 個以下）→ {ok(before <= THREE_LEAVES_FP_LIMIT)}")
        hard = new.get("IMG_1403", {}).get("before")
        if hard is not None:
            print(f"  代わりの写真（{HARD_PHOTO}）の誤検出（確かめる前）: {base.get('IMG_1403', {}).get('before')} → {hard} 本"
                  f"（{HARD_PHOTO_FP_BELOW} 本より少ない）→ {ok(hard < HARD_PHOTO_FP_BELOW)}")
        print("  valid の mAP50（four_leaf は 0.01 以上、three_leaf は 0.03 以上、v2 から下がらない）→ ノートブックのセクション 7-3 で見る")
        print(f"  （参考）確かめないときの、本物の四つ葉が残る割合: {100 * kept_no_verify:.1f}%")
        print("■ 「確かめる」を使うための目安（届かなければ、「確かめる」を機能ごと外すことを相談する）")
        print(f"  確かめたあと、本物の四つ葉が残る割合: {100 * base['four_leaf']['kept']:.1f}% → {100 * kept:.1f}%"
              f"（{100 * VERIFY_KEPT_GOAL:.0f}% 以上）→ {ok(round(kept, 3) >= VERIFY_KEPT_GOAL)}")
        print(f"  確かめたあと、three-leaves の四つ葉の誤検出: {base[key]['after']} → {after} 個"
              f"（{VERIFY_FP_GOAL} 個以下）→ {ok(after <= VERIFY_FP_GOAL)}")
    print(f"\n結果: {args.out}")


if __name__ == "__main__":
    main()
