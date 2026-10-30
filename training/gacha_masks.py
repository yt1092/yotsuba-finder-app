"""
「今日のよつば」の学習データ: 四つ葉のシルエット（64×64 の 2 値マスク）を作る

    pip install onnxruntime numpy pillow opencv-python-headless
    python training/gacha_masks.py

入力（どれもライセンスがはっきりしたものだけ）
  - data/gacha/inat/manifest.csv と images/ … iNaturalist の CC0 の写真（training/collect_inat_fourleaf.py）
  - data/gacha/own/*.jpg                  … 自分で撮った野原の写真（あれば）
  - data/gacha/drawn/*.png                … 自分で描いた形（白い背景に、緑か黒で塗った四つ葉。あれば。そのまま形として使う）
手順
  1. 写真で四つ葉を探す（今のモデル public/models/yotsuba-v5mix.onnx・写真から探すと同じ処理・しきい値 0.4）
  2. 四つ葉の枠のまわりを切り抜き、その中で四つ葉だけを分ける（GrabCut を枠で始め、緑の色で助ける。
     いちばん大きなかたまりを残し、穴を埋め、細いつながりを切る）
  3. 中心（重心）をそろえ、向きをそろえる（gacha_shape.normalize。4 枚の葉は 90 度ずつなので、4 倍の角度のモーメントで向きを求め、
     葉がななめ 45 度に来るように回す）。大きさは、中心からいちばん遠い点が 29px になるように
  4. 64×64 の 2 値マスクにする。回転の水増しは、学習のとき（フェーズ 2）に行う
  捨てる・印を付ける決まり（理由を SOURCES.csv に書く）
  - 捨てる: 四つ葉が見つからない・枠が小さすぎる（長い辺 40px 未満）・分けた形が小さすぎる（枠の 15% 未満）
  - 印（崩れているかも）: 緑でない（花など。分けた形の中の緑の画素が 60% 未満）・
    4 枚の葉の形に見えない（向きをそろえたあと、ななめ 4 方向の届く長さが、たて・よこより 12% 以上長く、
    いちばん短いななめが、いちばん長いななめの 70% 以上、でないもの）・切り抜きの端に触れている・
    形がとても細長い／ぎざぎざ（凸包に対する面積の比が 0.55 未満）
出力（data/ は Git の対象外）
  data/gacha/crops/<id>.jpg・data/gacha/masks/<id>.png・data/gacha/SOURCES.csv（1 枚ごとの出どころ・ライセンス・結果）
  data/gacha/summary.json・data/gacha/sample-sheet.png（ランダムに 64 枚。左に切り抜き、右にマスク。崩れているかもの印は赤い番号）
"""

import csv
import json
import math
import random
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import eval_hardneg as eh
from gacha_shape import normalize  # 中心と向きと大きさをそろえる（数式で作る形とも同じ）

ROOT = eh.PROJECT_DIR
G = ROOT / "data" / "gacha"
MODEL = ROOT / "public" / "models" / "yotsuba-v5mix.onnx"
MIN_BOX = 40         # 枠の長い辺がこれ未満なら捨てる（形が分からない）
CROP_MARGIN = 0.18   # 枠のまわりの余白（切り抜きの幅に対して）
SEED = 7


def segment(crop: np.ndarray, rect) -> np.ndarray:
    """枠 rect（切り抜きの中の x, y, w, h）の中の四つ葉を分ける。0/1 の配列"""
    h, w = crop.shape[:2]
    mask = np.full((h, w), cv2.GC_BGD, np.uint8)
    x, y, rw, rh = rect
    mask[y:y + rh, x:x + rw] = cv2.GC_PR_BGD
    # 緑の色の画素は「たぶん前景」（GrabCut を助ける）
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    green = (hsv[..., 0] >= 30) & (hsv[..., 0] <= 95) & (hsv[..., 1] >= 50) & (hsv[..., 2] >= 40)
    inside = np.zeros_like(green)
    inside[y:y + rh, x:x + rw] = True
    mask[green & inside] = cv2.GC_PR_FGD
    # 枠のまん中は前景とみなす（四つ葉の中心）
    cx, cy = x + rw // 2, y + rh // 2
    r = max(2, min(rw, rh) // 10)
    mask[cy - r:cy + r, cx - r:cx + r] = cv2.GC_FGD
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(crop, mask, None, bgd, fgd, 5, cv2.GC_INIT_WITH_MASK)
    fg = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)
    # 細いつながりを切り、中心をふくむかたまり（なければ、いちばん大きいもの）を残し、穴を埋める
    k = max(3, (min(rw, rh) // 40) | 1)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(fg)
    if n <= 1:
        return np.zeros_like(fg)
    keep = lab[cy, cx] if lab[cy, cx] != 0 else 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    fg = (lab == keep).astype(np.uint8)
    cnts, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(fg)
    cv2.drawContours(filled, cnts, -1, 1, thickness=-1)
    return cv2.morphologyEx(filled, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))


def fourness(m64: np.ndarray) -> tuple[float, float]:
    """向きをそろえたマスク（葉がななめ 45 度）で、ななめ 4 方向と、たて・よこ 4 方向の、中心からの届く長さを比べる
    返す値: (ななめの平均 ÷ たて・よこの平均, いちばん短いななめ ÷ いちばん長いななめ)"""
    ys, xs = np.nonzero(m64)
    if len(xs) == 0:
        return 0.0, 0.0
    cy, cx = ys.mean(), xs.mean()
    ang = np.degrees(np.arctan2(ys - cy, xs - cx)) % 360
    rad = np.hypot(ys - cy, xs - cx)

    def reach(a):
        d = np.abs((ang - a + 180) % 360 - 180)
        sel = rad[d <= 12]
        return float(sel.max()) if len(sel) else 0.0
    diag = [reach(a) for a in (45, 135, 225, 315)]
    axis = [reach(a) for a in (0, 90, 180, 270)]
    return (np.mean(diag) / max(np.mean(axis), 1e-6)), (min(diag) / max(max(diag), 1e-6))


def green_ratio(crop_bgr: np.ndarray, mask: np.ndarray) -> float:
    """分けた形の中の、緑の画素の割合（花などを除くため）"""
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    green = (hsv[..., 0] >= 30) & (hsv[..., 0] <= 95) & (hsv[..., 1] >= 40)
    m = mask.astype(bool)
    return float(green[m].mean()) if m.any() else 0.0


def flags_of(mask_crop: np.ndarray, m64: np.ndarray, crop_bgr: np.ndarray | None = None) -> list[str]:
    """崩れているかもの印（空なら「使える」）"""
    f = []
    if crop_bgr is not None and green_ratio(crop_bgr, mask_crop) < 0.6:
        f.append("緑でない（花など）")
    ratio, even = fourness(m64)
    if ratio < 1.12 or even < 0.7:
        f.append("4 枚の葉の形に見えない")
    if mask_crop[0].any() or mask_crop[-1].any() or mask_crop[:, 0].any() or mask_crop[:, -1].any():
        f.append("切り抜きの端に触れている")
    cnts, _ = cv2.findContours(m64, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if cnts:
        c = max(cnts, key=cv2.contourArea)
        hull = cv2.contourArea(cv2.convexHull(c))
        if hull > 0 and cv2.contourArea(c) / hull < 0.55:
            f.append("ぎざぎざ・細長い")
    return f


def main():
    for d in ("crops", "masks"):
        (G / d).mkdir(parents=True, exist_ok=True)
    detector = eh.Detector(MODEL)
    sources = []

    # 写真（iNaturalist の CC0・自分の写真）
    photos = []
    man = G / "inat" / "manifest.csv"
    if man.exists():
        with man.open(encoding="utf-8") as f:
            for r in csv.DictReader(f):
                photos.append({"path": G / "inat" / r["file"], "source": "iNaturalist", "license": "CC0",
                               "author": r["photographer"], "url": r["observation_url"], "ref": f"inat-{r['photo_id']}"})
    for p in sorted((G / "own").glob("*.jp*g")) if (G / "own").exists() else []:
        photos.append({"path": p, "source": "自分の写真", "license": "自分のもの", "author": "作者", "url": "", "ref": f"own-{p.stem}"})

    stats = {"photos": len(photos), "photos_without_four": 0, "boxes": 0, "rejected": {}, "flagged": 0, "ok": 0, "drawn": 0}
    for ph in photos:
        image = eh.open_image(ph["path"])
        fours = [d for d in detector.detect(image, eh.TILE_FRAC) if d["cls"] == eh.FOUR]
        if not fours:
            stats["photos_without_four"] += 1
            sources.append({**ph, "id": ph["ref"], "status": "捨てた", "reason": "四つ葉が見つからない", "score": ""})
            continue
        for k, d in enumerate(sorted(fours, key=lambda d: -d["score"])):
            stats["boxes"] += 1
            sid = f"{ph['ref']}-{k}"
            row = {**ph, "id": sid, "score": f"{d['score']:.2f}"}
            x, y, w, h = d["box"]
            if max(w, h) < MIN_BOX:
                row.update(status="捨てた", reason="枠が小さすぎる")
                stats["rejected"]["枠が小さすぎる"] = stats["rejected"].get("枠が小さすぎる", 0) + 1
                sources.append(row)
                continue
            side = max(w, h) / (1 - 2 * CROP_MARGIN)
            cx, cy = x + w / 2, y + h / 2
            L, T = int(round(cx - side / 2)), int(round(cy - side / 2))
            S = int(round(side))
            pad = Image.new("RGB", (S, S), (114, 114, 114))
            pad.paste(image.crop((max(0, L), max(0, T), min(image.width, L + S), min(image.height, T + S))), (max(0, -L), max(0, -T)))
            crop = cv2.cvtColor(np.asarray(pad), cv2.COLOR_RGB2BGR)
            rect = (int(x - L), int(y - T), max(1, int(w)), max(1, int(h)))
            m = segment(crop, rect)
            if m.sum() < 0.15 * w * h:
                row.update(status="捨てた", reason="分けた形が小さすぎる")
                stats["rejected"]["分けた形が小さすぎる"] = stats["rejected"].get("分けた形が小さすぎる", 0) + 1
                sources.append(row)
                continue
            m64 = normalize(m)
            fl = flags_of(m, m64, crop)
            pad.resize((128, 128), Image.BILINEAR).save(G / "crops" / f"{sid}.jpg", quality=88)
            Image.fromarray(m64 * 255).save(G / "masks" / f"{sid}.png")
            row.update(status="崩れているかも" if fl else "使える", reason="・".join(fl))
            stats["flagged" if fl else "ok"] += 1
            sources.append(row)

    # 自分で描いた形（白い背景に塗った四つ葉）
    for p in sorted((G / "drawn").glob("*.png")):
        a = np.asarray(Image.open(p).convert("L"))
        m = (a < 128).astype(np.uint8)
        if m.sum() == 0:
            continue
        m64 = normalize(m)
        sid = f"drawn-{p.stem}"
        Image.fromarray(m64 * 255).save(G / "masks" / f"{sid}.png")
        Image.open(p).convert("RGB").resize((128, 128)).save(G / "crops" / f"{sid}.jpg")
        fl = flags_of(m, m64)
        sources.append({"path": p, "source": "自分で描いた形", "license": "自分のもの", "author": "作者", "url": "", "ref": sid,
                        "id": sid, "score": "", "status": "崩れているかも" if fl else "使える", "reason": "・".join(fl)})
        stats["drawn"] += 1

    with (G / "SOURCES.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "source", "license", "author", "url", "score", "status", "reason"])
        w.writeheader()
        for r in sources:
            w.writerow({k: r.get(k, "") for k in w.fieldnames})
    (G / "summary.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False))
    make_sheet([r for r in sources if r["status"] in ("使える", "崩れているかも")])


def make_sheet(rows):
    random.Random(SEED).shuffle(rows)
    rows = rows[:64]
    cell, gap, label = 96, 8, 22
    cols = 8
    W = cols * (cell * 2 + gap * 2)
    H = math.ceil(len(rows) / cols) * (cell + label + gap)
    sheet = Image.new("RGB", (max(W, 1), max(H, 1)), (244, 248, 238))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/meiryo.ttc", 14)
    except OSError:
        font = ImageFont.load_default()
    listing = []
    for n, r in enumerate(rows, start=1):
        x = ((n - 1) % cols) * (cell * 2 + gap * 2)
        y = ((n - 1) // cols) * (cell + label + gap)
        sheet.paste(Image.open(G / "crops" / f"{r['id']}.jpg").resize((cell, cell)), (x, y + label))
        mask = Image.open(G / "masks" / f"{r['id']}.png").resize((cell, cell), Image.NEAREST)
        sheet.paste(Image.merge("RGB", [mask.point(lambda v: 255 - v)] * 3), (x + cell + 2, y + label))
        bad = r["status"] == "崩れているかも"
        d.text((x + 2, y + 2), f"{n}" + (" ?" if bad else ""), fill=(200, 30, 30) if bad else (47, 74, 53), font=font)
        listing.append({"番号": n, "id": r["id"], "結果": r["status"], "理由": r["reason"]})
    sheet.save(G / "sample-sheet.png")
    (G / "sample-sheet.json").write_text(json.dumps(listing, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"確認用のシート: {G / 'sample-sheet.png'}（{len(rows)} 枚。赤い番号に「?」= 崩れているかも。番号と id は sample-sheet.json）")


if __name__ == "__main__":
    main()
