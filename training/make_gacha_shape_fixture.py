"""
「今日のよつば」: Python と JavaScript の後処理・妥当性のチェックが、同じ結果になるかを確かめるための「入力と答え」を作る

    python training/make_gacha_shape_fixture.py

出力: tests/fixtures/gacha-shape-cases.json（Git に入れる。tests/gacha-shape.test.ts が読む）
  1 件 = 白黒の形（後処理の前）・後処理のあとの形・葉の数・かたまりの数・背景のかたまりの数・面積の割合・通らなかった理由・妥当か
  形は、64×64 の 0/1 を、行ごとに左から 8 画素ずつ 1 バイトにまとめ（上の位から）、base64 にしたもの
入力にする形
  - DiT が作った形: 仕上げ前・仕上げ後（数式 0%・20%）から、4 歩・CFG なしで 80 個ずつ（シード 7。data/gacha/dit-out/out の .pt。無ければ飛ばす）
  - 本物の形 28 枚・数式の形 60 個（data/gacha/final）
  - 端のケース: 空・全部・1 画素・2 つのかたまり・大きな穴・細い線
"""

import base64
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from gacha_shape import SIZE, check, count_lobes, components
from validity import MIN_PIECE, cleanup

ROOT = Path(__file__).resolve().parent.parent
FINAL = ROOT / "data" / "gacha" / "final"
OUT = ROOT / "tests" / "fixtures" / "gacha-shape-cases.json"


def pack(m: np.ndarray) -> str:
    return base64.b64encode(np.packbits(m.astype(np.uint8).reshape(-1)).tobytes()).decode("ascii")


def case(name: str, b: np.ndarray) -> dict:
    b = (b > 0).astype(np.uint8)
    c = cleanup(b)
    fg, bg = components(c)
    return {"name": name, "input": pack(b), "cleaned": pack(c), "lobes": sh_lobes(c), "pieces": int(fg), "backgrounds": int(bg),
            "areaRatio": float(c.sum() / (SIZE * SIZE)), "reasons": check(c), "valid": not check(c)}


def sh_lobes(m):
    return int(count_lobes(m))


def edge_cases():
    z = np.zeros((SIZE, SIZE), np.uint8)
    one = z.copy(); one[30, 30] = 1
    full = np.ones((SIZE, SIZE), np.uint8)
    two = z.copy(); cv2.circle(two, (18, 32), 10, 1, -1); cv2.circle(two, (46, 32), 10, 1, -1)
    hole = z.copy(); cv2.circle(hole, (32, 32), 22, 1, -1); cv2.circle(hole, (32, 32), 5, 0, -1)
    line = z.copy(); line[32, 5:60] = 1
    ties = z.copy(); ties[5:9, 5:9] = 1; ties[40:44, 40:44] = 1  # 同じ大きさのかけら（いちばん大きいものが 2 つ）
    return [("empty", z), ("one-pixel", one), ("full", full), ("two-disks", two), ("big-hole", hole), ("thin-line", line), ("tied-pieces", ties)]


def main():
    cases = [case(n, m) for n, m in edge_cases()]
    for p in sorted((FINAL / "real").glob("*.png")):
        cases.append(case(f"real/{p.stem}", (np.asarray(Image.open(p).convert("L")) >= 128)))
    for p in sorted((FINAL / "synthetic").glob("*.png"))[:60]:
        cases.append(case(f"synthetic/{p.stem}", (np.asarray(Image.open(p).convert("L")) >= 128)))
    try:
        import gacha_dit_eval as ev
        for name in ev.MODELS:
            xs = ev.sample(ev.load_model(name), 80, ev.MODELS[name][1], 4, 1.0, 7)
            for i, x in enumerate(xs):
                cases.append(case(f"dit/{name}/{i}", (x >= 0.5)))
    except FileNotFoundError as e:
        print("DiT のモデルが無いので、DiT の形は入れません:", e)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"size": SIZE, "minPiece": MIN_PIECE, "cases": cases}, ensure_ascii=False), encoding="utf-8")
    valid = sum(c["valid"] for c in cases)
    print(f"→ {OUT}（{len(cases)} 件・妥当 {valid} 件・{OUT.stat().st_size / 1024:.0f}KB）")


if __name__ == "__main__":
    main()
