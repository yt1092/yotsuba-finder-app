"""
チュートリアルの背景の画像を、assets-src/ の PNG から WebP に変換して public/images/ に置く（手で 1 回実行する。ビルドでは動かない）

    pip install pillow
    python scripts/make_images.py

  - 品質 約 80。1 枚 300KB 以下（超えたら品質を下げる）。元の幅の版と、幅 640px の版
  - 元の画像は ChatGPT（OpenAI）で生成したもの（CREDITS.md の「画像」）
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src"
OUT = ROOT / "public" / "images"
NAMES = {"tutorial-1-welcome": "tutorial-1", "tutorial-2-find": "tutorial-2", "tutorial-3-teach": "tutorial-3", "tutorial-4-diary": "tutorial-4"}
LIMIT = 300 * 1024


def save(im, path):
    for q in range(80, 40, -5):
        im.save(path, "WEBP", quality=q, method=6)
        if path.stat().st_size <= LIMIT:
            return q
    raise SystemExit(f"{path} が 300KB 以下になりません")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for src, name in NAMES.items():
        im = Image.open(SRC / f"{src}.png").convert("RGB")
        q = save(im, OUT / f"{name}.webp")
        small = im.resize((640, round(im.height * 640 / im.width)), Image.LANCZOS)
        q2 = save(small, OUT / f"{name}-640.webp")
        print(f"{name}: {im.width}×{im.height} → {(OUT / f'{name}.webp').stat().st_size // 1024}KB（品質 {q}）"
              f"・640×{small.height} → {(OUT / f'{name}-640.webp').stat().st_size // 1024}KB（品質 {q2}）")


if __name__ == "__main__":
    main()
