"""
「今日のよつば」: 実物の四つ葉のシルエットから、比べるための特徴を計算して、参照として保存する

    python training/gacha_reference.py                     # 作者が選んだ番号（training/gacha_reference_pick.json）
    python training/gacha_reference.py --numbers 2,5,7,18  # 番号をじかに指定（すべて ○ として）
    python training/gacha_reference.py --auto              # 自動のチェックで「使える」の枠（SOURCES.csv）

特徴は gacha_shape.features（面積・周囲の長さ・まるさ・葉の数・4 回の対称性・葉のあいだの深さ）
出力: data/gacha/reference-stats.csv（1 行 = 実物の 1 つの形。出どころの id もつける）
  judge の列: ○ = 基準に使う・？ = 基準に入れず、あとで見直すために残す（gacha_compare.py は ○ だけを使う）
比べるのは training/gacha_compare.py
"""

import argparse
import csv
import json
from pathlib import Path

import numpy as np
from PIL import Image

from gacha_shape import features

G = Path(__file__).resolve().parent.parent / "data" / "gacha"
PICK = Path(__file__).resolve().parent / "gacha_reference_pick.json"
FEATURES = ["area_ratio", "perimeter", "compactness", "lobes", "sym4", "depth"]


def load_mask(path: Path) -> np.ndarray:
    return (np.asarray(Image.open(path).convert("L")) >= 128).astype(np.uint8)


def pick_rows(numbers: str | None = None, auto: bool = False, pick: Path = PICK) -> list[dict]:
    """基準にする実物の行。どの行にも judge（○ か ？）をつける"""
    if auto:
        with (G / "SOURCES.csv").open(encoding="utf-8") as f:
            return [{**r, "judge": "○"} for r in csv.DictReader(f) if r["status"] == "使える"]
    if numbers:
        judge = {int(n): "○" for n in numbers.split(",") if n.strip()}
    else:
        p = json.loads(pick.read_text(encoding="utf-8"))
        judge = {**{n: "？" for n in p.get("hold", [])}, **{n: "○" for n in p["use"]}}
    with (G / "review-index.csv").open(encoding="utf-8") as f:
        rows = [{**r, "judge": judge[int(r["number"])]} for r in csv.DictReader(f) if int(r["number"]) in judge]
    missing = set(judge) - {int(r["number"]) for r in rows}
    if missing:
        raise SystemExit(f"review-index.csv に無い番号: {sorted(missing)}")
    return sorted(rows, key=lambda r: (r["judge"] != "○", int(r["number"])))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--numbers", help="選別シートの番号（カンマ区切り）。ないときは gacha_reference_pick.json")
    ap.add_argument("--auto", action="store_true", help="自動のチェックで「使える」の枠を使う（選別の前の仮の基準）")
    ap.add_argument("--out", type=Path, default=G / "reference-stats.csv")
    args = ap.parse_args()
    rows = pick_rows(args.numbers, args.auto)
    out = []
    for r in rows:
        f = features(load_mask(G / "masks" / f"{r['id']}.png"))
        out.append({"id": r["id"], "number": r.get("number", ""), "judge": r["judge"], "source": r["source"], "license": r["license"],
                    **{k: round(float(f[k]), 5) for k in FEATURES}})
    with args.out.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["id", "number", "judge", "source", "license", *FEATURES])
        w.writeheader()
        w.writerows(out)
    n_use = sum(r["judge"] == "○" for r in out)
    print(f"実物の形の特徴: {args.out}（○ {n_use} 個・？ {len(out) - n_use} 個）")


if __name__ == "__main__":
    main()
