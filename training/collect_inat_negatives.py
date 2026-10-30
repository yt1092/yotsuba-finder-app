"""
再学習用の「四つ葉がない」写真を、iNaturalist から集める（CC0 の写真だけ）

    python training/collect_inat_negatives.py              # 約 600 枚（カタバミ属 300・シロツメクサ 300）
    python training/collect_inat_negatives.py --per-taxon 50   # 少しだけ試す
    python training/collect_inat_negatives.py --redownload --size original   # 集めた写真を、元の大きさ（長い辺 2048px）で取り直す

- 対象: カタバミ属（Oxalis）と、シロツメクサ（Trifolium repens）の、研究グレード（research grade）の観察
- 写真のライセンスが CC0 のものだけを使う（観察ごとに、CC0 の写真を 1 枚だけ。似た写真が並ばないように）
- 1 人の撮影者からは、10 枚まで（同じ人の写真ばかりにならないように）
- 説明文やタグに「四つ葉」「four-leaf」「four leaf」「4-leaf」「lucky」が入っている観察は除く
- iNaturalist の API の利用ルールを守る: 1 秒に 1 回まで・User-Agent にアプリの名前を入れる
- 写真は、iNaturalist の公式の公開データの置き場（inaturalist-open-data）から取る（これも 1 秒に 1 回まで）

出力（data/ は Git の対象外）:
    data/inat_negatives/images/<写真 ID>.jpg
    data/inat_negatives/manifest.csv   … 写真 ID・観察のページ・ライセンス・撮影者・種名など
    data/inat_negatives/summary.json   … 集めた枚数・除いた枚数とその理由

途中で止まっても、もう一度実行すると、manifest.csv にある写真は飛ばして続きから集める。
標準ライブラリだけで動く（追加のインストールはいらない）。
"""

import argparse
import csv
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_DIR / "data" / "inat_negatives"

API = "https://api.inaturalist.org/v1"
OPEN_DATA = "https://inaturalist-open-data.s3.amazonaws.com/photos"
USER_AGENT = "YOTSUBA-FINDER-dataset-collector/1.0 (four-leaf clover finder app; collects CC0 negatives for training)"
MIN_INTERVAL = 1.0  # 1 秒に 1 回まで

# 集める対象（名前と分類の階級で、API から ID を調べる）
TAXA = [
    {"name": "Oxalis", "rank": "genus", "label": "カタバミ属"},
    {"name": "Trifolium repens", "rank": "species", "label": "シロツメクサ"},
]

# この言葉が説明文・タグに入っている観察は除く（四つ葉が写っているかもしれないため）
EXCLUDE_WORDS = ["四つ葉", "four-leaf", "four leaf", "4-leaf", "lucky"]

MANIFEST_FIELDS = ["photo_id", "observation_id", "observation_url", "license", "photographer", "attribution",
                   "species", "taxon_group", "file", "photo_url"]

_last_request = 0.0


def fetch(url, binary=False):
    """1 秒に 1 回までの間隔をあけて取りにいく。失敗したら、少し待って 3 回までやり直す"""
    global _last_request
    for attempt in range(3):
        wait = MIN_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*" if binary else "application/json"})
            with urllib.request.urlopen(req, timeout=60) as res:
                data = res.read()
            return data if binary else json.loads(data)
        except Exception as e:  # noqa: BLE001
            print(f"  取得に失敗（{attempt + 1}/3）: {url} … {e}")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"取得できませんでした: {url}")


def find_taxon_id(name, rank):
    """名前と階級から、iNaturalist の分類の ID を調べる"""
    q = urllib.parse.urlencode({"q": name, "rank": rank, "per_page": 30})
    for t in fetch(f"{API}/taxa?{q}")["results"]:
        if t["name"].lower() == name.lower() and t["rank"] == rank:
            return t["id"]
    raise RuntimeError(f"分類が見つかりません: {name}（{rank}）")


def has_excluded_word(obs):
    """説明文・タグに、除く言葉が入っているか"""
    text = " ".join([obs.get("description") or "", *(obs.get("tags") or [])]).lower()
    return any(w.lower() in text for w in EXCLUDE_WORDS)


def first_cc0_photo(obs):
    """観察の写真のうち、ライセンスが CC0 の最初の 1 枚"""
    for p in obs.get("photos") or []:
        if (p.get("license_code") or "").lower() == "cc0":
            return p
    return None


def load_manifest(path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def redownload(size):
    """manifest.csv の写真を、同じ公開データの置き場から size の大きさで取り直し、images/ のファイルを置き換える。
    ファイル名は変えない。manifest.csv の photo_url を、取り直した URL に書き換える。途中で止まっても、やり直せる"""
    path = OUT_DIR / "manifest.csv"
    rows = load_manifest(path)
    for n, r in enumerate(rows, 1):
        url = r["photo_url"].rsplit("/", 1)[0] + f"/{size}" + Path(r["photo_url"]).suffix
        if r["photo_url"] == url and (OUT_DIR / r["file"]).exists():
            continue  # すでに取り直してある
        tmp = OUT_DIR / (r["file"] + ".part")
        tmp.write_bytes(fetch(url, binary=True))
        tmp.replace(OUT_DIR / r["file"])
        r["photo_url"] = url
        if n % 25 == 0:
            print(f"  {n} / {len(rows)} 枚")
            write_manifest(path, rows)
    write_manifest(path, rows)
    print(f"取り直しました: {len(rows)} 枚（{size}）")


def write_manifest(path, rows):
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--per-taxon", type=int, default=300, help="1 つの分類から集める枚数（2 つの分類で、合わせて約 600 枚）")
    ap.add_argument("--max-per-user", type=int, default=10, help="1 人の撮影者から集める枚数の上限")
    ap.add_argument("--size", default="large", choices=["medium", "large", "original"], help="写真の大きさ（large は長い辺 1024px）")
    ap.add_argument("--redownload", action="store_true",
                    help="manifest.csv にある写真を、--size の大きさで取り直して置き換える（新しい観察は探さない）")
    args = ap.parse_args()
    if args.redownload:
        redownload(args.size)
        return

    img_dir = OUT_DIR / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT_DIR / "manifest.csv"
    rows = load_manifest(manifest_path)
    have = {r["photo_id"] for r in rows}
    seen_obs = {r["observation_id"] for r in rows}
    per_user = {}
    for r in rows:
        per_user[r["photographer"]] = per_user.get(r["photographer"], 0) + 1
    summary = {"collected": {}, "excluded": {"keyword": 0, "no_cc0_photo": 0, "same_user_limit": 0, "already_have": 0}, "taxa": {}}

    new_file = not manifest_path.exists()
    with manifest_path.open("a", encoding="utf-8", newline="") as mf:
        writer = csv.DictWriter(mf, fieldnames=MANIFEST_FIELDS)
        if new_file:
            writer.writeheader()

        for taxon in TAXA:
            taxon_id = find_taxon_id(taxon["name"], taxon["rank"])
            summary["taxa"][taxon["label"]] = {"name": taxon["name"], "rank": taxon["rank"], "taxon_id": taxon_id}
            count = sum(1 for r in rows if r["taxon_group"] == taxon["label"])
            print(f"{taxon['label']}（{taxon['name']}・ID {taxon_id}）: いま {count} 枚")
            id_above = 0
            while count < args.per_taxon:
                # 研究グレード・写真のライセンスが CC0 の観察を、ID の小さい順に、200 件ずつ読む
                q = urllib.parse.urlencode({
                    "taxon_id": taxon_id, "quality_grade": "research", "photo_license": "cc0", "photos": "true",
                    "per_page": 200, "order_by": "id", "order": "asc", "id_above": id_above,
                })
                results = fetch(f"{API}/observations?{q}")["results"]
                if not results:
                    print("  これ以上、観察がありません")
                    break
                for obs in results:
                    id_above = max(id_above, obs["id"])
                    if count >= args.per_taxon:
                        break
                    if str(obs["id"]) in seen_obs:
                        summary["excluded"]["already_have"] += 1
                        continue
                    if has_excluded_word(obs):
                        summary["excluded"]["keyword"] += 1
                        continue
                    photo = first_cc0_photo(obs)
                    if photo is None:
                        summary["excluded"]["no_cc0_photo"] += 1
                        continue
                    pid = str(photo["id"])
                    if pid in have:
                        continue
                    user = obs.get("user") or {}
                    who = user.get("name") or user.get("login") or ""
                    if per_user.get(who, 0) >= args.max_per_user:
                        summary["excluded"]["same_user_limit"] += 1
                        continue
                    # 公式の公開データの置き場から取る（拡張子は、API の URL のものに合わせる）
                    ext = Path(urllib.parse.urlparse(photo["url"]).path).suffix or ".jpg"
                    photo_url = f"{OPEN_DATA}/{pid}/{args.size}{ext}"
                    data = fetch(photo_url, binary=True)
                    file = f"{pid}{ext.lower()}"
                    (img_dir / file).write_bytes(data)
                    row = {
                        "photo_id": pid,
                        "observation_id": str(obs["id"]),
                        "observation_url": f"https://www.inaturalist.org/observations/{obs['id']}",
                        "license": "CC0",
                        "photographer": who,
                        "attribution": photo.get("attribution") or "",
                        "species": (obs.get("taxon") or {}).get("name", ""),
                        "taxon_group": taxon["label"],
                        "file": f"images/{file}",
                        "photo_url": photo_url,
                    }
                    writer.writerow(row)
                    mf.flush()
                    rows.append(row)
                    have.add(pid)
                    seen_obs.add(row["observation_id"])
                    per_user[who] = per_user.get(who, 0) + 1
                    count += 1
                    if count % 25 == 0:
                        print(f"  {count} 枚")
            summary["collected"][taxon["label"]] = count

    summary["collected"]["total"] = len(rows)
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
