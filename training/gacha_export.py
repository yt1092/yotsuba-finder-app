"""
「今日のよつば」の試作: 数式で作った形（data/gacha/synthetic の、幾何のチェックを通ったもの）から 60 個を選び、
アプリで使う WebP にして public/gacha/ に置く

    python training/gacha_export.py

選び方: 形の特徴（面積・周囲の長さ・まるさ・対称性・葉のあいだの深さ。gacha_shape.features）をそろえた尺度にして、
  「いちばん遠いものを順に足す」選び方（farthest point sampling）で、ばらつきが大きくなるように 60 個選ぶ
  はじめの 1 個は、特徴の平均にいちばん近い形
絵: 元の式のパラメータ（synthetic/params.csv）から 1024px で描き直し、256px に縮める（ふちをなめらかに）。緑の形・背景は透明
並び: ファイルの番号（yotsuba-01〜60）は、選んだ順ではなく、シードで混ぜた順（日付で順に出すとき、似た形が続かないように）
出力
  public/gacha/yotsuba-01.webp 〜 yotsuba-60.webp（Git に入れる。全部で 300KB 以内か確かめる）
  docs/screens/gacha-60.png（確認用の一覧。Git の対象外）
  標準出力: ファイルの番号と、元の形の id（data/gacha/synthetic/<id>.png）の対応
"""

import csv
import json
import math
import random
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import gacha_synth as gs
from gacha_shape import RADIUS, SIZE, features

ROOT = Path(__file__).resolve().parent.parent
SYN = ROOT / "data" / "gacha" / "synthetic"
OUT = ROOT / "public" / "gacha"
COUNT = 60
LIMIT_BYTES = 300 * 1024
FEATS = ["area_ratio", "perimeter", "compactness", "sym4", "depth"]
FILL = (95, 174, 85)       # ホームの四つ葉と同じ緑（#5FAE55）
SEED = 27


def load(path: Path) -> np.ndarray:
    return (np.asarray(Image.open(path).convert("L")) >= 128).astype(np.uint8)


def pick(ids: list[str], X: np.ndarray, k: int) -> list[str]:
    Z = (X - X.mean(0)) / X.std(0)
    first = int(np.argmin(np.linalg.norm(Z, axis=1)))
    chosen = [first]
    dist = np.linalg.norm(Z - Z[first], axis=1)
    while len(chosen) < k:
        i = int(np.argmax(dist))
        chosen.append(i)
        dist = np.minimum(dist, np.linalg.norm(Z - Z[i], axis=1))
    return [ids[i] for i in chosen]


def render(p: dict, orders: int, size: int = 256) -> Image.Image:
    """元の式（gacha_synth.radius）から、size の 4 倍の細かさで描き直す（64px のマスクを引きのばすと、ふちがぎざぎざになるため）。
    中心・向き・大きさのそろえ方は gacha_shape.normalize と同じ（いちばん遠い点を、絵の幅の RADIUS/SIZE に）"""
    big = size * 4
    t = np.linspace(0, 2 * math.pi, 2880, endpoint=False)
    r = gs.radius(t, p, orders)
    a = t + math.radians(p["rotation_deg"])
    pts = np.stack([big / 2 + 0.4 * big * r / r.max() * np.cos(a), big / 2 + 0.4 * big * r / r.max() * np.sin(a)], 1)
    raw = np.zeros((big, big), np.uint8)
    cv2.fillPoly(raw, [np.round(pts * 4).astype(np.int32)], 1, shift=2)
    ys, xs = np.nonzero(raw)
    cy, cx = ys.mean(), xs.mean()
    ang = np.arctan2(ys - cy, xs - cx)
    rad = np.hypot(ys - cy, xs - cx)
    w = rad ** 2
    theta = math.atan2((w * np.sin(4 * ang)).sum(), (w * np.cos(4 * ang)).sum()) / 4
    M = cv2.getRotationMatrix2D((cx, cy), math.degrees(theta) - 45, RADIUS / SIZE * big / rad.max())
    M[0, 2] += big / 2 - cx
    M[1, 2] += big / 2 - cy
    shape = cv2.warpAffine(raw, M, (big, big), flags=cv2.INTER_NEAREST)
    rgba = np.zeros((big, big, 4), np.uint8)
    rgba[..., :3] = FILL  # 1 色（ふちの色を足すと、ファイルが大きくなる）。形は透明度だけで表す
    rgba[shape == 1, 3] = 255
    small = np.asarray(Image.fromarray(rgba, "RGBA").resize((size, size), Image.LANCZOS)).copy()
    small[..., :3] = FILL  # 縮めると、ふちの半透明の所で色がわずかにずれ、ファイルが大きくなるので、色をそろえ直す
    return Image.fromarray(small, "RGBA")


def main():
    with (SYN / "params.csv").open(encoding="utf-8") as f:
        rows = {r["id"]: r for r in csv.DictReader(f) if r["result"] == "通った"}
    ids = list(rows)
    orders = int(json.loads((SYN / "summary.json").read_text(encoding="utf-8"))["orders"])
    params = {i: {k: float(v) for k, v in r.items() if k not in ("id", "result", "reasons")} for i, r in rows.items()}
    masks = {i: load(SYN / f"{i}.png") for i in ids}
    X = np.array([[features(masks[i])[k] for k in FEATS] for i in ids])
    chosen = pick(ids, X, COUNT)
    order = chosen[:]
    random.Random(SEED).shuffle(order)
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("yotsuba-*.webp"):  # 前の実行のものが残らないように
        old.unlink()
    total = 0
    for n, sid in enumerate(order, start=1):
        p = OUT / f"yotsuba-{n:02d}.webp"
        render(params[sid], orders).save(p, "WEBP", lossless=True, method=6)  # 色の少ない絵なので、劣化なしのほうが小さい（256px で 1 個 約 4KB）
        total += p.stat().st_size
        print(f"yotsuba-{n:02d}.webp ← synthetic/{sid}.png")
    print(f"全部で {total / 1024:.1f}KB（上限 {LIMIT_BYTES // 1024}KB）")
    if total > LIMIT_BYTES:
        raise SystemExit("大きすぎます")
    # 確認用の一覧
    S = 128
    font = ImageFont.truetype("C:/Windows/Fonts/meiryo.ttc", 14)
    sheet = Image.new("RGB", (S * 10, (S + 18) * 6), (250, 252, 246))
    d = ImageDraw.Draw(sheet)
    for n in range(1, COUNT + 1):
        im = Image.open(OUT / f"yotsuba-{n:02d}.webp").resize((S - 8, S - 8))
        x, y = ((n - 1) % 10) * S, ((n - 1) // 10) * (S + 18)
        sheet.paste(im, (x + 4, y + 18), im)
        d.text((x + 4, y), f"{n:02d}  {order[n - 1]}", fill=(47, 74, 53), font=font)
    (ROOT / "docs" / "screens").mkdir(parents=True, exist_ok=True)
    sheet.save(ROOT / "docs" / "screens" / "gacha-60.png")
    # 特徴のばらつき（選んだ 60 個と、通った形の全体）
    Xc = np.array([[features(masks[i])[k] for k in FEATS] for i in chosen])
    for j, k in enumerate(FEATS):
        print(f"{k}: 全体 {X[:, j].min():.3f}〜{X[:, j].max():.3f}（標準偏差 {X[:, j].std():.3f}）・60 個 {Xc[:, j].min():.3f}〜{Xc[:, j].max():.3f}（標準偏差 {Xc[:, j].std():.3f}）")


if __name__ == "__main__":
    main()
