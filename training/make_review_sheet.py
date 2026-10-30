"""
再学習用の候補の枠を、人が確かめるための「確認シート」（ローカルで開く HTML。外部への通信はしない）を作る

    python training/make_review_sheet.py                    # 1 回目: 四つ葉の枠の上位 400 個＋三つ葉の見本 150 個（review/）
    python training/make_review_sheet.py --part 2           # 2 回目: 四つ葉の枠の残り（401 個目から）。三つ葉の見本はなし（review2/）

入力:  data/inat_negatives/candidates.json   … v2 が検出した枠（四つ葉・三つ葉。スコア 0.3 以上）
         [{ "id": "<写真ID>-<番号>", "file": "images/<写真ID>.jpg", "label": "four"|"three", "box": [x, y, w, h], "score": 0.0 }]
出力:  data/inat_negatives/review/index.html  … 確認シート（2 回目は review2/）
       data/inat_negatives/review/crops/*.jpg … 枠の切り抜き（まわりの景色を含める。枠の線つき）
       保存する JSON の名前は、1 回目が review-excluded.json、2 回目が review-excluded-2.json

確認シートには、次を並べる:
  - 四つ葉として検出された枠の、すべて（多いときは MAX_FOUR 個まで。スコアの高い順）
  - 三つ葉として検出された枠から、無作為に THREE_SAMPLE 個（ラベルの質を見るため。乱数の種は固定）
1 つずつタップすると「カタバミ・シロツメクサではない（外す）」の印がつく。「保存」で、外す枠の一覧を JSON で保存する
（すべての枠は「三つ葉」として学習に足す前提。外した枠は、学習データに入れない）
"""

import argparse
import html
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw

PROJECT_DIR = Path(__file__).resolve().parent.parent
BASE = PROJECT_DIR / "data" / "inat_negatives"
OUT = BASE / "review"
MAX_FOUR = 400        # 四つ葉の枠は、多いときはこの数まで
THREE_SAMPLE = 150    # 三つ葉の枠から、無作為に選ぶ数
RANDOM_SEED = 42
CROP_PX = 240         # 切り抜きの大きさ
CONTEXT = 0.45        # 枠の長い辺が、切り抜きの幅のこの割合になるように（まわりの景色を含める）


def crop(item, cache):
    """枠のまわりを正方形に切り抜き、枠の線を描く"""
    path = BASE / item["file"]
    if path not in cache:
        cache.clear()  # 写真は 1 枚ずつ開く（メモリを使いすぎないように）
        cache[path] = Image.open(path).convert("RGB")
    im = cache[path]
    x, y, w, h = item["box"]
    side = max(w, h) / CONTEXT
    cx, cy = x + w / 2, y + h / 2
    box = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
    c = Image.new("RGB", (int(side), int(side)), (11, 26, 16))
    c.paste(im.crop(tuple(int(v) for v in box)), (0, 0))
    c = c.resize((CROP_PX, CROP_PX), Image.LANCZOS)
    k = CROP_PX / side
    d = ImageDraw.Draw(c)
    color = (255, 228, 138) if item["label"] == "four" else (255, 255, 255)
    d.rectangle([(x - box[0]) * k, (y - box[1]) * k, (x + w - box[0]) * k, (y + h - box[1]) * k], outline=color, width=3)
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--part", type=int, default=1, choices=[1, 2], help="1: 上位 400 個＋三つ葉の見本、2: 四つ葉の枠の残り")
    args = ap.parse_args()
    out = OUT if args.part == 1 else BASE / "review2"
    suffix = "" if args.part == 1 else "-2"

    items = json.loads((BASE / "candidates.json").read_text(encoding="utf-8"))
    ranked = sorted([i for i in items if i["label"] == "four"], key=lambda i: -i["score"])
    fours = ranked[:MAX_FOUR] if args.part == 1 else ranked[MAX_FOUR:]
    threes_all = [i for i in items if i["label"] == "three"]
    threes = random.Random(RANDOM_SEED).sample(threes_all, min(THREE_SAMPLE, len(threes_all))) if args.part == 1 else []
    (out / "crops").mkdir(parents=True, exist_ok=True)

    cache = {}
    for group in (fours, threes):
        for item in sorted(group, key=lambda i: i["file"]):  # 同じ写真をまとめて開く
            crop(item, cache).save(out / "crops" / f"{item['id']}.jpg", quality=88)

    def cards(group):
        return "\n".join(
            f'<button type="button" class="card" data-id="{html.escape(i["id"])}" aria-pressed="false">'
            f'<img src="crops/{html.escape(i["id"])}.jpg" alt="" loading="lazy"><span class="mark">外す</span></button>'
            for i in group)

    page = PAGE.replace("{{FOUR_COUNT}}", str(len(fours))).replace("{{FOUR_TOTAL}}", str(sum(1 for i in items if i["label"] == "four"))) \
        .replace("{{THREE_COUNT}}", str(len(threes))).replace("{{THREE_TOTAL}}", str(len(threes_all))) \
        .replace("{{FOUR_CARDS}}", cards(fours)).replace("{{THREE_CARDS}}", cards(threes))         .replace("{{SUFFIX}}", suffix).replace("{{PART}}", str(args.part))         .replace("{{FOUR_RANGE}}", "スコアの高い順に" if args.part == 1 else f"1 回目の {MAX_FOUR} 個の残り")
    if args.part == 2:  # 三つ葉の見本の段は出さない
        page = page.replace('<section class="three">', '<section class="three" hidden>')
    (out / "index.html").write_text(page, encoding="utf-8")
    print(f"四つ葉の枠 {len(fours)} 個（全部で {sum(1 for i in items if i['label'] == 'four')} 個）・三つ葉の枠 {len(threes)} 個（全部で {len(threes_all)} 個から無作為に）")
    print(f"確認シート: {out / 'index.html'}")


PAGE = """<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>確認シート {{PART}} - 再学習用の候補の枠</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; font-size: 18px; color: #17331F; background: #EEF6E2; }
  header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 20px; background: #FBFDF6; box-shadow: 0 2px 10px rgba(0,0,0,0.12); }
  header h1 { margin: 0; font-size: 22px; flex: 1 1 320px; }
  header .count { font-size: 18px; font-weight: 700; }
  header button { min-height: 56px; padding: 0 24px; border: none; border-radius: 28px; font-size: 18px; font-weight: 800; cursor: pointer; }
  #save { color: #fff; background: #1D6B33; }
  #clear { color: #17331F; background: #DDEBD3; }
  main { padding: 16px 20px 40px; }
  h2 { margin: 24px 0 6px; font-size: 22px; }
  p.help { margin: 0 0 12px; color: #4C6B54; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .card { position: relative; padding: 0; border: 4px solid transparent; border-radius: 14px; overflow: hidden; background: #0B1A10; cursor: pointer; }
  .card img { display: block; width: 100%; aspect-ratio: 1; }
  .card .mark { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; font-size: 28px; font-weight: 900; color: #fff; background: rgba(179,38,30,0.55); }
  .card[aria-pressed="true"] { border-color: #B3261E; }
  .card[aria-pressed="true"] .mark { display: flex; }
  .card:focus-visible { outline: 4px solid #F2B84B; }
</style>
</head>
<body>
<header>
  <h1>確認シート {{PART}}: カタバミ・シロツメクサではない枠を「外す」</h1>
  <span class="count">外す: <span id="excluded">0</span> 個</span>
  <button type="button" id="clear">印をすべて消す</button>
  <button type="button" id="save">保存（JSON）</button>
</header>
<main>
  <p class="help">枠の中が、カタバミ・シロツメクサの葉でないとき（ほかの植物・地面・花など）は、タップして「外す」の印をつけてください。もう一度タップすると、印が消えます。印は、このブラウザに自動で残ります。終わったら「保存（JSON）」を押してください。</p>
  <h2>四つ葉として検出された枠（{{FOUR_RANGE}} {{FOUR_COUNT}} 個 / 全部で {{FOUR_TOTAL}} 個）</h2>
  <p class="help">黄色の線が、検出された枠です。すべて「三つ葉」として学習に足す予定です。</p>
  <div class="grid">
{{FOUR_CARDS}}
  </div>
  <section class="three">
  <h2>三つ葉として検出された枠（無作為に {{THREE_COUNT}} 個 / 全部で {{THREE_TOTAL}} 個）</h2>
  <p class="help">白い線が、検出された枠です。ラベルの質を見るための見本です。</p>
  <div class="grid">
{{THREE_CARDS}}
  </div>
  </section>
</main>
<script>
  // 印は localStorage に残す（このファイルだけで動く。外部への通信はしない）
  const KEY = 'yotsuba-review-excluded{{SUFFIX}}';
  const excluded = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  const cards = [...document.querySelectorAll('.card')];
  const render = () => {
    for (const c of cards) c.setAttribute('aria-pressed', String(excluded.has(c.dataset.id)));
    document.getElementById('excluded').textContent = excluded.size;
    localStorage.setItem(KEY, JSON.stringify([...excluded]));
  };
  for (const c of cards) c.addEventListener('click', () => {
    excluded.has(c.dataset.id) ? excluded.delete(c.dataset.id) : excluded.add(c.dataset.id);
    render();
  });
  document.getElementById('clear').addEventListener('click', () => {
    if (confirm('印を、すべて消しますか？')) { excluded.clear(); render(); }
  });
  document.getElementById('save').addEventListener('click', () => {
    const shown = cards.map(c => c.dataset.id);
    const data = { savedAt: new Date().toISOString(), shown: shown.length, excluded: [...excluded].filter(id => shown.includes(id)).sort() };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'review-excluded{{SUFFIX}}.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  render();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
