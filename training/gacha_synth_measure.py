"""
「今日のよつば」: 数式の形にも、本物と同じマスクの取り出し方を通して、特徴（谷の比・葉の大きさのばらつき・縦横比）を測り直す

    python training/gacha_synth_measure.py              # base と wide から 400 個ずつ

なぜ: 本物のマスクは、写真から取り出すときに、葉と葉のすき間が埋まり、丸くなる（docs/reports/2026-10-27-gacha-fix.md）。
  数式の形は、そのままの形なので、そのまま比べると、取り出し方のちがいまで「形のちがい」に見えてしまう。
やり方:
  1. 数式の形を、写真のような切り抜き（384px）に描く。背景は、緑の濃淡の、葉っぱのようなまだら模様（まわりの三つ葉の代わり）。
     葉の色は少しずつ変え、ふちに少し濃い線、明るさのむらを付ける。枠は葉の外側の四角（本物と同じく、切り抜きの 64%）
  2. 本物と同じ取り出し（gacha_masks_fix.py: GrabCut・穴を埋める・茎を取る・くっついた葉を切り分ける・64×64 にそろえる）を通す
  3. 取り出したマスクと、元の形の、両方の特徴を測る
  - 写真のまねは、本物の写真と同じではない（とくに、葉が重なって写ることは、まねしていない）。取り出しのくせを、だいたい見るためのもの
出力: data/gacha/synth-measure.json・data/gacha/synth-measure.png（Git の対象外）
"""

import json
import random
from pathlib import Path

import cv2
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import gacha_shape as sh  # noqa: E402
from gacha_baseline import METRICS, real_rows, wquant  # noqa: E402
from gacha_masks_fix import WORK, cut_merged, fill_holes, remove_stem  # noqa: E402
from gacha_masks import CROP_MARGIN, segment  # noqa: E402

G = Path(__file__).resolve().parent.parent / "data" / "gacha"
N = 400
SEED = 5
SHOW = ["valley_mean", "valley_max", "leaf_cv", "aspect"]
LABELS = {"valley_mean": "谷の比の平均", "valley_max": "いちばん浅い谷の比", "leaf_cv": "葉の大きさのばらつき", "aspect": "縦横比", "tip_cv": "葉の先の遠さのばらつき"}


def photo_like(m64: np.ndarray, rng: np.random.Generator) -> tuple[np.ndarray, tuple]:
    """数式の形を、写真のような切り抜きに描く（BGR・WORK px）と、枠"""
    # 背景: 緑の濃淡のまだら（大きさのちがう円をたくさん置いて、ぼかす）
    hsv = np.zeros((WORK, WORK, 3), np.float32)
    hsv[..., 0] = rng.uniform(38, 50)
    hsv[..., 1] = rng.uniform(110, 170)
    hsv[..., 2] = rng.uniform(60, 100)
    for _ in range(140):
        c = (int(rng.integers(0, WORK)), int(rng.integers(0, WORK)))
        r = int(rng.integers(8, 40))
        col = (float(rng.uniform(35, 55)), float(rng.uniform(90, 200)), float(rng.uniform(50, 170)))
        cv2.circle(hsv, c, r, col, -1)
    hsv = cv2.GaussianBlur(hsv, (0, 0), 3)
    # 葉: 64×64 の形を、なめらかに大きくする（葉の外側の四角が、切り抜きの 64%）
    ys, xs = np.nonzero(m64)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    side = WORK * (1 - 2 * CROP_MARGIN)
    s = side / max(x1 - x0, y1 - y0)
    leaf = cv2.resize(m64[y0:y1, x0:x1].astype(np.float32), (max(1, int((x1 - x0) * s)), max(1, int((y1 - y0) * s))), interpolation=cv2.INTER_CUBIC)
    leaf = (cv2.GaussianBlur(leaf, (0, 0), s / 3) >= 0.5).astype(np.uint8)
    ox, oy = (WORK - leaf.shape[1]) // 2, (WORK - leaf.shape[0]) // 2
    mask = np.zeros((WORK, WORK), np.uint8)
    mask[oy:oy + leaf.shape[0], ox:ox + leaf.shape[1]] = leaf
    shade = cv2.GaussianBlur(rng.uniform(-25, 25, (WORK // 32, WORK // 32)).astype(np.float32), (0, 0), 1)
    shade = cv2.resize(shade, (WORK, WORK), interpolation=cv2.INTER_CUBIC)
    lh, ls, lv = rng.uniform(38, 52), rng.uniform(120, 200), rng.uniform(120, 200)
    inside = mask == 1
    hsv[inside, 0] = lh
    hsv[inside, 1] = ls
    hsv[inside, 2] = np.clip(lv + shade[inside], 0, 255)
    edge = (mask - cv2.erode(mask, np.ones((5, 5), np.uint8))) == 1
    hsv[edge, 2] *= 0.7
    bgr = cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2BGR)
    noise = rng.normal(0, 6, bgr.shape)
    bgr = np.clip(bgr + noise, 0, 255).astype(np.uint8)
    return bgr, (ox, oy, leaf.shape[1], leaf.shape[0])


def extract(crop: np.ndarray, rect) -> np.ndarray:
    """本物と同じ取り出し（gacha_masks_fix.py の main と同じ順）"""
    m = fill_holes(segment(crop, rect))
    m, _ = remove_stem(m)
    m, _ = cut_merged(m, crop)
    return sh.normalize(fill_holes(m))


def measure(folder: Path, rng: np.random.Generator) -> tuple[list[dict], list[dict]]:
    paths = sorted(folder.glob("*.png"))
    random.Random(SEED).shuffle(paths)
    raw, ext = [], []
    for p in paths[:N]:
        m = (np.asarray(Image.open(p).convert("L")) >= 128).astype(np.uint8)
        crop, rect = photo_like(m, rng)
        e = extract(crop, rect)
        raw.append({"lobes": sh.count_lobes(m), **sh.shape_metrics(m)})
        ext.append({"lobes": sh.count_lobes(e), **sh.shape_metrics(e)})
    return raw, ext


def stats(rows: list[dict], w=None) -> dict:
    w = np.ones(len(rows)) if w is None else np.asarray(w, float)
    out = {k: {q: wquant(np.array([r[k] for r in rows], float), w, v) for q, v in (("p10", 0.1), ("median", 0.5), ("p90", 0.9))} for k in METRICS}
    out["four_share"] = float(sum(wi for r, wi in zip(rows, w) if r["lobes"] == 4) / w.sum())
    return out


def main():
    rng = np.random.default_rng(SEED)
    real = real_rows()
    groups = {"本物（重みつき）": (real, [r["weight"] for r in real])}
    for name, folder in (("base", G / "synthetic"), ("wide", G / "synthetic_wide")):
        raw, ext = measure(folder, rng)
        groups[f"数式 {name}・そのまま"] = (raw, None)
        groups[f"数式 {name}・取り出しを通す"] = (ext, None)
        # 1 枚見本を残す（写真のまねが、どう見えるか）
        if name == "wide":
            m = (np.asarray(Image.open(sorted(folder.glob('*.png'))[0]).convert("L")) >= 128).astype(np.uint8)
            crop, _ = photo_like(m, np.random.default_rng(1))
            cv2.imwrite(str(G / "synth-photo-like.jpg"), crop)
    result = {k: stats(rows, w) for k, (rows, w) in groups.items()}
    (G / "synth-measure.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    plt.rcParams["font.family"] = ["Meiryo", "Yu Gothic", "sans-serif"]
    colors = {"本物（重みつき）": "#2a78d6", "数式 base・そのまま": "#c9c9c9", "数式 base・取り出しを通す": "#7a7a7a",
              "数式 wide・そのまま": "#f2b48f", "数式 wide・取り出しを通す": "#eb6834"}
    fig, axes = plt.subplots(1, len(SHOW), figsize=(16, 4.2))
    for ax, k in zip(axes, SHOW):
        for name, (rows, w) in groups.items():
            v = np.array([r[k] for r in rows], float)
            ok = ~np.isnan(v)
            ww = np.ones(len(rows)) if w is None else np.asarray(w, float)
            ax.hist(v[ok], bins=np.linspace(0, 1.05 if k != "leaf_cv" else 0.6, 30), weights=ww[ok], density=True, histtype="step",
                    lw=2.4 if name.startswith("本物") else 1.6, color=colors[name], label=name)
        ax.set_title(LABELS[k])
        ax.set_yticks([])
        for s in ("top", "right", "left"):
            ax.spines[s].set_visible(False)
    axes[0].legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(G / "synth-measure.png", dpi=100)
    for k in ["valley_mean", "valley_max", "leaf_cv", "tip_cv", "aspect"]:
        print(k, "・".join(f"{n} {r[k]['median']:.2f}（{r[k]['p10']:.2f}〜{r[k]['p90']:.2f}）" for n, r in result.items()))
    print("葉の数が 4 の割合", "・".join(f"{n} {r['four_share']:.2f}" for n, r in result.items()))


if __name__ == "__main__":
    main()
