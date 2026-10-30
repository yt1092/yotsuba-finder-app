"""
「今日のよつば」: 本物のマスクの確認シート（作者が、学習に入れるかを決めるため）

    python training/gacha_sample_sheet.py

並べるもの（review-index.csv の番号。training/gacha_reference_pick.json）
  1 段目〜: ○（基準に使う）20 個。葉の数が 4 にならなかったものは、赤い枠と、原因の短い説明
  最後の段: ？（基準に入れていない）4 個
各セル: 番号・○／？・葉の数（gacha_shape.count_lobes）・同じ写真の別の枠の印。左が元の切り抜き、右がマスク
原因の説明（CAUSES）は、gacha_lobe_check.py の図（data/gacha/lobe-check.png）を目で見て書いたもの（2026-10-27）
出力（Git の対象外）: data/gacha/sample-sheet.png と sample-sheet.json（番号・id・葉の数・原因）
"""

import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from gacha_shape import count_lobes

ROOT = Path(__file__).resolve().parent.parent
G = ROOT / "data" / "gacha"
CAUSES = {
    9: "上の2枚が重なり、谷が浅い（0.92）",
    10: "茎ととなりの葉がマスクに入った",
    17: "右の2枚がくっつき、ふちが四角い",
    23: "右上の2枚がくっつき、谷が浅い",
    50: "右の2枚がくっつき、谷が浅い（0.91）",
    68: "上と右の葉がくっつき、マスクが崩れた",
}
COLS, CELL, LABEL, GAP = 4, 140, 52, 14


def font(size, bold=False):
    for f in (("C:/Windows/Fonts/meiryob.ttc",) if bold else ()) + ("C:/Windows/Fonts/meiryo.ttc",):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main():
    pick = json.loads((Path(__file__).resolve().parent / "gacha_reference_pick.json").read_text(encoding="utf-8"))
    with (G / "review-index.csv").open(encoding="utf-8") as f:
        rows = {int(r["number"]): r for r in csv.DictReader(f)}
    same_photo = defaultdict(list)
    for n in pick["use"] + pick["hold"]:
        same_photo[rows[n]["id"].rsplit("-", 1)[0]].append(n)
    items = [(n, "○") for n in pick["use"]] + [(n, "？") for n in pick["hold"]]
    use_rows = math.ceil(len(pick["use"]) / COLS)
    hold_rows = math.ceil(len(pick["hold"]) / COLS)
    W = COLS * (CELL * 2 + GAP * 3)
    H = 40 + (use_rows + hold_rows) * (CELL + LABEL + GAP) + 40
    sheet = Image.new("RGB", (W, H), (250, 252, 246))
    d = ImageDraw.Draw(sheet)
    big, small, head = font(26, True), font(14), font(20, True)
    d.text((8, 6), f"○ 基準に使う（{len(pick['use'])}）　赤い枠 = 葉の数が 4 にならなかったもの", fill=(47, 74, 53), font=head)
    listing = []
    y0 = 40
    for k, (n, mark) in enumerate(items):
        if mark == "？" and k == len(pick["use"]):
            y0 = 40 + use_rows * (CELL + LABEL + GAP)
            d.text((8, y0 + 4), f"？ 基準に入れていない（{len(pick['hold'])}）", fill=(47, 74, 53), font=head)
            y0 += 36
        j = k if mark == "○" else k - len(pick["use"])
        x = (j % COLS) * (CELL * 2 + GAP * 3) + GAP
        y = y0 + (j // COLS) * (CELL + LABEL + GAP)
        r = rows[n]
        m = (np.asarray(Image.open(G / "masks" / f"{r['id']}.png").convert("L")) >= 128).astype(np.uint8)
        lobes = count_lobes(m)
        sheet.paste(Image.open(G / "crops" / f"{r['id']}.jpg").convert("RGB").resize((CELL, CELL)), (x, y + LABEL))
        mm = Image.fromarray(((1 - m) * 255).astype(np.uint8)).resize((CELL, CELL), Image.NEAREST).convert("RGB")
        sheet.paste(mm, (x + CELL + 4, y + LABEL))
        bad = lobes != 4
        d.rectangle([x - 4, y - 2, x + CELL * 2 + 8, y + LABEL + CELL + 4], outline=(214, 59, 59) if bad else (205, 215, 205), width=3 if bad else 1)
        d.text((x, y), f"{n}", fill=(214, 59, 59) if bad else (47, 74, 53), font=big)
        group = [g for g in same_photo[r["id"].rsplit("-", 1)[0]] if g != n]
        info = f"{mark}  葉の数 {lobes}" + (f"  同じ写真: {'・'.join(map(str, group))}" if group else "")
        d.text((x + 52, y + 4), info, fill=(47, 74, 53), font=small)
        if n in CAUSES:
            d.text((x + 52, y + 24), CAUSES[n], fill=(214, 59, 59), font=small)
        listing.append({"番号": n, "印": mark, "id": r["id"], "葉の数": lobes, "原因": CAUSES.get(n, ""),
                        "同じ写真の別の枠": group, "観察のページ": r["url"], "撮影者": r["author"], "ライセンス": r["license"]})
    sheet.save(G / "sample-sheet.png")
    (G / "sample-sheet.json").write_text(json.dumps(listing, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {G / 'sample-sheet.png'}（{len(items)} 個）")


if __name__ == "__main__":
    main()
