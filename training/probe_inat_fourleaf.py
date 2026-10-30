"""
「今日のよつば」: iNaturalist で、CC0 の四つ葉の写真が、あとどれくらい取れそうかを数える（写真は取らない。数えるだけ）

    python training/probe_inat_fourleaf.py

- 検索の言葉を増やしたとき（ほかの国の言葉など）に、まだ集めていない観察（data/gacha/inat/manifest.csv に無いもの）が何件あるか
- 四つ葉が「ふつうの形」の植物（Oxalis tetraphylla・デンジソウ属 Marsilea）の、CC0 の写真がある観察の数（使うかは作者が決める。四つ葉のクローバーではない）
- iNaturalist の API の利用ルールを守る: 1 秒に 1 回まで・User-Agent にアプリの名前（collect_inat_negatives.py と同じ fetch）
出力: 標準出力と docs/screens/inat-probe.json（Git の対象外）
"""

import json
import urllib.parse

import collect_inat_negatives as base
from collect_inat_fourleaf import OUT_DIR, QUERIES

EXTRA_QUERIES = ["four leaved", "four-leaved", "fourleaf", "4leaf", "lucky clover", "quadrifoglio", "quatre feuilles",
                 "vierblättrig", "vierblättriger", "Glücksklee", "cuatro hojas", "klaver vier", "четырехлистный", "네잎", "四叶"]
GENERA = [{"name": "Trifolium", "rank": "genus"}, {"name": "Oxalis", "rank": "genus"}]
NATURAL_FOUR = [{"name": "Oxalis tetraphylla", "rank": "species"}, {"name": "Marsilea", "rank": "genus"}]


def obs_ids(params: dict, limit: int = 200) -> tuple[int, set[str]]:
    """(全部の件数, はじめの limit 件の観察 ID)"""
    ids, page, total = set(), 1, 0
    while len(ids) < limit:
        q = urllib.parse.urlencode({**params, "photo_license": "cc0", "photos": "true", "per_page": 200, "page": page, "order_by": "id", "order": "asc"})
        res = base.fetch(f"{base.API}/observations?{q}")
        total = res.get("total_results") or 0
        rs = res.get("results") or []
        if not rs:
            break
        ids |= {str(o["id"]) for o in rs}
        if len(rs) < 200:
            break
        page += 1
    return total, ids


def main():
    have = {r["observation_id"] for r in base.load_manifest(OUT_DIR / "manifest.csv")}
    out = {"already_observations": len(have), "terms": {}, "natural_four": {}}
    new_all = set()
    for g in GENERA:
        tid = base.find_taxon_id(g["name"], g["rank"])
        for q in QUERIES + EXTRA_QUERIES:
            total, ids = obs_ids({"q": q, "taxon_id": tid})
            new = ids - have
            new_all |= new
            out["terms"][f"{g['name']}:{q}"] = {"total": total, "new": len(new)}
            print(f"{g['name']}・「{q}」: CC0 の写真がある観察 {total} 件・まだ集めていない {len(new)} 件")
    out["new_observations_total"] = len(new_all)
    print(f"言葉を増やして、まだ集めていない観察: 合わせて {len(new_all)} 件")
    for t in NATURAL_FOUR:
        tid = base.find_taxon_id(t["name"], t["rank"])
        total, _ = obs_ids({"taxon_id": tid}, limit=1)
        out["natural_four"][t["name"]] = total
        print(f"{t['name']}（四つ葉がふつうの植物）: CC0 の写真がある観察 {total} 件")
    path = base.PROJECT_DIR / "docs" / "screens" / "inat-probe.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {path}")


if __name__ == "__main__":
    main()
