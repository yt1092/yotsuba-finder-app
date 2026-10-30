"""
「今日のよつば」: 本物の四つ葉のマスクの取り出しを直す（作り直したものを、前のものと並べて、作者が確かめる）

    python training/gacha_masks_fix.py              # 保留の 23 と、× のうち四つ葉に見える候補（CANDIDATES）
    python training/gacha_masks_fix.py --numbers 23,56

前（gacha_masks.py）からの変更
  1. 切り抜きを細かくした: 元の写真から、384px で切り抜き直す（前は 128px の切り抜きと、それから作ったマスク）。
     枠は、前と同じモデル・同じ処理で探し直す（同じ枠になる。番号の枠 = スコアの高い順の k 番目）。探した枠は data/gacha/boxes.json に残す
  2. 茎を取る: 葉の大きさに合わせた円で「開く」（細い出っぱりを削る）。葉は中心の近くで細くなり、離れてしまうので、
     大きいかたまり（いちばん大きいものの 3% 以上）だけを残し、中心に小さな円を足して、つなぎ直す
  3. くっついた葉を切り分ける: 葉の数（64×64 にそろえた形で数える）が 4 より少ないとき、いちばん角度の広い葉の、まん中 60% の範囲で、
     写真のふちがいちばん強い向き（光線に沿った、葉の境目の線）を探し、そこに細いくさび形の切れ目（中心の近くから外まで）を入れる。2 回まで。
     切っても葉の数が増えないときは、切らない
  - 葉の数が 4 より多いとき（茎・となりの葉が残った）は、切らずに、印だけ付ける
出力（Git の対象外）
  data/gacha/masks_fix/<id>.png（64×64）・data/gacha/crops_fix/<id>.jpg（256px）
  data/gacha/fix-results.csv（番号・id・観察・撮影者・葉の数 前→後・切った数・茎を取った面積・同じ株のまとめ）
  data/gacha/sample-sheet-fix.png（左から 元の切り抜き・前のマスク・直したマスク）
"""

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import eval_hardneg as eh
import gacha_shape as sh
from gacha_masks import CROP_MARGIN, MODEL, segment

ROOT = Path(__file__).resolve().parent.parent
G = ROOT / "data" / "gacha"
WORK = 384                 # 切り抜きの大きさ（px）
STEM_OPEN = 0.12           # 茎を取る円の直径（葉のいちばん遠い点までの距離に対する割合）
CENTER_DISK = 0.15         # 葉をつなぎ直す、中心の円の半径（同じ割合）
CUT_HALF_DEG = 3.5         # 切れ目のくさびの、半分の角度
CUT_FROM = 0.12            # 切れ目は、中心からこの割合の所から外へ
# 選別シート（review-sheet-1.png・2.png）で ×（使わない）にした枠のうち、切り抜きが四つ葉に見えるもの（2026-10-27。目で見て選んだ）
CANDIDATES = [4, 7, 11, 13, 14, 15, 16, 19, 20, 21, 22, 24, 27, 29, 30, 32, 33, 36, 52, 56, 57, 59, 60, 61, 64,
              66, 67, 69, 72, 73, 74, 75, 77, 78, 79, 84, 86, 87, 88, 90]


def angle_of(i: int) -> float:
    return (i + 0.5) / sh.BINS * 2 * math.pi - math.pi


def photo_path(photo_id: str) -> Path:
    """写真のファイル（manifest.csv の file。.jpg と .jpeg がある）"""
    global _FILES
    if not _FILES:
        with (G / "inat" / "manifest.csv").open(encoding="utf-8") as f:
            _FILES = {r["photo_id"]: r["file"] for r in csv.DictReader(f)}
    return G / "inat" / _FILES[photo_id]


_FILES: dict = {}


def boxes_for(photo_id: str, cache: dict, detector) -> list:
    if photo_id not in cache:
        image = eh.open_image(photo_path(photo_id))
        fours = [d for d in detector.detect(image, eh.TILE_FRAC) if d["cls"] == eh.FOUR]
        cache[photo_id] = [{"box": list(map(float, d["box"])), "score": float(d["score"])} for d in sorted(fours, key=lambda d: -d["score"])]
    return cache[photo_id]


def crop_photo(photo_id: str, box) -> tuple[np.ndarray, tuple]:
    image = eh.open_image(photo_path(photo_id))
    x, y, w, h = box
    side = max(w, h) / (1 - 2 * CROP_MARGIN)
    cx, cy = x + w / 2, y + h / 2
    L, T, S = int(round(cx - side / 2)), int(round(cy - side / 2)), int(round(side))
    pad = Image.new("RGB", (S, S), (114, 114, 114))
    pad.paste(image.crop((max(0, L), max(0, T), min(image.width, L + S), min(image.height, T + S))), (max(0, -L), max(0, -T)))
    s = WORK / S
    crop = cv2.cvtColor(np.asarray(pad.resize((WORK, WORK), Image.BICUBIC)), cv2.COLOR_RGB2BGR)
    rect = (int((x - L) * s), int((y - T) * s), max(1, int(w * s)), max(1, int(h * s)))
    return crop, rect


def fill_holes(m: np.ndarray) -> np.ndarray:
    cnts, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(m, np.uint8)
    cv2.drawContours(out, cnts, -1, 1, thickness=-1)
    return out


def radius_of(m: np.ndarray) -> tuple[float, float, float]:
    ys, xs = np.nonzero(m)
    cy, cx = ys.mean(), xs.mean()
    return cx, cy, float(np.hypot(ys - cy, xs - cx).max())


def remove_stem(m: np.ndarray) -> tuple[np.ndarray, int]:
    cx, cy, R = radius_of(m)
    d = max(3, int(round(STEM_OPEN * R)) | 1)
    opened = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(opened)
    if n <= 1:
        return m, 0
    big = st[1:, cv2.CC_STAT_AREA].max()
    keep = np.isin(lab, [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= 0.03 * big]).astype(np.uint8)
    cv2.circle(keep, (int(cx), int(cy)), max(2, int(CENTER_DISK * R)), 1, -1)
    keep &= m  # 中心の円も、元の形の中だけ
    n, lab, st, _ = cv2.connectedComponentsWithStats(keep)
    keep = (lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    keep = fill_holes(keep)
    return keep, int(m.sum() - keep.sum())


def edge_strength(crop: np.ndarray, cx: float, cy: float, R: float, a: float) -> float:
    """光線（角度 a）に沿った、葉の境目の線の強さ（光線に直角な向きの、明るさの変化の平均）"""
    g = cv2.GaussianBlur(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.5)
    gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)
    r = np.linspace(0.3 * R, 0.85 * R, 40)
    xs = np.clip(np.rint(cx + r * math.cos(a)).astype(int), 0, crop.shape[1] - 1)
    ys = np.clip(np.rint(cy + r * math.sin(a)).astype(int), 0, crop.shape[0] - 1)
    return float(np.abs(gx[ys, xs] * -math.sin(a) + gy[ys, xs] * math.cos(a)).mean())


def cut_merged(m: np.ndarray, crop: np.ndarray) -> tuple[np.ndarray, int]:
    cuts = 0
    for _ in range(2):
        # 切るかどうかは、最後に使う 64×64 の形の葉の数で決める（細かい切り抜きのままだと、数がちがうことがある）
        lobes = sh.count_lobes(sh.normalize(fill_holes(m)))
        _, _, valleys = sh.lobe_details(m)
        if lobes >= 4 or len(valleys) < 2:
            break
        angles = sorted(angle_of(i) for i, _, _ in valleys)
        spans = [((angles[(k + 1) % len(angles)] - angles[k]) % (2 * math.pi), angles[k]) for k in range(len(angles))]
        width, start = max(spans)
        cx, cy, R = radius_of(m)
        tries = [start + width * (0.2 + 0.6 * t / 24) for t in range(25)]
        a = max(tries, key=lambda t: edge_strength(crop, cx, cy, R, t))
        h = math.radians(CUT_HALF_DEG)
        r0, r1 = CUT_FROM * R, 1.2 * R
        poly = np.array([[cx + r0 * math.cos(a - h / 3), cy + r0 * math.sin(a - h / 3)], [cx + r1 * math.cos(a - h), cy + r1 * math.sin(a - h)],
                         [cx + r1 * math.cos(a + h), cy + r1 * math.sin(a + h)], [cx + r0 * math.cos(a + h / 3), cy + r0 * math.sin(a + h / 3)]])
        cut = m.copy()
        cv2.fillPoly(cut, [np.rint(poly).astype(np.int32)], 0)
        n, lab, st, _ = cv2.connectedComponentsWithStats(cut)
        cut = (lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
        if sh.count_lobes(sh.normalize(fill_holes(cut))) <= lobes:
            break  # 切っても葉の数が増えないなら、切らない（むだな切れ目を残さない）
        m = cut
        cuts += 1
    return m, cuts


def load64(path: Path) -> np.ndarray:
    return (np.asarray(Image.open(path).convert("L")) >= 128).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--numbers")
    args = ap.parse_args()
    pick = json.loads((Path(__file__).resolve().parent / "gacha_reference_pick.json").read_text(encoding="utf-8"))
    numbers = [int(n) for n in args.numbers.split(",")] if args.numbers else pick["pending"] + CANDIDATES
    with (G / "review-index.csv").open(encoding="utf-8") as f:
        index = {int(r["number"]): r for r in csv.DictReader(f)}
    for d in ("masks_fix", "crops_fix"):
        (G / d).mkdir(exist_ok=True)
    cache_path = G / "boxes.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    detector = eh.Detector(MODEL)
    results = []
    for n in numbers:
        r = index[n]
        photo_id, k = r["id"].rsplit("-", 1)[0].removeprefix("inat-"), int(r["id"].rsplit("-", 1)[1])
        boxes = boxes_for(photo_id, cache, detector)
        if k >= len(boxes):
            print(f"{n}: 枠が見つからない（{r['id']}）")
            continue
        crop, rect = crop_photo(photo_id, boxes[k]["box"])
        m = segment(crop, rect)
        m = fill_holes(m)
        m, stem = remove_stem(m)
        m, cuts = cut_merged(m, crop)
        m64 = sh.normalize(fill_holes(m))
        before = sh.count_lobes(load64(G / "masks" / f"{r['id']}.png"))
        after = sh.count_lobes(m64)
        Image.fromarray(m64 * 255).save(G / "masks_fix" / f"{r['id']}.png")
        Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)).resize((256, 256), Image.BILINEAR).save(G / "crops_fix" / f"{r['id']}.jpg", quality=88)
        results.append({"number": n, "id": r["id"], "observation": r["url"].rsplit("/", 1)[1], "author": r["author"], "license": r["license"],
                         "score": f"{boxes[k]['score']:.2f}", "lobes_before": before, "lobes_after": after, "cuts": cuts,
                         "stem_px": stem, "source": "保留" if n in pick["pending"] else "×の候補"})
        print(f"{n}: 葉の数 {before}→{after}・切った {cuts}・茎など {stem}px")
    cache_path.write_text(json.dumps(cache), encoding="utf-8")

    # 同じ株（同じ観察）をまとめる: 入れる（use）と同じ観察なら「入れる○と同じ株」。候補どうしは、葉の数が 4 で、スコアの高いものを代表に
    use_obs = {index[n]["url"].rsplit("/", 1)[1]: n for n in pick["use"]}
    groups = defaultdict(list)
    for x in results:
        groups[x["observation"]].append(x)
    for obs, xs in groups.items():
        rep = max(xs, key=lambda x: (x["lobes_after"] == 4, float(x["score"])))
        for x in xs:
            if obs in use_obs:
                x["group"] = f"入れる {use_obs[obs]} と同じ株"
            elif len(xs) > 1:
                x["group"] = "代表" if x is rep else f"同じ株（代表は {rep['number']}）"
            else:
                x["group"] = ""
    with (G / "fix-results.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(results[0].keys()))
        w.writeheader()
        w.writerows(results)
    make_sheet(results)


def make_sheet(results):
    CELL, LABEL, GAP, COLS = 128, 46, 14, 3
    font = lambda s, b=False: ImageFont.truetype("C:/Windows/Fonts/meiryob.ttc" if b else "C:/Windows/Fonts/meiryo.ttc", s)
    big, small = font(24, True), font(13)
    rows = math.ceil(len(results) / COLS)
    W = COLS * (CELL * 3 + 8 + GAP * 2)
    sheet = Image.new("RGB", (W, 34 + rows * (CELL + LABEL + GAP)), (250, 252, 246))
    d = ImageDraw.Draw(sheet)
    d.text((8, 6), "左から 元の切り抜き・前のマスク・直したマスク。赤 = 直しても葉の数が 4 にならない", fill=(47, 74, 53), font=font(18, True))
    for k, x in enumerate(results):
        cx = (k % COLS) * (CELL * 3 + 8 + GAP * 2) + GAP
        cy = 34 + (k // COLS) * (CELL + LABEL + GAP)
        sheet.paste(Image.open(G / "crops_fix" / f"{x['id']}.jpg").resize((CELL, CELL)), (cx, cy + LABEL))
        for j, folder in enumerate(("masks", "masks_fix")):
            m = load64(G / folder / f"{x['id']}.png")
            sheet.paste(Image.fromarray(((1 - m) * 255).astype(np.uint8)).resize((CELL, CELL), Image.NEAREST).convert("RGB"), (cx + (CELL + 4) * (j + 1), cy + LABEL))
        bad = x["lobes_after"] != 4
        d.rectangle([cx - 4, cy - 2, cx + CELL * 3 + 12, cy + LABEL + CELL + 3], outline=(214, 59, 59) if bad else (205, 215, 205), width=3 if bad else 1)
        d.text((cx, cy), str(x["number"]), fill=(214, 59, 59) if bad else (47, 74, 53), font=big)
        d.text((cx + 48, cy + 2), f"葉の数 {x['lobes_before']}→{x['lobes_after']}・切った {x['cuts']}" + ("・保留" if x["source"] == "保留" else ""), fill=(47, 74, 53), font=small)
        d.text((cx + 48, cy + 22), x["group"] or f"撮影者 {x['author']}", fill=(120, 90, 30) if x["group"] else (110, 120, 112), font=small)
    sheet.save(G / "sample-sheet-fix.png")
    print(f"→ {G / 'sample-sheet-fix.png'}（{len(results)} 個）")


if __name__ == "__main__":
    main()
