"""
「今日のよつば」: 葉の数が 4 にならなかった形の、原因を 1 枚ずつ見る図を作る

    python training/gacha_lobe_check.py                 # ○（gacha_reference_pick.json の use）のうち、4 と数えなかったもの
    python training/gacha_lobe_check.py --numbers 9,10  # 番号を指定（review-index.csv の番号）

1 行 = 1 つの形。左から:
  1. 元の切り抜き（data/gacha/crops）
  2. マスク。重心から、残った谷（葉の境目）へ赤い線、まとめた谷（浅いとみなした谷）へ灰色の点線、残った山（葉の先）へ緑の線
  3. 角度ごとの距離（なめらかにしたもの）。谷ごとに「谷の比」（谷の距離 ÷ 両側の山の低いほう）を書く。
     0.90（gacha_shape.VALLEY_RATIO）未満が境目。赤 = 境目として残った谷・灰色 = まとめた谷
出力: data/gacha/lobe-check.png（Git の対象外）と、標準出力（谷の比の一覧）
"""

import argparse
import csv
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import gacha_shape as sh  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
G = ROOT / "data" / "gacha"
INK, MUTED, KEEP, MERGED, PEAK = "#2F4A35", "#9aa79c", "#d63b3b", "#9aa79c", "#2e9b4e"


def angle_of(i: int) -> float:
    return (i + 0.5) / sh.BINS * 2 * math.pi - math.pi  # radial_profile の角度の区間 → 角度


def raw_valleys(m):
    """まとめる前の、すべての谷（谷の比を見るため）"""
    old = sh.VALLEY_RATIO
    sh.VALLEY_RATIO = float("inf")
    try:
        return sh.lobe_details(m)[2]
    finally:
        sh.VALLEY_RATIO = old


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--numbers", help="番号（カンマ区切り）")
    ap.add_argument("--out", type=Path, default=G / "lobe-check.png")
    args = ap.parse_args()
    with (G / "review-index.csv").open(encoding="utf-8") as f:
        ids = {int(r["number"]): r["id"] for r in csv.DictReader(f)}
    load = lambda n: (np.asarray(Image.open(G / "masks" / f"{ids[n]}.png").convert("L")) >= 128).astype(np.uint8)
    if args.numbers:
        numbers = [int(n) for n in args.numbers.split(",")]
    else:
        pick = json.loads((Path(__file__).resolve().parent / "gacha_reference_pick.json").read_text(encoding="utf-8"))
        numbers = [n for n in pick["use"] if sh.count_lobes(load(n)) != 4]

    plt.rcParams["font.family"] = ["Meiryo", "Yu Gothic", "sans-serif"]
    fig, axes = plt.subplots(len(numbers), 3, figsize=(12, 3.3 * len(numbers)), gridspec_kw={"width_ratios": [1, 1, 2.2]}, squeeze=False)
    for row, n in zip(axes, numbers):
        m = load(n)
        p, peaks, valleys = sh.lobe_details(m)
        kept = {i for i, _, _ in valleys}
        allv = raw_valleys(m)
        ys, xs = np.nonzero(m)
        cy, cx = ys.mean(), xs.mean()
        row[0].imshow(Image.open(G / "crops" / f"{ids[n]}.jpg"))
        row[0].set_title(f"{n}（{ids[n]}）　葉の数 {sh.count_lobes(m)}", color=INK, fontsize=11)
        row[1].imshow(1 - m, cmap="gray", vmin=0, vmax=1)
        for i, v, _ in allv:
            a = angle_of(i)
            style = dict(color=KEEP, lw=2) if i in kept else dict(color=MERGED, lw=1.5, ls=":")
            row[1].plot([cx, cx + v * math.cos(a)], [cy, cy + v * math.sin(a)], **style)
        for i, v in peaks:
            a = angle_of(i)
            row[1].plot([cx, cx + v * math.cos(a)], [cy, cy + v * math.sin(a)], color=PEAK, lw=1.5)
        row[1].set_title("赤 = 境目・灰 = まとめた谷・緑 = 葉の先", color=INK, fontsize=9)
        deg = np.degrees([angle_of(i) for i in range(len(p))])
        row[2].plot(deg, p, color=INK, lw=1.5)
        for i, v, r in allv:
            c = KEEP if i in kept else MERGED
            row[2].plot(np.degrees(angle_of(i)), v, "o", color=c, ms=7)
            row[2].annotate(f"{r:.2f}", (np.degrees(angle_of(i)), v), textcoords="offset points", xytext=(0, -16), ha="center", fontsize=9, color=c)
        row[2].set_ylim(0, p.max() * 1.1)
        row[2].set_xlim(-180, 180)
        row[2].set_title(f"角度ごとの距離と、谷の比（{sh.VALLEY_RATIO:.2f} 未満が境目）", color=INK, fontsize=10)
        for s in ("top", "right"):
            row[2].spines[s].set_visible(False)
        for ax in row[:2]:
            ax.axis("off")
        print(f"{n}: 葉の数 {sh.count_lobes(m)}・谷の比（角度の順） " + "・".join(f"{r:.2f}{'*' if i in kept else ''}" for i, _, r in allv) + "（* = 境目として残った谷）")
    fig.tight_layout()
    fig.savefig(args.out, dpi=90)
    print(f"→ {args.out}")


if __name__ == "__main__":
    main()
