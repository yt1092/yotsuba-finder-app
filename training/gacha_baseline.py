"""
「今日のよつば」: 本物の形の「種類」の数と、学習で使う重み、DiT の出力と比べる基準の数を作る

    python training/gacha_baseline.py

本物の形（学習に使う最終の形。作者の決定 gacha_reference_pick.json）
  - use（前のマスク data/gacha/masks）と use_fixed（直したマスク data/gacha/masks_fix）
重み（学習のとき、1 つの形を何回分として使うか。作者の決定 2026-10-27）
  1. 株（iNaturalist の 1 件の観察）ごとに 1 枚分。同じ株の枠は、その 1 枚分を等分する（例: 8・9・12 は 1/3 ずつ）
  2. 1 人の撮影者の重みの合計が、全体の PHOTOGRAPHER_CAP（1/2）をこえないように、その人の枠を同じ割合で小さくする
基準の数（gacha_shape.shape_metrics）: 谷の比（平均・いちばん浅い谷）・葉の大きさのばらつき（面積・先の遠さ）・縦横比
  本物は重みを付けた 中央値・10%点・90%点。数式の形（data/gacha/synthetic の 2,932 個）と並べる
出力
  data/gacha/real-set.csv（Git の対象外。1 行 = 1 つの本物の形と、重み・数）
  training/gacha_baseline.json（Git に入れる。DiT の出力と比べる基準）
"""

import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

import gacha_shape as sh

ROOT = Path(__file__).resolve().parent.parent
G = ROOT / "data" / "gacha"
HERE = Path(__file__).resolve().parent
PHOTOGRAPHER_CAP = 1 / 2
METRICS = ["valley_mean", "valley_max", "leaf_cv", "tip_cv", "aspect"]


def load(path: Path) -> np.ndarray:
    return (np.asarray(Image.open(path).convert("L")) >= 128).astype(np.uint8)


def weights(rows: list[dict], cap: float = PHOTOGRAPHER_CAP) -> None:
    """rows に weight を書き込む（株ごとに 1 枚分を等分し、撮影者ごとの上限で小さくする）"""
    per_plant = Counter(r["observation"] for r in rows)
    for r in rows:
        r["weight"] = 1 / per_plant[r["observation"]]
    for _ in range(20):  # 小さくすると全体も小さくなるので、何回か繰り返す
        total = sum(r["weight"] for r in rows)
        by = defaultdict(float)
        for r in rows:
            by[r["author"]] += r["weight"]
        over = {a: w for a, w in by.items() if w > cap * total + 1e-9}
        if not over:
            break
        others = total - sum(over.values())
        for r in rows:
            if r["author"] in over:
                # 上限ちょうど: その人の合計 = cap × 全体 ＝ cap × (ほかの人 ＋ その人) → その人 = cap × ほか ÷ (1 − cap × 上限の人数)
                target = cap * others / (1 - cap * len(over)) if cap * len(over) < 1 else over[r["author"]]
                r["weight"] *= target / over[r["author"]]


def wquant(v: np.ndarray, w: np.ndarray, q: float) -> float:
    ok = ~np.isnan(v)
    v, w = v[ok], w[ok]
    if len(v) == 0:
        return float("nan")
    o = np.argsort(v)
    c = np.cumsum(w[o]) / w.sum()
    return float(v[o][np.searchsorted(c, q)])


def summary(rows: list[dict], weighted: bool) -> dict:
    out = {}
    w = np.array([r["weight"] if weighted else 1.0 for r in rows])
    for k in METRICS:
        v = np.array([r[k] for r in rows], dtype=float)
        out[k] = {"median": wquant(v, w, 0.5), "p10": wquant(v, w, 0.1), "p90": wquant(v, w, 0.9)}
    out["four_share"] = float(sum(wi for r, wi in zip(rows, w) if r["lobes"] == 4) / w.sum())
    return out


def kinds(rows: list[dict]) -> dict:
    return {"boxes": len(rows), "photos": len({r["photo"] for r in rows}), "observations": len({r["observation"] for r in rows}),
            "photographers": dict(Counter(r["author"] for r in rows).most_common()),
            "observations_by_photographer": dict(Counter(a for a, _ in {(r["author"], r["observation"]) for r in rows}).most_common()),
            "weight_by_photographer": {a: round(sum(r["weight"] for r in rows if r["author"] == a), 3) for a in sorted({r["author"] for r in rows})},
            "weight_total": round(sum(r["weight"] for r in rows), 3)}


def real_rows() -> list[dict]:
    """学習に使う本物の形（重みつき）"""
    pick = json.loads((HERE / "gacha_reference_pick.json").read_text(encoding="utf-8"))
    with (G / "review-index.csv").open(encoding="utf-8") as f:
        index = {int(r["number"]): r for r in csv.DictReader(f)}

    def row(n: int, folder: str) -> dict:
        r = index[n]
        m = load(G / folder / f"{r['id']}.png")
        return {"number": n, "id": r["id"], "photo": r["id"].rsplit("-", 1)[0], "observation": r["url"].rsplit("/", 1)[1],
                "author": r["author"], "license": r["license"], "url": r["url"], "mask": f"{folder}/{r['id']}.png",
                "lobes": sh.count_lobes(m), **sh.shape_metrics(m)}

    rows = [row(n, "masks") for n in pick["use"]] + [row(n, "masks_fix") for n in pick["use_fixed"]]
    weights(rows)
    return rows


def synthetic_rows(folder: Path) -> list[dict]:
    rows = []
    for p in sorted(folder.glob("*.png")):
        m = load(p)
        rows.append({"id": p.stem, "weight": 1.0, "lobes": sh.count_lobes(m), **sh.shape_metrics(m)})
    return rows


def main():
    real = real_rows()
    base = synthetic_rows(G / "synthetic")
    wide = synthetic_rows(G / "synthetic_wide")
    baseline = {
        "note": "「今日のよつば」の DiT の出力と比べる基準（training/gacha_baseline.py・2026-10-27）。本物は重み付きの分位点（株ごとに 1 枚分・撮影者は全体の 1/2 まで）。数式の形は、マスクの取り出しを通さない、そのままの形",
        "photographer_cap": PHOTOGRAPHER_CAP,
        "real": {"kinds": kinds(real), "metrics": summary(real, True)},
        "synthetic_base": {"count": len(base), "metrics": summary(base, False)},
        "synthetic_wide": {"count": len(wide), "metrics": summary(wide, False)},
    }
    (HERE / "gacha_baseline.json").write_text(json.dumps(baseline, ensure_ascii=False, indent=1), encoding="utf-8")
    with (G / "real-set.csv").open("w", encoding="utf-8", newline="") as f:
        fields = ["number", "id", "photo", "observation", "author", "license", "url", "mask", "weight", "lobes", *METRICS]
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in real:
            w.writerow({k: (round(r[k], 4) if isinstance(r[k], float) else r[k]) for k in fields})
    print(json.dumps(baseline, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
