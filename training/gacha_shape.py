"""
「今日のよつば」: 64×64 の四つ葉のシルエット（0/1 の配列）の、形の特徴と、幾何のチェック
（数式で作った形・実物の形・あとで DiT が作る形を、同じ物差しで比べるため。テスト: training/tests/test_gacha_shape.py）

特徴
  - area_ratio   … 面積 ÷ 64×64
  - perimeter    … 周囲の長さ（px。いちばん大きな輪郭の長さ）
  - compactness  … 4π × 面積 ÷ 周囲の長さ²（円は 1。くびれやぎざぎざが多いほど小さい）
  - lobes        … 葉の数（重心から角度ごとに光線をのばした距離の、深い谷 = 葉どうしの境目の数。谷が、両側の葉の先の低いほうの 90% 未満なら境目）
  - sym4         … 4 回の回転対称の強さ（重心をまん中にして 90・180・270 度回したものとの、重なり IoU の平均。1 が完全）
  - depth        … 葉と葉のあいだの深さ（角度ごとの距離のいちばん小さい値 ÷ いちばん大きい値。小さいほど深い）
チェック
  - 葉の数が、ちょうど 4 つ
  - 1 つにつながっている（前景のかたまりが 1 つ）・穴がない（背景が 1 つにつながっている）
  - 面積が AREA_RANGE の中
"""

import math

import cv2
import numpy as np

SIZE = 64
AREA_RANGE = (0.12, 0.60)   # 面積の割合の、よい範囲
VALLEY_RATIO = 0.90         # 谷の距離 ÷ 両側の葉の先の低いほう が、これ以上なら浅い谷（同じ葉の中の凹凸）。数式の形と、作者が選んだ ○ の 20 個で決めた（報告 2026-10-27-gacha-phase2.md）
SMOOTH = 11                 # 角度ごとの距離をなめらかにする区間（1 区間 = 2 度）
RADIUS = 29                 # そろえるとき、中心からいちばん遠い点をこの半径にする
BINS = 180


def radial_profile(m: np.ndarray, bins: int = BINS) -> np.ndarray:
    """重心から見た、角度ごとのいちばん遠い距離。角度ごとに、重心から光線をのばし、形の中にある、いちばん遠い点の距離。
    （輪郭の点を角度の区間に分ける方法では、葉のあいだの細いすき間に、となりの葉のふちのぎざぎざが入り、にせの山ができた）"""
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        return np.zeros(bins)
    cy, cx = ys.mean(), xs.mean()
    ang = (np.arange(bins) + 0.5) / bins * 2 * math.pi - math.pi
    r = np.arange(0, max(m.shape) * 0.75, 0.25 * max(1, max(m.shape) // SIZE))  # 64×64 より大きいマスクにも使えるように（刻みも大きさに合わせる）
    px = np.rint(cx + np.cos(ang)[:, None] * r[None, :]).astype(int)
    py = np.rint(cy + np.sin(ang)[:, None] * r[None, :]).astype(int)
    ok = (px >= 0) & (px < m.shape[1]) & (py >= 0) & (py < m.shape[0])
    inside = np.zeros(px.shape, bool)
    inside[ok] = m[py[ok], px[ok]] > 0
    last = inside.shape[1] - 1 - np.argmax(inside[:, ::-1], axis=1)  # 形の中の、いちばん遠い点
    return np.where(inside.any(axis=1), r[last], 0.0)


def lobe_details(m: np.ndarray) -> tuple[np.ndarray, list[tuple[int, float]], list[tuple[int, float, float]]]:
    """葉の数を数える途中の結果（count_lobes と、原因を調べる図 gacha_lobe_check.py で使う）。
    戻り値: (なめらかにした角度ごとの距離, 残った山 [(角度の区間, 距離)], 残った谷 [(角度の区間, 距離, 谷の比)])
    角度ごとの距離（SMOOTH 区間でなめらかにする）の、山（葉の先）と谷を交互に並べ、
    「谷の距離 ÷ 両側の山の低いほう」（谷の比）が VALLEY_RATIO 以上の谷（浅い谷）を、いちばん浅いものから順に消して、両側の山を 1 つにまとめる。
    （浅い谷 = 同じ葉の中の凹凸。ハートのへこみや、マスクのぎざぎざ）"""
    prof = radial_profile(m)
    if prof.max() <= 0:
        return prof, [], []
    # なめらかにする: となりの SMOOTH 区間の合計（平均の代わり。比を使うので同じ）。距離は 0.25 刻みなので 4 倍して整数にし、
    # 足し算を誤差なしにする（JavaScript の src/lib/gacha-shape.ts と、同じ形で同じ結果にするため。小数の足し算は順番で結果がずれる）
    k, h = SMOOTH, SMOOTH // 2
    q = np.rint(prof * 4).astype(np.int64)
    cs = np.concatenate([[0], np.cumsum(np.concatenate([q[-h:], q, q[:h]]))])
    p = (cs[k:] - cs[:-k]).astype(np.float64)  # p[i] = q[i − h] 〜 q[i + h] の合計（ぐるっと回る）
    n = len(p)
    ext = []  # ("P" か "V", 距離, 角度の区間)
    for i in range(n):
        a, b, c = p[i - 1], p[i], p[(i + 1) % n]
        kind = "P" if (b > a and b >= c) else "V" if (b < a and b <= c) else None
        if kind is None:
            continue
        if ext and ext[-1][0] == kind:  # 同じ種類が続いたら、より山らしい（谷らしい）ほうを残す
            if (kind == "P") == (b > ext[-1][1]):
                ext[-1] = (kind, b, i)
        else:
            ext.append((kind, b, i))
    if len(ext) > 1 and ext[0][0] == ext[-1][0]:  # ぐるっと回ってつながる所
        first, last = ext[0], ext[-1]
        keep = first if (first[1] >= last[1]) == (first[0] == "P") else last
        ext = [keep] + ext[1:-1]
    if len(ext) < 2:
        return p / (4 * k), [(e[2], e[1] / (4 * k)) for e in ext if e[0] == "P"], []
    if ext[0][0] == "V":
        ext = ext[1:] + ext[:1]
    peaks = [(i, v) for t, v, i in ext if t == "P"]
    vals = [(i, v) for t, v, i in ext if t == "V"]  # vals[i] は peaks[i] と peaks[i + 1] のあいだ

    def ratios():
        return [vals[i][1] / min(peaks[i][1], peaks[(i + 1) % len(peaks)][1]) for i in range(len(vals))]
    while len(vals) > 1:
        r = ratios()
        i = int(np.argmax(r))
        if r[i] < VALLEY_RATIO:
            break
        if i == len(vals) - 1:  # 最後の谷（最後の山と最初の山のあいだ）は、並びをずらしてから
            peaks, vals = peaks[1:] + peaks[:1], vals[1:] + vals[:1]
            i -= 1
        peaks[i] = max(peaks[i], peaks[i + 1], key=lambda x: x[1])
        del peaks[i + 1], vals[i]
    px = 1 / (4 * k)  # 返す距離は px に戻す（合計 ÷ 区間の数 ÷ 4）。谷の比は、合計どうしの比のまま（JavaScript と同じ）
    return p * px, [(i, v * px) for i, v in peaks], [(i, v * px, r) for (i, v), r in zip(vals, ratios())]


def count_lobes(m: np.ndarray) -> int:
    """葉の数 = 葉どうしの境目（深い谷）の数（lobe_details）。谷が残らなければ 1（形がなければ 0）"""
    p, peaks, valleys = lobe_details(m)
    if p.max() <= 0:
        return 0
    return max(1, len(valleys))


MIN_HOLE = 4  # これより小さい背景のすき間は、穴とみなさない（ななめにだけ触れた画素でできる、1〜3px のすき間）


def components(m: np.ndarray) -> tuple[int, int]:
    """(前景のかたまりの数・背景のかたまりの数)。背景は、まわりに 1px の余白を足して数える（2 以上なら穴がある）。
    背景のかたまりのうち、MIN_HOLE px より小さいもの（格子のすき間）は数えない"""
    fg, _ = cv2.connectedComponents(m.astype(np.uint8), connectivity=8)
    bg_img = np.pad(1 - m.astype(np.uint8), 1, constant_values=1)
    n, lab, st, _ = cv2.connectedComponentsWithStats(bg_img, connectivity=4)
    outside = lab[0, 0]
    bg = sum(1 for i in range(1, n) if i == outside or st[i, cv2.CC_STAT_AREA] >= MIN_HOLE)
    return fg - 1, bg


def sym4(m: np.ndarray) -> float:
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        return 0.0
    cy, cx = ys.mean(), xs.mean()
    M = np.float32([[1, 0, SIZE / 2 - cx], [0, 1, SIZE / 2 - cy]])
    c = cv2.warpAffine(m.astype(np.uint8), M, (SIZE, SIZE), flags=cv2.INTER_NEAREST)
    ious = []
    for k in (1, 2, 3):
        r = np.rot90(c, k)
        inter = np.logical_and(c, r).sum()
        union = np.logical_or(c, r).sum()
        ious.append(inter / union if union else 0.0)
    return float(np.mean(ious))


def features(m: np.ndarray) -> dict:
    m = (np.asarray(m) > 0).astype(np.uint8)
    area = int(m.sum())
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    perim = float(max((cv2.arcLength(c, True) for c in cnts), default=0.0))
    prof = radial_profile(m)
    fg, bg = components(m)
    return {
        "area_ratio": area / (SIZE * SIZE),
        "perimeter": perim,
        "compactness": 4 * math.pi * area / perim ** 2 if perim else 0.0,
        "lobes": count_lobes(m),
        "sym4": sym4(m),
        "depth": float(prof.min() / prof.max()) if prof.max() > 0 else 0.0,
        "fg_components": fg,
        "bg_components": bg,
    }


def check(m: np.ndarray) -> list[str]:
    """幾何のチェック。通らなかった理由の一覧（空なら通った）"""
    f = features(m)
    reasons = []
    if f["fg_components"] != 1:
        reasons.append("つながっていない" if f["fg_components"] > 1 else "形がない")
    if f["bg_components"] > 1:
        reasons.append("穴がある")
    if f["lobes"] != 4:
        reasons.append(f"葉の数が {f['lobes']}")
    if not (AREA_RANGE[0] <= f["area_ratio"] <= AREA_RANGE[1]):
        reasons.append("面積が小さすぎる" if f["area_ratio"] < AREA_RANGE[0] else "面積が大きすぎる")
    return reasons


def normalize(m: np.ndarray) -> np.ndarray:
    """重心をまん中に、葉がななめ 45 度に来るように回し、いちばん遠い点を RADIUS にして、64×64 にする"""
    ys, xs = np.nonzero(m)
    cy, cx = ys.mean(), xs.mean()
    ang = np.arctan2(ys - cy, xs - cx)
    rad = np.hypot(ys - cy, xs - cx)
    w = rad ** 2  # 遠い点（葉の先）を重く
    theta = math.atan2((w * np.sin(4 * ang)).sum(), (w * np.cos(4 * ang)).sum()) / 4  # 葉の向き（90 度ごと）
    rot = math.degrees(theta) - 45
    scale = RADIUS / max(rad.max(), 1)
    M = cv2.getRotationMatrix2D((cx, cy), rot, scale)
    M[0, 2] += SIZE / 2 - cx
    M[1, 2] += SIZE / 2 - cy
    out = cv2.warpAffine(m.astype(np.uint8) * 255, M, (SIZE, SIZE), flags=cv2.INTER_AREA, borderValue=0)
    return (out >= 128).astype(np.uint8)


def shape_metrics(m: np.ndarray) -> dict:
    """DiT の出力と比べる基準の数（training/gacha_baseline.py）
      - valley_mean … 境目の谷の比の平均（谷の距離 ÷ 両側の葉の先の低いほう。小さいほど、葉がはっきり分かれる）
      - valley_max  … いちばん浅い境目の谷の比（くっつきかけた葉があると大きい）
      - leaf_cv     … 葉の大きさのばらつき（境目で区切った、葉ごとの面積の 変動係数 = 標準偏差 ÷ 平均。0 = 全部同じ）
      - tip_cv      … 葉の先の遠さのばらつき（残った山の距離の 変動係数）
      - aspect      … 縦横比（2 次のモーメントの、短い軸 ÷ 長い軸。1 = 縦横が同じ。向きに関係しない）"""
    m = (np.asarray(m) > 0).astype(np.uint8)
    p, peaks, valleys = lobe_details(m)
    ys, xs = np.nonzero(m)
    out = {"valley_mean": float("nan"), "valley_max": float("nan"), "leaf_cv": float("nan"), "tip_cv": float("nan"), "aspect": float("nan")}
    if len(xs) == 0:
        return out
    cov = np.cov(np.stack([xs, ys]).astype(np.float64))
    ev = np.sort(np.linalg.eigvalsh(cov))
    out["aspect"] = float(math.sqrt(ev[0] / ev[1])) if ev[1] > 0 else float("nan")
    if valleys:
        r = np.array([v[2] for v in valleys])
        out["valley_mean"], out["valley_max"] = float(r.mean()), float(r.max())
    if len(peaks) >= 2:
        t = np.array([v for _, v in peaks])
        out["tip_cv"] = float(t.std() / t.mean())
    if len(valleys) >= 2:
        # 葉ごとの面積: 重心から見た角度で、境目の谷から次の谷までの画素を数える
        cy, cx = ys.mean(), xs.mean()
        ang = np.arctan2(ys - cy, xs - cx)
        cuts = np.sort([(i + 0.5) / BINS * 2 * math.pi - math.pi for i, _, _ in valleys])
        idx = np.searchsorted(cuts, ang) % len(cuts)  # 最後の谷のあとと、最初の谷のまえは、同じ葉
        areas = np.bincount(idx, minlength=len(cuts)).astype(np.float64)
        out["leaf_cv"] = float(areas.std() / areas.mean())
    return out
