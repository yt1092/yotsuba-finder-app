"""
「今日のよつば」: 取り出した四つ葉の枠（data/gacha/SOURCES.csv の「使える」「崩れているかも」）を、
作者が目で選ぶための選別シートにする（番号 1〜。左に切り抜き、右にマスク。番号は大きく）

    python training/gacha_review_sheet.py

出力（data/ は Git に入れない）
  data/gacha/review-sheet-1.png … 番号 1〜45
  data/gacha/review-sheet-2.png … 番号 46〜（残り全部。91 個なら 46〜91）
  data/gacha/review-index.csv   … 番号・どのシートか・SOURCES.csv の行（id・出どころ・ライセンス・撮影者・観察のページ・スコア・自動のチェックの結果）
"""

import csv
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

G = Path(__file__).resolve().parent.parent / "data" / "gacha"
PER_SHEET = 45
COLS = 5
CELL = 120         # 切り抜きとマスクの、それぞれの大きさ
LABEL = 40         # 番号を書く高さ
GAP = 14


def font(size):
    for f in ("C:/Windows/Fonts/meiryob.ttc", "C:/Windows/Fonts/meiryo.ttc"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main():
    with (G / "SOURCES.csv").open(encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["status"] in ("使える", "崩れているかも")]
    big, small = font(30), font(14)
    index = []
    # 1 枚目は 1〜45、2 枚目は残り全部（91 個なら 46〜91）
    parts = [rows[:PER_SHEET], rows[PER_SHEET:]] if len(rows) > PER_SHEET else [rows]
    for s, part in enumerate(parts):
        name = f"review-sheet-{s + 1}.png"
        w = COLS * (CELL * 2 + GAP * 2)
        h = math.ceil(len(part) / COLS) * (CELL + LABEL + GAP)
        sheet = Image.new("RGB", (w, h), (250, 252, 246))
        d = ImageDraw.Draw(sheet)
        for k, r in enumerate(part):
            n = s * PER_SHEET + k + 1
            x = (k % COLS) * (CELL * 2 + GAP * 2)
            y = (k // COLS) * (CELL + LABEL + GAP)
            sheet.paste(Image.open(G / "crops" / f"{r['id']}.jpg").convert("RGB").resize((CELL, CELL)), (x, y + LABEL))
            m = Image.open(G / "masks" / f"{r['id']}.png").convert("L").resize((CELL, CELL), Image.NEAREST)
            sheet.paste(Image.merge("RGB", [m.point(lambda v: 255 - v)] * 3), (x + CELL + 2, y + LABEL))
            d.rectangle([x + CELL + 2, y + LABEL, x + CELL * 2 + 2, y + LABEL + CELL], outline=(200, 210, 200))
            d.text((x + 4, y + 2), str(n), fill=(47, 74, 53), font=big)
            # 自動のチェックで「崩れているかも」だったものは、番号の右に小さく印
            if r["status"] == "崩れているかも":
                d.text((x + 70, y + 14), "自動: ?", fill=(190, 40, 40), font=small)
            index.append({"number": n, "sheet": name, **{k2: r[k2] for k2 in ("id", "source", "license", "author", "url", "score", "status", "reason")}})
        sheet.save(G / name)
        print(f"{name}: 番号 {s * PER_SHEET + 1}〜{s * PER_SHEET + len(part)}（{w}×{h}px）")
    with (G / "review-index.csv").open("w", encoding="utf-8", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=["number", "sheet", "id", "source", "license", "author", "url", "score", "status", "reason"])
        wr.writeheader()
        wr.writerows(index)
    print(f"番号の対応: {G / 'review-index.csv'}（{len(index)} 個）")


if __name__ == "__main__":
    main()
