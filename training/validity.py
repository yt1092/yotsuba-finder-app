"""
「今日のよつば」: 作った形（DiT の出力など）が、四つ葉の形として正しいかを確かめる（テスト: training/tests/test_validity.py）

    from validity import is_valid, cleanup, validity_report
    ok, reasons = is_valid(x)        # x: 64×64（0/1、または 0〜1 の小数。0.5 で白黒にする）
    mask = cleanup(binarize(x))      # 後処理のあとの形（アプリで見せる形）
    report = validity_report(xs)     # 通った割合と、通らなかった理由の数

「妥当な形」の決まり（作者の決定 2026-10-27。README の「今日のよつば」）
  1. 0.5 で白黒にする
  2. 後処理（cleanup）: 小さなかけら（MIN_PIECE 画素未満の、離れたかたまり）と、小さな穴（MIN_PIECE 画素未満）を消す。
     いちばん大きいかたまりは、小さくても消さない
  3. 後処理のあとの形が、gacha_shape.check を通る: 葉がちょうど 4 枚・1 つにつながっている・穴がない・面積が全体の 12〜60%
JavaScript の src/lib/gacha-shape.ts に、同じ処理がある（同じ入力で同じ結果になることを、tests/gacha-shape.test.ts で確かめる。
  その入力と答えは training/make_gacha_shape_fixture.py が作る）
"""

from collections import Counter

import cv2
import numpy as np

from gacha_shape import SIZE, check

THRESHOLD = 0.5
MIN_PIECE = 20


def binarize(x) -> np.ndarray:
    a = np.asarray(x, dtype=np.float32)
    if a.ndim == 3:  # (1, 64, 64) などの形も受け取る
        a = a.reshape(a.shape[-2], a.shape[-1])
    if a.shape != (SIZE, SIZE):
        raise ValueError(f"形の大きさは {SIZE}×{SIZE}（受け取った大きさ: {a.shape}）")
    return (a >= THRESHOLD).astype(np.uint8)


def cleanup(b: np.ndarray, min_px: int = MIN_PIECE) -> np.ndarray:
    """小さなかけらと、小さな穴を消す（0/1 の 64×64 → 0/1 の 64×64）
    かけら: 8 方向でつながったかたまりのうち、いちばん大きいもの（同じ大きさなら、上から左から見て先に見つかったもの）以外で、min_px 画素未満のもの
    穴: まわりに 1 画素の余白を足した背景を、4 方向でつながったかたまりに分け、外側（左上の角）以外で min_px 画素未満のもの"""
    b = (np.asarray(b) > 0).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(b, connectivity=8)
    if n > 1:
        areas = st[1:, cv2.CC_STAT_AREA]
        big = 1 + int(np.argmax(areas))
        keep = [i for i in range(1, n) if i == big or st[i, cv2.CC_STAT_AREA] >= min_px]
        b = np.isin(lab, keep).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(np.pad(1 - b, 1, constant_values=1), connectivity=4)
    outside = lab[0, 0]
    holes = [i for i in range(1, n) if i != outside and st[i, cv2.CC_STAT_AREA] < min_px]
    if holes:
        b = b | np.isin(lab, holes)[1:-1, 1:-1].astype(np.uint8)
    return b


def is_valid(x) -> tuple[bool, list[str]]:
    reasons = check(cleanup(binarize(x)))
    return not reasons, reasons


def validity_report(masks) -> dict:
    reasons = Counter()
    ok = 0
    for m in masks:
        good, why = is_valid(m)
        ok += good
        for w in why:
            reasons[w] += 1
    n = len(masks)
    return {"count": n, "valid": ok, "valid_share": ok / n if n else 0.0, "reasons": dict(reasons.most_common())}
