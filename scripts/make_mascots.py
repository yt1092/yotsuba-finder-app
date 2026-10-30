"""
キャラクターの表情（4 枚）を、assets-src/ の PNG から、透明つき WebP にして public/images/mascot/ に置く（手で 1 回実行する）

    pip install pillow numpy scipy
    python scripts/make_mascots.py [確かめる画像の出力先フォルダ]

  1. 透明（アルファ）があるか確かめる。無ければ、外側からつながった白だけを消す（キャラクターの中の白い光は残す）
  2. うすいもや（アルファ 16 未満）と、小さな点（48px 未満のかたまり）を消す
  3. アルファの縁を 1px 内側へ削り、縁の色を内側の色に置きかえる（背景の色のにじみを取る）
  4. キャラクター（黄色い線・緑の線も含む）の範囲で切り出し、少しだけ余白を残す。
     体（いちばん大きなかたまり）の高さが 4 枚でそろうように大きさを合わせる。長い辺は 384px 以下
  5. WebP（品質 80・透明つき）。1 枚 60KB 以下
元の画像は ChatGPT（OpenAI）の画像生成で作成（CREDITS.md の「画像」）
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src"
OUT = ROOT / "public" / "images" / "mascot"
FILES = {"surprised": "mascot-surprised.png", "smile": "mascot-smile (2).png", "thinking": "mascot-thinking.png", "happy": "mascot-happy.png"}
BODY_H = 280      # 体の高さ（そろえる。px。smile は横の線で幅が広いので、384px に収まる高さ）
MAX_SIDE = 384
MARGIN = 0.04     # 余白（長い辺に対する割合）
LIMIT = 60 * 1024


def white_to_alpha(rgb):
    """外側からつながった白（ほぼ白）だけを透明にする"""
    white = (rgb.min(axis=2) >= 240)
    lab, _ = ndimage.label(white)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    return np.where(np.isin(lab, list(edge)), 0, 255).astype(np.uint8)


def clean(rgba):
    rgb = rgba[..., :3].astype(np.float32)
    a = rgba[..., 3].astype(np.float32)
    a[a < 16] = 0
    # 小さな点を消す
    lab, n = ndimage.label(a > 0)
    sizes = ndimage.sum(np.ones_like(a), lab, range(1, n + 1))
    for i, s in enumerate(sizes, start=1):
        if s < 48:
            a[lab == i] = 0
    # 縁を 1px 内側へ（まわり 3×3 のいちばん小さいアルファ）
    a = np.minimum(a, ndimage.minimum_filter(a, size=3))
    # 縁の色: 不透明に近いところの色を、まわりへ広げて使う
    solid = (a >= 230).astype(np.float32)
    w = ndimage.uniform_filter(solid, size=7)
    spread = np.stack([ndimage.uniform_filter(rgb[..., c] * solid, size=7) for c in range(3)], axis=2)
    edge = (a > 0) & (a < 230) & (w > 0)
    rgb[edge] = spread[edge] / w[edge][:, None]
    return np.dstack([rgb, a]).clip(0, 255).astype(np.uint8)


def body_height(a):
    lab, n = ndimage.label(a > 0)
    sizes = ndimage.sum(np.ones_like(a, dtype=np.float32), lab, range(1, n + 1))
    ys = np.nonzero(lab == int(np.argmax(sizes)) + 1)[0]
    return ys.max() - ys.min() + 1


def main():
    check_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    OUT.mkdir(parents=True, exist_ok=True)
    made = {}
    for name, file in FILES.items():
        im = Image.open(SRC / file)
        rgba = np.asarray(im.convert("RGBA")).copy()
        if "A" not in im.getbands() or rgba[..., 3].min() == 255:
            print(f"{file}: 透明が無い → 外側の白を消す")
            rgba[..., 3] = white_to_alpha(rgba[..., :3])
        rgba = clean(rgba)
        a = rgba[..., 3]
        ys, xs = np.nonzero(a > 0)
        crop = Image.fromarray(rgba).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        scale = BODY_H / body_height(a)
        w, h = round(crop.width * scale), round(crop.height * scale)
        crop = crop.resize((w, h), Image.LANCZOS)
        pad = round(MARGIN * max(w, h))
        canvas = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
        canvas.alpha_composite(crop, (pad, pad))
        if max(canvas.size) > MAX_SIDE:
            k = MAX_SIDE / max(canvas.size)
            canvas = canvas.resize((round(canvas.width * k), round(canvas.height * k)), Image.LANCZOS)
        path = OUT / f"{name}.webp"
        for q in range(80, 40, -5):
            canvas.save(path, "WEBP", quality=q, alpha_quality=90, method=6)
            if path.stat().st_size <= LIMIT:
                break
        made[name] = canvas
        print(f"{name}: {canvas.width}×{canvas.height}・{path.stat().st_size // 1024}KB（品質 {q}）")

    if check_dir:
        # 白・うすい緑・濃い緑の背景に重ねた見本（高さ 72px と、大きめの 2 通り）
        check_dir.mkdir(parents=True, exist_ok=True)
        for size in (72, 240):
            row = []
            for bg in [(255, 255, 255), (220, 239, 211), (23, 51, 31)]:
                tile = Image.new("RGBA", (round(size * 6.2), size + size // 3), bg + (255,))
                x = size // 4
                for name in FILES:
                    im = Image.open(OUT / f"{name}.webp").convert("RGBA")
                    k = size / im.height
                    im = im.resize((round(im.width * k), size), Image.LANCZOS)
                    tile.alpha_composite(im, (x, size // 6))
                    x += im.width + size // 6
                row.append(tile)
            sheet = Image.new("RGBA", (row[0].width, sum(r.height for r in row)))
            y = 0
            for r in row:
                sheet.paste(r, (0, y))
                y += r.height
            sheet.convert("RGB").save(check_dir / f"mascot-on-backgrounds-{size}px.png")
        print(f"見本: {check_dir}")


if __name__ == "__main__":
    main()
