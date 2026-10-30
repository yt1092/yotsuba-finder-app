"""
推論時の水増し（TTA）: 左右反転した写真でも判定して、結果を合わせると、誤検出が減るかを測る（写真から探すだけ。確かめない）

    python training/eval_tta.py public/models/yotsuba-v3.onnx

  - 元の写真の枠は、training/eval_threshold.py の途中保存（しきい値 0.20・まとめる前）を使う
  - 反転した写真の枠も、同じく写真 1 枚ごとに data/eval_cache/rawflip-<モデル>-<ハッシュ>.jsonl に保存する（続きから再開できる）
    どの判定（全体・タイル 4 枚）の枠かも残す（「全体だけ反転」も試すため）
  合わせ方（しきい値は 0.4。最後に、今と同じく重なりをまとめる）
    both … 両方で見つかった枠だけ残す（反転のほうにも、同じ場所・同じラベルの枠がある。スコアは元のまま）
    mean … 同じ場所の枠のスコアを平均する。片方にしか無ければ、もう片方は 0 とする
    max  … 両方の枠を全部まとめる（同じ場所なら、高いほうが残る）
  「全体だけ」… 反転は、全体の 1 回だけ（タイルは反転しない）。判定の回数が 5 → 6 回で済む
採用の目安: three-leaves の誤検出が 20% 以上減る・本物の四つ葉の検出率の下がりが 1 ポイント以内・写真 1 枚の時間が 2 倍以内
"""

import argparse
import json
import time

from PIL import Image

import eval_hardneg as eh
import eval_threshold as et

T = 0.4
PAIR_IOU = 0.5


def regions_raw(detector, image):
    """全体＋タイル 80% の枠（しきい値 LOW 以上）を、判定ごとに返す"""
    eh.THRESHOLD = et.LOW
    W, H = image.size
    out = [detector.region(image, 0, 0, W, H)]
    tw, th = int(-(-W * eh.TILE_FRAC // 1)), int(-(-H * eh.TILE_FRAC // 1))
    for ty in (0, H - th):
        for tx in (0, W - tw):
            out.append(detector.region(image, tx, ty, tw, th))
    return out


def flipped_raw(detector, path):
    image = eh.open_image(path)
    W = image.width
    t0 = time.perf_counter()
    regions = regions_raw(detector, image.transpose(Image.FLIP_LEFT_RIGHT))
    seconds = time.perf_counter() - t0
    back = []
    for i, dets in enumerate(regions):
        for d in dets:
            x, y, w, h = d["box"]
            back.append({"box": [round(float(W - x - w), 2), round(float(y), 2), round(float(w), 2), round(float(h), 2)],
                         "cls": d["cls"], "score": d["score"], "region": i})
    return {"raw": back, "seconds": seconds}


def merged(raw, t):
    return eh.merge([{"box": tuple(d["box"]), "cls": d["cls"], "score": d["score"]} for d in raw if d["score"] >= t])


def combine(orig, flip, how, full_only):
    if full_only:
        flip = [d for d in flip if d["region"] == 0]
    if how == "none":
        return merged(orig, T)
    if how == "max":
        return merged(orig + flip, T)
    a, b = merged(orig, et.LOW), merged(flip, et.LOW)
    if how == "both":
        return [d for d in a if d["score"] >= T and any(e["cls"] == d["cls"] and e["score"] >= T and eh.iou(e["box"], d["box"]) >= PAIR_IOU for e in b)]
    # mean: 同じ場所・同じラベルの枠を、スコアの高い順に 1 対 1 で組にする。組がなければ、もう片方は 0
    used, out = set(), []
    for d in a:
        best = max(((j, eh.iou(e["box"], d["box"])) for j, e in enumerate(b) if j not in used and e["cls"] == d["cls"]),
                   key=lambda x: x[1], default=(None, 0))
        if best[0] is not None and best[1] >= PAIR_IOU:
            used.add(best[0])
            out.append({**d, "score": (d["score"] + b[best[0]]["score"]) / 2})
        else:
            out.append({**d, "score": d["score"] / 2})
    out += [{**e, "score": e["score"] / 2} for j, e in enumerate(b) if j not in used]
    return eh.merge([d for d in out if d["score"] >= T])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    negatives, positives = et.collect(args.model, args.threads)
    detector = eh.Detector(args.model, args.threads)
    cache = eh.Cache(args.model)
    cache.path = cache.path.with_name("rawflip-" + cache.path.name)
    cache.items = {}
    if cache.path.exists():
        cache.items = {e["key"]: e for e in map(json.loads, filter(str.strip, cache.path.read_text(encoding="utf-8").splitlines()))}
    print(f"  反転の途中保存: {cache.path}（保存ずみ {len(cache.items)} 件）", flush=True)

    def flip_of(e):
        key = e["key"]
        path = eh.DATA_DIR / key[4:] if key.startswith("neg:") else eh.DATA_DIR / "public" / key[4:]
        return cache.get(key, lambda: flipped_raw(detector, path))["raw"]

    for name, items in negatives.items():
        for e in items:
            e["flip"] = flip_of(e)
        print(f"  {name}: 反転 {len(items)} 枚", flush=True)
    for e in positives:
        e["flip"] = flip_of(e)
    print(f"  本物の四つ葉の写真: 反転 {len(positives)} 枚", flush=True)

    # 時間: 元の判定（5 回）と反転の判定を、同じ写真 20 枚で測る
    sample = [eh.DATA_DIR / "public" / e["key"][4:] for e in positives[:20]]
    t_orig = t_flip_full = t_flip_all = 0.0
    for p in sample:
        image = eh.open_image(p)
        t0 = time.perf_counter()
        regions_raw(detector, image)
        t_orig += time.perf_counter() - t0
        flipped = image.transpose(Image.FLIP_LEFT_RIGHT)
        t0 = time.perf_counter()
        detector.region(flipped, 0, 0, flipped.width, flipped.height)
        t_flip_full += time.perf_counter() - t0
        t0 = time.perf_counter()
        regions_raw(detector, flipped)
        t_flip_all += time.perf_counter() - t0
    time_ratio = {"all": 1 + t_flip_all / t_orig, "full_only": 1 + t_flip_full / t_orig}
    n = len(sample)
    print(f"  時間（20 枚の平均）: 今 {1000 * t_orig / n:.0f} ms・反転の全部 {1000 * t_flip_all / n:.0f} ms・反転の全体 1 回 {1000 * t_flip_full / n:.0f} ms"
          "（合わせる計算の時間は入れていない）", flush=True)

    three = "three-leaves（100 枚）"
    rows = []
    for full_only in (False, True):
        for how in ("none", "both", "mean", "max"):
            if how == "none" and full_only:
                continue
            row = {"how": how, "full_only": full_only}
            for name, items in negatives.items():
                row[name] = sum(sum(1 for d in combine(e["raw"], e["flip"], how, full_only) if d["cls"] == eh.FOUR) for e in items)
            row["IMG_1403"] = sum(sum(1 for d in combine(e["raw"], e["flip"], how, full_only) if d["cls"] == eh.FOUR)
                                  for e in negatives[three] if eh.HARD_PHOTO in e["key"])
            hits = 0
            for e in positives:
                fours = [d for d in combine(e["raw"], e["flip"], how, full_only) if d["cls"] == eh.FOUR]
                hits += sum(any(eh.same_place(d["box"], tuple(g)) for d in fours) for g in e["gts"])
            row["hits"], row["recall"] = hits, hits / et.REFERENCE_HITS
            row["time"] = 1.0 if how == "none" else time_ratio["full_only" if full_only else "all"]
            rows.append(row)
    base = rows[0]
    print(f"\n  合わせ方 | 反転 | three-leaves | IMG_1403 | iNaturalist | hardcases | 本物（{et.REFERENCE_HITS} 個に対して） | 時間 | 目安")
    for r in rows:
        fp_drop = 1 - r[three] / base[three]
        ok = r["how"] != "none" and fp_drop >= 0.2 and base["recall"] - r["recall"] <= 0.01 and r["time"] <= 2.0
        r["fp_drop"], r["pass"] = fp_drop, ok
        print(f"  {r['how']} | {'全体だけ' if r['full_only'] else ('全部' if r['how'] != 'none' else '-')} | {r[three]}（{-100 * fp_drop:+.0f}%）"
              f" | {r['IMG_1403']} | {r.get('iNaturalist のテスト専用')} | {r.get('data/hardcases')} | {r['hits']}（{100 * r['recall']:.1f}%）"
              f" | {r['time']:.2f} 倍 | {'○' if ok else ('-' if r['how'] == 'none' else '×')}")
    out = eh.DATA_DIR / "eval_tta.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n結果: {out}")


if __name__ == "__main__":
    main()
