"""
写真を取り直したあと、確認シートの結果（外した枠・外さなかった枠）を、新しい写真の v2 の枠に対応づける

    python training/remap_review.py

写真の大きさが変わると、v2 の検出枠の位置も少し変わる。そこで、取り直す前の枠を新しい写真の大きさに拡大し、
新しく検出された「四つ葉」の枠と、位置で対応づける（IoU が 0.7 以上の組を、重なりの大きい順に 1 対 1 で結ぶ）。
対応づけられなかった新しい四つ葉の枠は「確認済み」にしない（学習ではラベルにせず、目隠しにする）。

入力:  data/inat_negatives/candidates-large.json  … 取り直す前（large）の v2 の枠（確認シートを作ったもの）
       data/inat_negatives/sizes-large.json       … 取り直す前の写真の大きさ
       data/inat_negatives/review-excluded.json・review-excluded-2.json … 確認シートで外した枠
       data/inat_negatives/candidates.json        … 取り直したあとの v2 の枠（スコア 0.3 以上）
出力:  data/inat_negatives/reviewed.json          … { use: [...], excluded: [...], unconfirmed: [...], counts: {...} }
         use = 確認して外さなかった枠（三つ葉のラベルにする）、excluded = 確認で外した枠、unconfirmed = 確認していない枠
"""

import json
from pathlib import Path

from PIL import Image

BASE = Path(__file__).resolve().parent.parent / "data" / "inat_negatives"
MATCH_IOU = 0.7


def iou(a, b):
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / (a[2] * a[3] + b[2] * b[3] - inter)


def main():
    old = [c for c in json.loads((BASE / "candidates-large.json").read_text(encoding="utf-8")) if c["label"] == "four"]
    new = [c for c in json.loads((BASE / "candidates.json").read_text(encoding="utf-8")) if c["label"] == "four"]
    old_sizes = json.loads((BASE / "sizes-large.json").read_text(encoding="utf-8"))
    excluded = set()
    for name in ("review-excluded.json", "review-excluded-2.json"):
        excluded |= set(json.loads((BASE / name).read_text(encoding="utf-8"))["excluded"])

    by_file = {}
    for c in old:
        by_file.setdefault(c["file"], ([], []))[0].append(c)
    for c in new:
        by_file.setdefault(c["file"], ([], []))[1].append(c)

    use, out_excluded, matched_old = [], [], set()
    for file, (olds, news) in by_file.items():
        if not olds or not news:
            continue
        with Image.open(BASE / file) as im:
            W, H = im.size
        ow, oh = old_sizes[file]
        sx, sy = W / ow, H / oh
        scaled = {c["id"]: (c["box"][0] * sx, c["box"][1] * sy, c["box"][2] * sx, c["box"][3] * sy) for c in olds}
        pairs = sorted(((iou(scaled[o["id"]], n["box"]), o["id"], n["id"]) for o in olds for n in news), reverse=True)
        used_new = set()
        for v, oid, nid in pairs:
            if v < MATCH_IOU:
                break
            if oid in matched_old or nid in used_new:
                continue
            matched_old.add(oid)
            used_new.add(nid)
            (out_excluded if oid in excluded else use).append(nid)

    done = set(use) | set(out_excluded)
    unconfirmed = [c["id"] for c in new if c["id"] not in done]
    old_kept = [c for c in old if c["id"] not in excluded]
    counts = {
        "取り直す前の四つ葉の枠（確認済み）": len(old),
        "  そのうち外さなかった枠": len(old_kept),
        "  そのうち外した枠": len(old) - len(old_kept),
        "取り直したあとの四つ葉の枠": len(new),
        "対応づけた: 外さなかった枠（三つ葉のラベルにする）": len(use),
        "対応づけた: 外した枠": len(out_excluded),
        "対応づけられなかった、外さなかった枠（使わない）": sum(1 for c in old_kept if c["id"] not in matched_old),
        "対応づけられなかった、外した枠": sum(1 for c in old if c["id"] in excluded and c["id"] not in matched_old),
        "取り直したあとの四つ葉の枠で、確認していないもの（目隠しにする）": len(unconfirmed),
    }
    (BASE / "reviewed.json").write_text(json.dumps({"use": sorted(use), "excluded": sorted(out_excluded),
                                                    "unconfirmed": sorted(unconfirmed), "counts": counts},
                                                   ensure_ascii=False, indent=1), encoding="utf-8")
    for k, v in counts.items():
        print(f"{k}: {v}")


if __name__ == "__main__":
    main()
