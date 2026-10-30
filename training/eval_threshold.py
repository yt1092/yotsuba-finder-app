"""
しきい値を変えたときの、誤検出と、本物の四つ葉の検出率を測る（「確かめる」なし。今のアプリの写真から探すと同じ）

    python training/eval_threshold.py public/models/yotsuba-v3.onnx data/models/yotsuba-v4.onnx

しくみ:
  - 写真ごとに、全体 1 回＋2×2 のタイル（80%）の枠を、低いしきい値（LOW = 0.20）で、まとめる前のまま保存する
  - しきい値 T の結果は、保存した枠から「スコアが T 以上」のものを選び、重なりをまとめて作る（T で判定し直すのと同じ）
  - 途中保存: 写真 1 枚ごとに data/eval_cache/raw-<モデルの名前>-<ハッシュ>.jsonl に足していく。止まっても、同じコマンドで続きから測る
  - 保存した枠は、training/calibrate.py（めやすの境目を決める）でも使う

測るもの（しきい値ごと・モデルごと）
  - three-leaves（100 枚）・iNaturalist のテスト専用（60 枚）・data/hardcases の、四つ葉の誤検出の数。IMG_1403 の数
  - 本物の四つ葉（training/eval_four_leaf_photos.json の 199 個）のうち、当たった数 ÷ 比べるもと（v2 の「全体＋タイル 60%」で当たる 131 個。
    eval_hardneg.py と同じ）
"""

import argparse
import json
from pathlib import Path

import numpy as np

import eval_hardneg as eh

LOW = 0.20
THRESHOLDS = [round(0.20 + 0.05 * i, 2) for i in range(7)]   # 0.20〜0.50
REFERENCE_HITS = 131    # 比べるもと（eval_hardneg.py の v2 の測定）
V3_FP = 63              # v3（しきい値 0.4）の three-leaves の誤検出


def raw_detect(detector, image):
    """全体＋タイル 80% の枠を、まとめずに返す（しきい値 LOW 以上）"""
    eh.THRESHOLD = LOW
    W, H = image.size
    dets = detector.region(image, 0, 0, W, H)
    tw, th = int(-(-W * eh.TILE_FRAC // 1)), int(-(-H * eh.TILE_FRAC // 1))
    for ty in (0, H - th):
        for tx in (0, W - tw):
            dets += detector.region(image, tx, ty, tw, th)
    return [{"box": [round(float(v), 2) for v in d["box"]], "cls": d["cls"], "score": d["score"]} for d in dets]


def at(raw, t):
    """しきい値 t のときの、まとめたあとの枠"""
    return eh.merge([{"box": tuple(d["box"]), "cls": d["cls"], "score": d["score"]} for d in raw if d["score"] >= t])


def collect(model_path, threads=0):
    """写真ごとの、まとめる前の枠（途中保存つき）"""
    detector = eh.Detector(model_path, threads)
    cache = eh.Cache(model_path)
    cache.path = cache.path.with_name("raw-" + cache.path.name)
    cache.items = {}
    if cache.path.exists():
        for line in cache.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                e = json.loads(line)
                cache.items[e["key"]] = e
    print(f"■ {model_path}\n  途中保存: {cache.path}（保存ずみ {len(cache.items)} 件）", flush=True)

    negatives = {}
    for name, paths in eh.negative_sets().items():
        negatives[name] = []
        for p in paths:
            key = "neg:" + p.relative_to(eh.DATA_DIR).as_posix()
            negatives[name].append(cache.get(key, lambda: {"raw": raw_detect(detector, eh.open_image(p))}))
        print(f"  {name}: {len(paths)} 枚", flush=True)

    positives = []
    for e in json.loads((eh.PROJECT_DIR / "training" / "eval_four_leaf_photos.json").read_text(encoding="utf-8")):
        def compute():
            image = eh.open_image(eh.DATA_DIR / "public" / e["img"])
            W, H = image.size
            return {"size": [W, H], "gts": [[x * W, y * H, w * W, h * H] for x, y, w, h in e["gt4"]],
                    "raw": raw_detect(detector, image)}
        positives.append(cache.get("pos:" + e["img"], compute))
    print(f"  本物の四つ葉の写真: {len(positives)} 枚", flush=True)
    return negatives, positives


def fours(raw, t):
    return [d for d in at(raw, t) if d["cls"] == eh.FOUR]


def measure(negatives, positives, t):
    row = {"threshold": t}
    for name, items in negatives.items():
        row[name] = sum(len(fours(e["raw"], t)) for e in items)
        if name.startswith("three-leaves"):
            row["IMG_1403"] = sum(len(fours(e["raw"], t)) for e in items if eh.HARD_PHOTO in e["key"])
    hits = sum(sum(any(eh.same_place(d["box"], tuple(g)) for d in fours(e["raw"], t)) for g in e["gts"]) for e in positives)
    row["hits"] = hits
    row["recall"] = hits / REFERENCE_HITS
    return row


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("models", nargs="+")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--out", default=str(eh.DATA_DIR / "eval_threshold.json"))
    args = ap.parse_args()

    out = {}
    three = "three-leaves（100 枚）"
    for m in args.models:
        negatives, positives = collect(m, args.threads)
        rows = [measure(negatives, positives, t) for t in THRESHOLDS]
        # three-leaves の誤検出が v3 と同じ数（63）以下で、いちばん低いしきい値（0.01 刻み）
        fine = [measure(negatives, positives, round(t, 2)) for t in np.arange(LOW, 0.51, 0.01)]
        match = next((r for r in fine if r[three] <= V3_FP), None)
        out[m] = {"rows": rows, "same_fp_as_v3": match}
        print(f"\n  しきい値 | three-leaves | IMG_1403 | iNaturalist | hardcases | 本物の四つ葉（{REFERENCE_HITS} 個に対して）")
        for r in rows:
            print(f"  {r['threshold']:.2f}     | {r[three]:>5} | {r.get('IMG_1403', '-'):>4} | {r.get('iNaturalist のテスト専用', '-'):>5}"
                  f" | {r.get('data/hardcases', '-'):>4} | {r['hits']}（{100 * r['recall']:.1f}%）")
        if match:
            print(f"  three-leaves の誤検出が {V3_FP} 以下になる、いちばん低いしきい値: {match['threshold']:.2f}"
                  f"（誤検出 {match[three]}・本物 {match['hits']}（{100 * match['recall']:.1f}%））")
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n結果: {args.out}")


if __name__ == "__main__":
    main()
