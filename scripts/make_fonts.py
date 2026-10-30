"""
画面の文字のフォント（Zen Maru Gothic 500・700）を、アプリの中の固定の文字だけに減らして（サブセット）、public/fonts/ に woff2 で置く
（手で実行する。画面の文言を変えたら、もう一度実行する）

    pip install fonttools brotli
    python scripts/make_fonts.py

  - 元: node_modules/@fontsource/zen-maru-gothic の「日本語をまとめた版」（ASCII も入っている）。
    そこに無い記号（●○… や矢印など）は、文字の範囲ごとに分かれた版から取って、1 つにまとめる。外への通信はしない
  - 入れる文字: 画面の HTML・src/ の .ts と .css に書いてある文字 ＋ ひらがな・カタカナ全部 ＋ ASCII ＋ よく使う記号
    （利用者が自由に入れる文字で、ここに無いものは、次のフォント（ヒラギノ丸ゴ など）で表示される）
  - 目標: 2 つの太さの合計 300KB 以下
  - ライセンス（SIL Open Font License 1.1）の文書も public/fonts/ に写す
"""

import shutil
from pathlib import Path

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "node_modules" / "@fontsource" / "zen-maru-gothic"
OUT = ROOT / "public" / "fonts"
WEIGHTS = (500, 700)
LIMIT = 300 * 1024


def chars_in_sources() -> set[str]:
    files = list(ROOT.glob("*.html")) + list((ROOT / "src").rglob("*.ts")) + list((ROOT / "src").rglob("*.css"))
    text = "".join(f.read_text(encoding="utf-8") for f in files)
    return {c for c in text if ord(c) >= 0x80}


def base_chars() -> set[str]:
    r = lambda a, b: {chr(c) for c in range(a, b + 1)}
    return (r(0x20, 0x7E) | r(0x3041, 0x3096) | r(0x30A1, 0x30FA) | set("ー・、。「」『』（）［］【】！？：；…〜％＋－×÷＝／＆＃＠★☆●○◎△▲□■←→↑↓♪〇々ゝゞヽヾ　")
            | r(0xFF10, 0xFF19))  # 全角の数字


def subset_to(src: Path, text: str) -> TTFont:
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    font = TTFont(src)
    sub = subset.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)
    return font


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "_parts"
    tmp.mkdir(exist_ok=True)
    chars = chars_in_sources() | base_chars()
    total = 0
    for w in WEIGHTS:
        # 日本語をまとめた版に無い文字（●○… や矢印など）は、文字の範囲ごとに分かれた版から取って、1 つにまとめる
        files = [SRC / "files" / f"zen-maru-gothic-japanese-{w}-normal.woff2"] + sorted((SRC / "files").glob(f"zen-maru-gothic-[0-9]*-{w}-normal.woff2"))
        left = set(chars)
        parts = []
        for f in files:
            have = {chr(c) for c in TTFont(f).getBestCmap()} & left
            if not have:
                continue
            font = subset_to(f, "".join(sorted(have)))
            part = tmp / f"{w}-{len(parts)}.ttf"
            font.flavor = None
            font.save(part)
            parts.append(str(part))
            left -= have
        merged = Merger().merge(parts)
        out = OUT / f"zen-maru-gothic-{w}.woff2"
        merged.flavor = "woff2"
        merged.save(out)
        for p in parts:
            Path(p).unlink()
        size = out.stat().st_size
        total += size
        cmap = merged.getBestCmap()
        missing = "".join(sorted(c for c in left if not c.isspace()))
        print(f"{out.name}: {len(cmap)} 文字（{len(parts)} つの元から）・{size // 1024}KB" + (f"・フォントに無い文字: {missing}" if missing else ""))
    tmp.rmdir()
    print(f"合計 {total // 1024}KB（目標 {LIMIT // 1024}KB 以下）")
    shutil.copy(SRC / "LICENSE", OUT / "OFL-zen-maru-gothic.txt")
    if total > LIMIT:
        raise SystemExit("300KB を超えました")


if __name__ == "__main__":
    main()
