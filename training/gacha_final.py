"""
「今日のよつば」: DiT の学習用の、最終のデータセットを作る（data/gacha/final/ と、Colab に上げる final.zip）

    python training/gacha_final.py

中身
  final/real/<id>.png       … 本物の形 64×64（作者が入れると決めたもの。gacha_reference_pick.json の use・use_fixed）
  final/real.csv            … id・番号・株（観察）・撮影者・ライセンス・観察のページ・重み（株ごとに 1 枚分・撮影者は全体の 1/2 まで）
  final/synthetic/<id>.png  … 数式の形 64×64（data/gacha/synthetic_wide の、幾何のチェックを通ったもの。自作）
  final/synthetic.csv       … id・出どころ・ライセンス
  final/code/               … ノートブックが使う gacha_shape.py・validity.py（Git にあるものの写し）
  final/baseline.json       … DiT と比べる基準の数（training/gacha_baseline.json の写し）
  final/manifest.json       … 枚数と内訳
  final.zip                 … 上のすべて（Colab に上げるのは、これ 1 つ）
ライセンス: 本物は iNaturalist の CC0 だけ（違うものがあれば止まる）。数式の形は自作。ネットの画像は入れない
"""

import csv
import json
import shutil
import zipfile
from collections import Counter
from pathlib import Path

from gacha_baseline import real_rows

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
G = ROOT / "data" / "gacha"
OUT = G / "final"


def main():
    real = real_rows()
    bad = [r["id"] for r in real if r["license"] != "CC0"]
    if bad:
        raise SystemExit(f"CC0 でない本物の形があります: {bad}")
    syn = sorted((G / "synthetic_wide").glob("*.png"))
    if OUT.exists():
        for p in sorted(OUT.rglob("*"), reverse=True):  # 前の実行の中身を消す（自分で作ったフォルダの中だけ）
            p.unlink() if p.is_file() else p.rmdir()
    for d in ("real", "synthetic", "code"):
        (OUT / d).mkdir(parents=True, exist_ok=True)

    for r in real:
        shutil.copyfile(G / r["mask"], OUT / "real" / f"{r['id']}.png")
    with (OUT / "real.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "number", "observation", "author", "license", "url", "mask_from", "weight"])
        w.writeheader()
        for r in real:
            w.writerow({"id": r["id"], "number": r["number"], "observation": r["observation"], "author": r["author"], "license": r["license"],
                        "url": r["url"], "mask_from": r["mask"].split("/")[0], "weight": round(r["weight"], 6)})
    for p in syn:
        shutil.copyfile(p, OUT / "synthetic" / p.name)
    with (OUT / "synthetic.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "source", "license"])
        for p in syn:
            w.writerow([p.stem, "数式（training/gacha_synth.py --profile wide --seed 2）", "自作"])
    for name in ("gacha_shape.py", "validity.py"):
        shutil.copyfile(HERE / name, OUT / "code" / name)
    shutil.copyfile(HERE / "gacha_baseline.json", OUT / "baseline.json")

    manifest = {
        "created": "2026-10-27",
        "real": {"masks": len(real), "plants": len({r["observation"] for r in real}), "photos": len({r["photo"] for r in real}),
                 "masks_by_photographer": dict(Counter(r["author"] for r in real).most_common()),
                 "plants_by_photographer": dict(Counter(a for a, _ in {(r["author"], r["observation"]) for r in real}).most_common()),
                 "weight_by_photographer": {a: round(sum(r["weight"] for r in real if r["author"] == a), 4) for a in sorted({r["author"] for r in real})},
                 "weight_total": round(sum(r["weight"] for r in real), 4),
                 "license": "iNaturalist CC0"},
        "synthetic": {"masks": len(syn), "profile": "wide", "license": "自作"},
        "weights": "株ごとに 1 枚分を、同じ株の枠で等分。1 人の撮影者は全体の 1/2 まで（training/gacha_baseline.py）",
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    zpath = G / "final.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(OUT.rglob("*")):
            if p.is_file():
                z.write(p, Path("final") / p.relative_to(OUT))
    print(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"→ {zpath}（{zpath.stat().st_size / 1024:.0f}KB）")


if __name__ == "__main__":
    main()
