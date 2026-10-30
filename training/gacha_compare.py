"""
「今日のよつば」: 作った形（数式・あとで DiT）と、実物の形（reference-stats.csv）の、特徴の分布を並べて比べる

    python training/gacha_compare.py                                   # data/gacha/synthetic と比べる
    python training/gacha_compare.py --gen data/gacha/dit-samples --name dit

出力（開発用。数字はこの報告の中だけで使い、アプリの画面には出さない）
  実物は reference-stats.csv の judge が ○ の行だけ
  data/gacha/compare-<name>.png … 特徴ごとの分布（青 = 実物・橙 = 作った形。葉の数は棒、ほかは折れ線のヒストグラム）
  data/gacha/compare-<name>.csv … 特徴ごとの 平均・中央値・10%点・90%点（実物と作った形）と、2 つの分布の差（KS 距離。0〜1。小さいほど近い）
"""

import argparse
import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from gacha_reference import FEATURES, G, load_mask  # noqa: E402
from gacha_shape import features  # noqa: E402

LABELS = {"area_ratio": "面積（64×64 に対する割合）", "perimeter": "周囲の長さ（px）", "compactness": "まるさ（4π面積/周囲²）",
          "lobes": "葉の数", "sym4": "4 回の対称性（IoU）", "depth": "葉のあいだの深さ（最小/最大の距離）"}
REAL, GEN = "#2a78d6", "#eb6834"   # 色の決まり（dataviz の分類の色 1・2。色だけに頼らず、凡例と表も出す）
INK, MUTED, SURFACE = "#2F4A35", "#7a8a7d", "#fcfcfb"


def ks(a: np.ndarray, b: np.ndarray) -> float:
    """2 つの標本の、累積分布のいちばん大きな差（コルモゴロフ–スミルノフの距離）"""
    xs = np.sort(np.concatenate([a, b]))
    ca = np.searchsorted(np.sort(a), xs, side="right") / len(a)
    cb = np.searchsorted(np.sort(b), xs, side="right") / len(b)
    return float(np.max(np.abs(ca - cb)))


def summarize(real: dict, gen: dict) -> list[dict]:
    rows = []
    for k in FEATURES:
        a, b = real[k], gen[k]
        row = {"feature": k}
        for tag, v in (("real", a), ("gen", b)):
            row.update({f"{tag}_mean": np.mean(v), f"{tag}_median": np.median(v),
                        f"{tag}_p10": np.percentile(v, 10), f"{tag}_p90": np.percentile(v, 90)})
        row["ks"] = ks(a, b)
        if k == "lobes":
            row["real_four"] = float(np.mean(a == 4))
            row["gen_four"] = float(np.mean(b == 4))
        rows.append({kk: round(float(vv), 4) if not isinstance(vv, str) else vv for kk, vv in row.items()})
    return rows


def plot(real: dict, gen: dict, name: str, n_real: int, n_gen: int, path: Path):
    plt.rcParams["font.family"] = ["Meiryo", "Yu Gothic", "sans-serif"]
    fig, axes = plt.subplots(2, 3, figsize=(13, 7.5), facecolor=SURFACE)
    for ax, k in zip(axes.flat, FEATURES):
        ax.set_facecolor(SURFACE)
        a, b = real[k], gen[k]
        if k == "lobes":
            vals = np.arange(0, 9)
            ra = [np.mean(a == v) for v in vals]
            gb = [np.mean(b == v) for v in vals]
            ax.bar(vals - 0.2, ra, 0.38, color=REAL, label=f"実物（{n_real}）", edgecolor=SURFACE, linewidth=2)
            ax.bar(vals + 0.2, gb, 0.38, color=GEN, label=f"作った形（{n_gen}）", edgecolor=SURFACE, linewidth=2)
            ax.set_xticks(vals)
        else:
            lo, hi = min(a.min(), b.min()), max(a.max(), b.max())
            bins = np.linspace(lo, hi, 25)
            ax.hist(a, bins, density=True, histtype="step", color=REAL, linewidth=2, label=f"実物（{n_real}）")
            ax.hist(b, bins, density=True, histtype="step", color=GEN, linewidth=2, label=f"作った形（{n_gen}）")
            ax.set_yticks([])
        ax.set_title(f"{LABELS[k]}   KS {ks(a, b):.2f}", color=INK, fontsize=11)
        ax.tick_params(colors=MUTED, labelsize=9)
        for s in ("top", "right", "left"):
            ax.spines[s].set_visible(False)
        ax.spines["bottom"].set_color(MUTED)
    axes.flat[0].legend(frameon=False, fontsize=9, labelcolor=INK)
    fig.suptitle(f"特徴の分布: 実物 と 作った形（{name}）", color=INK, fontsize=13)
    fig.tight_layout()
    fig.savefig(path, dpi=110, facecolor=SURFACE)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gen", type=Path, default=G / "synthetic", help="作った形の PNG のフォルダ")
    ap.add_argument("--name", default="synthetic")
    ap.add_argument("--reference", type=Path, default=G / "reference-stats.csv")
    args = ap.parse_args()
    with args.reference.open(encoding="utf-8") as f:
        ref = [r for r in csv.DictReader(f) if r.get("judge", "○") == "○"]  # ？ は基準に入れない
    real = {k: np.array([float(r[k]) for r in ref]) for k in FEATURES}
    feats = [features(load_mask(p)) for p in sorted(args.gen.glob("*.png"))]
    gen = {k: np.array([float(f[k]) for f in feats]) for k in FEATURES}
    rows = summarize(real, gen)
    out_csv = G / f"compare-{args.name}.csv"
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        fields = list(dict.fromkeys(k for r in rows for k in r))
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    plot(real, gen, args.name, len(ref), len(feats), G / f"compare-{args.name}.png")
    for r in rows:
        print(f"{r['feature']}: 実物 中央値 {r['real_median']}（{r['real_p10']}〜{r['real_p90']}）・"
              f"作った形 {r['gen_median']}（{r['gen_p10']}〜{r['gen_p90']}）・KS {r['ks']}"
              + (f"・4 本の割合 実物 {r['real_four']} / 作った形 {r['gen_four']}" if r["feature"] == "lobes" else ""))
    print(f"図: {G / f'compare-{args.name}.png'}　表: {out_csv}")


if __name__ == "__main__":
    main()
