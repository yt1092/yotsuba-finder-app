"""
「今日のよつば」: 数式で、四つ葉のシルエット（64×64 の白黒）を大量に作る（学習データの候補。ネットの画像は使わない）

    python training/gacha_synth.py                  # 3,000 個
    python training/gacha_synth.py --n 300 --jitter 0.25   # 揺らぎを強く
    python training/gacha_synth.py --profile wide --seed 2 --out data/gacha/synthetic_wide   # 本物に合わせて範囲を広げた版（学習用）

形の式（極座標。θ は角度、r は中心からの距離）
  r(θ) = R · [ base + (1 − base) · |cos 2θ|^sharp ] · notch(θ) · (1 + Σ_{k=1..K} a_k · sin(kθ + φ_k))
  - |cos 2θ| … 4 枚の花びら（0・90・180・270 度に葉）
  - base … 葉と葉のあいだの、くびれの浅さ（大きいほど、まるく、くびれが浅い）
  - sharp … 葉の先のとがり方（小さいほど、ふっくら）
  - notch … 葉の先の、ハートのへこみ: 1 − depth · exp(−(葉の中心からの角度 / width)²)
  - 揺らぎ … 低い次数（k = 1〜K）の sin の和。a_k は [−jitter/k, jitter/k] から（次数が高いほど小さく）。
    葉ごとの大きさの差や、ゆがみになる
  - wide のときだけ: 葉ごとの大きさ（leaf0〜3）と、縦横比（aspect）も変える
  作った形は、実物と同じく、中心・向き・大きさをそろえる（gacha_shape.normalize）
幾何のチェック（gacha_shape.check）: 葉の数がちょうど 4・1 つにつながっている・穴がない・面積が範囲の中。
  通らなかった形は、理由ごとに数える
出力（data/ は Git に入れない）
  data/gacha/synthetic/<番号>.png（通った形だけ）
  data/gacha/synthetic/params.csv（通った形も、はじいた形も。式のパラメータと、結果・理由）
  data/gacha/synthetic/summary.json
"""

import argparse
import csv
import json
import math
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from gacha_shape import SIZE, check, normalize

OUT = Path(__file__).resolve().parent.parent / "data" / "gacha" / "synthetic"
SUPER = 8          # 8 倍の細かさで描いてから縮める（ふちをなめらかに）
POINTS = 720       # 輪郭の点の数


# 作り方の範囲。base = はじめの範囲（public/gacha の 60 個はこれ）・wide = 本物に合わせて広げた範囲（2026-10-27。学習用）
# 平均を本物に合わせるのではなく、はじめの範囲をふくんだまま、本物の側へ広げる（docs/reports/2026-10-27-gacha-final.md）
PROFILES = {
    "base": {"base_max": 0.40, "leaf_var": 0.0, "aspect_min": 1.0},
    "wide": {"base_max": 0.60, "leaf_var": 0.30, "aspect_min": 0.75},
}


def sample_params(rng: np.random.Generator, jitter: float, orders: int, profile: str = "base") -> dict:
    pr = PROFILES[profile]
    p = {
        "base": float(rng.uniform(0.05, pr["base_max"])),
        "sharp": float(rng.uniform(0.4, 2.0)),
        "notch_depth": float(rng.uniform(0.0, 0.35)),
        "notch_width_deg": float(rng.uniform(4.0, 12.0)),
        "rotation_deg": float(rng.uniform(0, 360)),
        "jitter": jitter,
    }
    for k in range(1, orders + 1):
        p[f"a{k}"] = float(rng.uniform(-jitter / k, jitter / k))
        p[f"phi{k}"] = float(rng.uniform(0, 2 * math.pi))
    if profile != "base":  # base のときは乱数を使わない（前と同じ形が出るように）
        lv = float(rng.uniform(0, pr["leaf_var"]))
        for j in range(4):
            p[f"leaf{j}"] = float(rng.uniform(-lv, lv))
        p["aspect"] = float(rng.uniform(pr["aspect_min"], 1.0))
    return p


def radius(theta: np.ndarray, p: dict, orders: int) -> np.ndarray:
    petals = p["base"] + (1 - p["base"]) * np.abs(np.cos(2 * theta)) ** p["sharp"]
    # 葉の中心（0・90・180・270 度）からの角度
    d = np.abs(((theta + math.pi / 4) % (math.pi / 2)) - math.pi / 4)
    notch = 1 - p["notch_depth"] * np.exp(-(d / math.radians(p["notch_width_deg"])) ** 2)
    wobble = 1 + sum(p[f"a{k}"] * np.sin(k * theta + p[f"phi{k}"]) for k in range(1, orders + 1))
    # 葉ごとの大きさ（leaf0〜3。0・90・180・270 度の葉。葉の中だけに効く窓 cos(2Δ)² で、なめらかに）。無ければ 1
    leaf = 1 + sum(p.get(f"leaf{j}", 0.0) * np.clip(np.cos(2 * (theta - j * math.pi / 2)), 0, None) ** 2 for j in range(4))
    return np.clip(petals * notch * wobble * leaf, 0, None)


def render(p: dict, orders: int) -> np.ndarray:
    theta = np.linspace(0, 2 * math.pi, POINTS, endpoint=False)
    r = radius(theta, p, orders)
    big = SIZE * SUPER
    R = 0.45 * big / max(r.max(), 1e-6)
    # 縦横比（aspect。無ければ 1）: 形の向きのまま縦に縮めてから、全体を回す
    x0, y0 = r * np.cos(theta), p.get("aspect", 1.0) * r * np.sin(theta)
    a = math.radians(p["rotation_deg"])
    xs, ys = x0 * math.cos(a) - y0 * math.sin(a), x0 * math.sin(a) + y0 * math.cos(a)
    pts = np.stack([big / 2 + R * xs, big / 2 + R * ys], 1).round().astype(np.int32)
    canvas = np.zeros((big, big), np.uint8)
    cv2.fillPoly(canvas, [pts], 1)
    small = cv2.resize(canvas.astype(np.float32), (SIZE, SIZE), interpolation=cv2.INTER_AREA)
    m = (small >= 0.5).astype(np.uint8)
    return normalize(m) if m.any() else m


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=3000)
    ap.add_argument("--jitter", type=float, default=0.15, help="揺らぎの強さ（a_k の範囲。0 で揺らぎなし）")
    ap.add_argument("--orders", type=int, default=4, help="揺らぎの sin の次数の上限 K")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--profile", choices=list(PROFILES), default="base", help="作り方の範囲（base = はじめ・wide = 広げた範囲）")
    ap.add_argument("--out", type=Path, default=OUT, help="出力のフォルダ（前の実行の PNG は、先に消す）")
    args = ap.parse_args()
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.png"):  # 前の実行の形が、残らないように
        old.unlink()
    rng = np.random.default_rng(args.seed)
    rows, reasons, passed = [], Counter(), 0
    for i in range(1, args.n + 1):
        p = sample_params(rng, args.jitter, args.orders, args.profile)
        m = render(p, args.orders)
        why = check(m)
        if why:
            for w in why:
                reasons[w] += 1
        else:
            passed += 1
            Image.fromarray(m * 255).save(out / f"{i:05d}.png")
        rows.append({"id": f"{i:05d}", **{k: round(v, 5) if isinstance(v, float) else v for k, v in p.items()},
                     "result": "通った" if not why else "はじいた", "reasons": "・".join(why)})
    with (out / "params.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    summary = {"n": args.n, "passed": passed, "rejected": args.n - passed, "reasons": dict(reasons),
               "jitter": args.jitter, "orders": args.orders, "seed": args.seed, "profile": args.profile}
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"作った {args.n} 個: 通った {passed}（{100 * passed / args.n:.1f}%）・はじいた {args.n - passed}（{100 * (args.n - passed) / args.n:.1f}%）")
    print("はじいた理由（1 つの形に、いくつも当てはまることがある）:", dict(reasons))


if __name__ == "__main__":
    main()
