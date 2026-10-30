"""
見落とした本物の四つ葉を調べる（どんな四つ葉を見落とすか・なぜ見落とすか）

    pip install onnxruntime numpy pillow
    python training/analyze_missed.py data/models/yotsuba-mix-025.onnx --sheet "docs/screens/missed"

  - 写真: training/eval_four_leaf_photos.json の 157 枚（正解の四つ葉 199 個。学習に使っていない）
  - 検出: 写真から探すと同じ（全体＋タイル 80%・しきい値 0.4・確かめない）。training/eval_threshold.py の途中保存
    （しきい値 0.20 で、まとめる前の枠）を使う
  - 見つけた: 正解と同じ場所（IoU 0.3 以上か、小さいほうの重なり 0.6 以上）に、しきい値 0.4 以上の四つ葉の枠がある
  - 見落としの理由（1 つの正解に 1 つ。上から順に当てはめる）
      三つ葉と判定 … 同じ場所に、しきい値 0.4 以上の「三つ葉」の枠がある（四つ葉を三つ葉と答えた）
      スコアが低い … 同じ場所に、四つ葉の枠はあるが、スコアが 0.20〜0.40（しきい値の下）
      何も検出されない … 同じ場所に、どちらの枠もない（スコア 0.20 以上では）
    さらに、見落としに「小さい」「ぼけている」の印を付ける（理由とは別。重なってもよい）
      小さい … 枠の長い辺が、写真の長い辺の 5% 未満
      ぼけている … 枠の中のぼけの強さ（ラプラシアンの分散。小さいほど、ぼけている）が、199 個の下から 1/4 未満
  - 割合を出す区分: 出どころ・枠の大きさ・ぼけの強さ・写真の解像度
  - --sheet: 見落とした正解の切り抜きを並べた確認シート（ローカルで開く HTML。外部への通信はしない）
"""

import argparse
import html
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

import eval_hardneg as eh
import eval_threshold as et

T = 0.4
SMALL = 0.05        # 枠の長い辺 ÷ 写真の長い辺 がこれ未満なら「小さい」
CROP_PX = 240
CONTEXT = 0.4       # 枠の長い辺が、切り抜きの幅のこの割合になるように


def sharpness(image: Image.Image, box) -> float:
    """枠の中のぼけの強さ（ラプラシアンの分散）。大きさをそろえる（長い辺 128px）"""
    x, y, w, h = box
    c = image.crop((int(x), int(y), int(x + w), int(y + h))).convert("L")
    k = 128 / max(c.width, c.height, 1)
    c = c.resize((max(8, round(c.width * k)), max(8, round(c.height * k))), Image.BILINEAR)
    a = np.asarray(c, dtype=np.float32)
    lap = a[1:-1, 1:-1] * -4 + a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:]
    return float(lap.var())


def bins(value, edges, labels):
    for e, l in zip(edges, labels):
        if value < e:
            return l
    return labels[-1]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("--sheet", help="確認シートを作るフォルダ")
    ap.add_argument("--out", default=str(eh.DATA_DIR / "missed.json"))
    args = ap.parse_args()

    _, positives = et.collect(args.model)
    photos = {e["img"]: e for e in json.loads((eh.PROJECT_DIR / "training" / "eval_four_leaf_photos.json").read_text(encoding="utf-8"))}
    rows = []
    for e in positives:
        img = e["key"][4:]
        image = eh.open_image(eh.DATA_DIR / "public" / img)
        W, H = image.size
        at_t = et.at(e["raw"], T)
        at_low = et.at(e["raw"], et.LOW)
        for i, g in enumerate(e["gts"]):
            g = tuple(g)
            fours = [d for d in at_t if d["cls"] == eh.FOUR and eh.same_place(d["box"], g)]
            row = {"img": img, "index": i, "source": img.split("/")[0], "box": g,
                   "size": max(g[2], g[3]) / max(W, H), "long_side": max(W, H),
                   "sharp": sharpness(image, g), "found": bool(fours)}
            if not fours:
                threes = [d for d in at_t if d["cls"] != eh.FOUR and eh.same_place(d["box"], g)]
                low = [d for d in at_low if d["cls"] == eh.FOUR and eh.same_place(d["box"], g)]
                if threes:
                    row["reason"], row["score"] = "三つ葉と判定", max(d["score"] for d in threes)
                elif low:
                    row["reason"], row["score"] = "スコアが低い", max(d["score"] for d in low)
                else:
                    row["reason"], row["score"] = "何も検出されない", None
            rows.append(row)

    q1 = float(np.percentile([r["sharp"] for r in rows], 25))
    q3 = float(np.percentile([r["sharp"] for r in rows], 75))
    for r in rows:
        r["small"] = r["size"] < SMALL
        r["blurry"] = r["sharp"] < q1
    total, found = len(rows), sum(r["found"] for r in rows)
    print(f"■ {args.model}  正解の四つ葉 {total} 個: 見つけた {found} 個（{100 * found / total:.1f}%）・見落とし {total - found} 個（{100 * (total - found) / total:.1f}%）")

    def table(name, key):
        print(f"\n  {name}ごと（見つけた / 全部）")
        groups = defaultdict(list)
        for r in rows:
            groups[key(r)].append(r)
        out = {}
        for k in sorted(groups, key=str):
            g = groups[k]
            f = sum(r["found"] for r in g)
            out[k] = {"found": f, "total": len(g)}
            print(f"    {k}: {f}/{len(g)}（{100 * f / len(g):.0f}%）")
        return out

    summary = {"model": args.model, "total": total, "found": found}
    summary["by_source"] = table("出どころ", lambda r: r["source"])
    summary["by_size"] = table("枠の大きさ（長い辺 ÷ 写真の長い辺）", lambda r: bins(r["size"], [0.05, 0.10, 0.20, 0.35], ["1: 5% 未満", "2: 5〜10%", "3: 10〜20%", "4: 20〜35%", "5: 35% 以上"]))
    summary["by_blur"] = table(f"ぼけの強さ（ラプラシアンの分散。下から 1/4 = {q1:.0f}・3/4 = {q3:.0f}）", lambda r: bins(r["sharp"], [q1, q3], ["1: ぼけている（下から 1/4）", "2: ふつう", "3: くっきり（上から 1/4）"]))
    summary["by_resolution"] = table("写真の解像度（長い辺）", lambda r: bins(r["long_side"], [700, 1300, 2500], ["1: 700px 未満", "2: 700〜1300px", "3: 1300〜2500px", "4: 2500px 以上"]))

    missed = [r for r in rows if not r["found"]]
    reasons = Counter(r["reason"] for r in missed)
    print("\n  見落としの理由（1 つの正解に 1 つ）")
    for k in ["三つ葉と判定", "スコアが低い", "何も検出されない"]:
        print(f"    {k}: {reasons.get(k, 0)}")
    print("  見落としの印（重なってもよい）")
    for k, name in [("small", "小さい（5% 未満）"), ("blurry", "ぼけている（下から 1/4）")]:
        n = sum(r[k] for r in missed)
        all_k = sum(r[k] for r in rows)
        print(f"    {name}: 見落とし {n} 個（その印の正解 {all_k} 個のうち、見落とし {100 * n / max(all_k, 1):.0f}%）")
    cross = Counter((r["reason"], r["small"], r["blurry"]) for r in missed)
    summary["reasons"] = dict(reasons)
    summary["missed_small"] = sum(r["small"] for r in missed)
    summary["missed_blurry"] = sum(r["blurry"] for r in missed)
    summary["cross"] = [{"reason": k[0], "small": k[1], "blurry": k[2], "n": v} for k, v in cross.items()]
    summary["missed"] = [{k: r[k] for k in ("img", "index", "source", "size", "sharp", "reason", "score", "small", "blurry")} for r in missed]
    Path(args.out).write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n  結果: {args.out}")

    if args.sheet:
        make_sheet(Path(args.sheet), missed)


def make_sheet(out: Path, missed):
    (out / "crops").mkdir(parents=True, exist_ok=True)
    order = {"三つ葉と判定": 0, "スコアが低い": 1, "何も検出されない": 2}
    missed = sorted(missed, key=lambda r: (order[r["reason"]], -(r["score"] or 0)))
    cards = []
    for n, r in enumerate(missed):
        image = eh.open_image(eh.DATA_DIR / "public" / r["img"])
        x, y, w, h = r["box"]
        side = max(w, h) / CONTEXT
        cx, cy = x + w / 2, y + h / 2
        left, top = cx - side / 2, cy - side / 2
        c = Image.new("RGB", (round(side), round(side)), (114, 114, 114))
        c.paste(image.crop((int(max(0, left)), int(max(0, top)), int(min(image.width, left + side)), int(min(image.height, top + side)))),
                (int(max(0, -left)), int(max(0, -top))))
        k = CROP_PX / side
        c = c.resize((CROP_PX, CROP_PX), Image.BILINEAR)
        d = ImageDraw.Draw(c)
        bx, by = (x - left) * k, (y - top) * k
        d.rectangle([bx, by, bx + w * k, by + h * k], outline=(245, 194, 66), width=3)
        name = f"{n:03d}.jpg"
        c.save(out / "crops" / name, quality=85)
        tags = [r["reason"]] + (["小さい"] if r["small"] else []) + (["ぼけている"] if r["blurry"] else [])
        score = f"・スコア {r['score']:.2f}" if r["score"] is not None else ""
        cards.append(f'<figure><img src="crops/{name}" alt="" loading="lazy"><figcaption><b>{html.escape("・".join(tags))}</b>{score}<br>'
                     f'{html.escape(r["source"])}・大きさ {100 * r["size"]:.0f}%・ぼけ {r["sharp"]:.0f}<br><small>{html.escape(r["img"].split("/")[-1][:40])}</small></figcaption></figure>')
    page = f"""<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>見落とした四つ葉（{len(missed)} 個）</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 16px; background: #F4F8EE; color: #2F4A35; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }}
figure {{ margin: 0; background: #fff; border-radius: 12px; overflow: hidden; }}
figure img {{ width: 100%; display: block; }}
figcaption {{ padding: 8px 10px; font-size: 15px; line-height: 1.5; }}
</style></head><body>
<h1>見落とした本物の四つ葉（{len(missed)} 個）</h1>
<p>金色の枠 = 正解の四つ葉。並び: 三つ葉と判定 → スコアが低い → 何も検出されない（それぞれスコアの高い順）。「大きさ」は枠の長い辺 ÷ 写真の長い辺、「ぼけ」は小さいほどぼけている。</p>
<div class="grid">
{chr(10).join(cards)}
</div></body></html>"""
    (out / "index.html").write_text(page, encoding="utf-8")
    print(f"  確認シート: {out / 'index.html'}（{len(missed)} 個）")


if __name__ == "__main__":
    main()
