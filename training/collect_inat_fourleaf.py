"""
「今日のよつば」の学習データ: iNaturalist の、四つ葉が写っていそうな観察の写真（CC0 だけ）を集める

    python training/collect_inat_fourleaf.py            # 見つかる分（観察は 1 つの言葉・分類ごとに 200 件まで）
    python training/collect_inat_fourleaf.py --max-obs 30   # 少しだけ試す

- 対象: シロツメクサの仲間（Trifolium 属）と、カタバミ属（Oxalis）の観察のうち、説明文・タグ・名前に
  「four leaf」「four-leaf」「4-leaf」「4 leaf」「quatrefoil」「四つ葉」が入っているもの（iNaturalist の検索 q）
- 写真のライセンスが CC0 のものだけ（観察ごとに、CC0 の写真を 3 枚まで。四つ葉は、どの写真に写っているか分からないため）
- iNaturalist の API の利用ルールを守る: 1 秒に 1 回まで・User-Agent にアプリの名前を入れる（collect_inat_negatives.py と同じ）
- 写真は、iNaturalist の公式の公開データの置き場（inaturalist-open-data）から取る（これも 1 秒に 1 回まで）

出力（data/ は Git の対象外）:
    data/gacha/inat/images/<写真 ID>.jpg
    data/gacha/inat/manifest.csv   … 写真 ID・観察のページ・ライセンス・撮影者・種名・見つけた言葉
途中で止まっても、もう一度実行すると、manifest.csv にある写真は飛ばして続きから集める
"""

import argparse
import csv
import urllib.parse
from pathlib import Path

import collect_inat_negatives as base

OUT_DIR = base.PROJECT_DIR / "data" / "gacha" / "inat"
QUERIES = ["four leaf", "four-leaf", "4-leaf", "4 leaf", "quatrefoil", "四つ葉"]
TAXA = [{"name": "Trifolium", "rank": "genus"}, {"name": "Oxalis", "rank": "genus"}]
FIELDS = ["photo_id", "observation_id", "observation_url", "license", "photographer", "attribution",
          "species", "query", "file", "photo_url"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-obs", type=int, default=200, help="1 つの言葉・分類で見る観察の数の上限")
    ap.add_argument("--photos-per-obs", type=int, default=3)
    args = ap.parse_args()

    (OUT_DIR / "images").mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / "manifest.csv"
    rows = base.load_manifest(path)
    have = {r["photo_id"] for r in rows}
    seen_obs = {r["observation_id"] for r in rows}
    stats = {"observations": 0, "no_cc0": 0, "photos": 0}

    for taxon in TAXA:
        tid = base.find_taxon_id(taxon["name"], taxon["rank"])
        for q in QUERIES:
            got = 0
            page = 1
            while got < args.max_obs:
                params = urllib.parse.urlencode({"q": q, "taxon_id": tid, "photo_license": "cc0", "photos": "true",
                                                 "per_page": 100, "page": page, "order_by": "id", "order": "asc"})
                res = base.fetch(f"{base.API}/observations?{params}")
                results = res.get("results") or []
                print(f"  {taxon['name']}・「{q}」: {page} ページ目 {len(results)} 件（全部で {res.get('total_results')} 件）")
                if not results:
                    break
                for obs in results:
                    got += 1
                    oid = str(obs["id"])
                    if oid in seen_obs:
                        continue
                    seen_obs.add(oid)
                    stats["observations"] += 1
                    cc0 = [p for p in obs.get("photos") or [] if (p.get("license_code") or "").lower() == "cc0"]
                    if not cc0:
                        stats["no_cc0"] += 1
                        continue
                    for p in cc0[: args.photos_per_obs]:
                        pid = str(p["id"])
                        if pid in have:
                            continue
                        url = (p.get("url") or "").replace("square", "large")
                        if not url:
                            continue
                        file = f"images/{pid}{Path(urllib.parse.urlparse(url).path).suffix or '.jpg'}"
                        (OUT_DIR / file).write_bytes(base.fetch(url, binary=True))
                        user = obs.get("user") or {}
                        rows.append({"photo_id": pid, "observation_id": oid, "observation_url": f"https://www.inaturalist.org/observations/{oid}",
                                     "license": "CC0", "photographer": user.get("login") or "", "attribution": p.get("attribution") or "",
                                     "species": (obs.get("taxon") or {}).get("name") or "", "query": q, "file": file, "photo_url": url})
                        have.add(pid)
                        stats["photos"] += 1
                    if len(rows) % 20 == 0:
                        write(path, rows)
                if len(results) < 100:
                    break
                page += 1
    write(path, rows)
    print(f"新しく見た観察 {stats['observations']} 件（CC0 の写真なし {stats['no_cc0']} 件）・新しく取った写真 {stats['photos']} 枚・全部で {len(rows)} 枚")


def write(path: Path, rows):
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main()
