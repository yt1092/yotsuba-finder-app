"""
検出スコアと「本物の四つ葉か」の関係を測り、確認のポップアップの「たしかさのめやす」（●●● / ●●○ / ●○○）の境目を決める

    python training/calibrate.py public/models/yotsuba-v3.onnx
    python training/calibrate.py data/models/yotsuba-v4.onnx      （モデルを変えたら、同じ手順で測り直す）
    python training/calibrate.py public/models/yotsuba-v3.onnx --apply   （境目を src/lib/detector-config.ts に書きこむ）

使う写真（どれも学習に使っていない、本物の写真）
  - 四つ葉の写真 157 枚（training/eval_four_leaf_photos.json。正解の四つ葉 199 個）
  - 四つ葉がない写真: three-leaves 100 枚・iNaturalist のテスト専用 60 枚・data/hardcases（評価専用）
  検出は、アプリの「写真から探す」と同じ（全体＋タイル 80%・しきい値 0.4・確かめない）。training/eval_threshold.py の途中保存を使う
  枠が正解の四つ葉と同じ場所（IoU 0.3 以上・小さいほうの重なり 0.6 以上）なら「本物」、それ以外は「誤検出」

漏れを防ぐため、写真の単位で、較正用と評価用に半分ずつ分ける（同じ写真の枠は、必ず同じ側）。
写真の組（四つ葉の写真・three-leaves・iNaturalist・hardcases）ごとに、写真を「本物の枠の数・誤検出の数」の順
（同じなら名前のハッシュの順）に並べて、交互に分ける。枠の多い写真が片方に寄らないように（何回実行しても同じ分け方）

  1. 較正用の半分で、3 つの方法（温度スケーリング・Platt・等張回帰）を当てはめる
  2. 評価用の半分で、ECE（期待較正誤差、10 区間）と Brier を比べ、信頼度の図（SVG）を書く
  3. めやすの境目: 較正用の半分で、「スコアが high 以上の枠の、本物の割合の 95% 下限（片側の Clopper-Pearson）が
     HIGH_TARGET 以上」になる、いちばん低い high を選ぶ。mid も同じく、high 未満・mid 以上の枠で MID_TARGET 以上
  4. 評価用の半分で、各段階の本物の割合と、95% 下限を出す（ここで目標に届いていれば、「○% 以上」と言える）
  境目はスコアで決める（較正の方法は、どれもスコアの順番を変えないので、境目の位置は同じになる）
注意: 本物の割合は、写真の組み合わせ（四つ葉の写真と、四つ葉がない写真の割合）で変わる。ここでの値は、上の写真での値
"""

import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import numpy as np

import eval_hardneg as eh
import eval_threshold as et

THRESHOLD = 0.4          # 写真から探すのしきい値（SCORE_THRESHOLD.photo）
# 目標は、写真の数で決まる。下限 90% と言うには、29 個続けて本物が要る（2026-10-26 の写真では、0.9 以上の枠は半分で約 15 個）
HIGH_TARGET = 0.80       # ●●● … 本物の割合の 95% 下限が、これ以上
MID_TARGET = 0.50        # ●●○ … 本物の割合の 95% 下限が、これ以上（「半分以上は本物」。●○○ は、それより下）
MIN_LEVEL_COUNT = 10     # 1 つの段階に、最低この数の枠
BINS = 10
OUT_DIR = eh.PROJECT_DIR / "training" / "calibration"
# 写真の分け方（較正用 0・評価用 1）。最初に v3 で決めたものを残し、モデルを変えても同じ分け方で測る
# （分け方は、そのモデルの枠の数で決めるので、残さないと、モデルごとに変わってしまう）
SPLIT_FILE = OUT_DIR / "split.json"
CONFIG = eh.PROJECT_DIR / "src" / "lib" / "detector-config.ts"


# ── 区間 ──

def binom_tail_ge(k, n, p):
    """P(X >= k)、X ~ 二項(n, p)"""
    if k <= 0:
        return 1.0
    if p <= 0:
        return 0.0
    if p >= 1:
        return 1.0
    lp, lq = math.log(p), math.log1p(-p)
    return min(1.0, sum(math.exp(math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp + (n - i) * lq) for i in range(k, n + 1)))


def cp_lower(k, n, alpha=0.05):
    """片側 95% の下限（Clopper-Pearson）: P(X >= k | p) = alpha になる p"""
    if k == 0:
        return 0.0
    lo, hi = 0.0, k / n
    for _ in range(60):
        mid = (lo + hi) / 2
        if binom_tail_ge(k, n, mid) < alpha:
            lo = mid
        else:
            hi = mid
    return lo


def cp_upper(k, n, alpha=0.05):
    """片側 95% の上限（Clopper-Pearson）"""
    return 1.0 - cp_lower(n - k, n, alpha) if n else 1.0


def wilson_lower(k, n, z=1.645):
    if n == 0:
        return 0.0
    p = k / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


# ── 較正の方法 ──

def logit(s):
    s = np.clip(s, 1e-6, 1 - 1e-6)
    return np.log(s / (1 - s))


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def nll(p, y):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))


def fit_temperature(s, y):
    z = logit(s)
    grid = np.exp(np.linspace(np.log(0.05), np.log(20), 400))
    t = grid[np.argmin([nll(sigmoid(z / t), y) for t in grid])]
    return lambda q: sigmoid(logit(q) / t), {"T": float(t)}


def fit_platt(s, y):
    """p = sigmoid(a·logit(s) + b)。ニュートン法（Platt の、ラベルを少しならす工夫つき）"""
    z = logit(s)
    n1, n0 = y.sum(), len(y) - y.sum()
    t = np.where(y == 1, (n1 + 1) / (n1 + 2), 1 / (n0 + 2))
    a, b = 1.0, 0.0
    for _ in range(100):
        p = sigmoid(a * z + b)
        g = np.array([np.sum((p - t) * z), np.sum(p - t)])
        w = p * (1 - p) + 1e-9
        h = np.array([[np.sum(w * z * z), np.sum(w * z)], [np.sum(w * z), np.sum(w)]]) + 1e-9 * np.eye(2)
        step = np.linalg.solve(h, g)
        a, b = a - step[0], b - step[1]
        if np.abs(step).max() < 1e-9:
            break
    return lambda q: sigmoid(a * logit(q) + b), {"a": float(a), "b": float(b)}


def fit_isotonic(s, y):
    """等張回帰（PAV）。スコアが上がると、本物の割合が下がらない段の関数"""
    order = np.argsort(s)
    xs, ys = s[order], y[order].astype(float)
    blocks = [[ys[i], 1.0, xs[i], xs[i]] for i in range(len(xs))]  # 平均・数・左端・右端
    out = []
    for blk in blocks:
        out.append(blk)
        while len(out) > 1 and out[-2][0] > out[-1][0]:
            b2, b1 = out.pop(), out.pop()
            n = b1[1] + b2[1]
            out.append([(b1[0] * b1[1] + b2[0] * b2[1]) / n, n, b1[2], b2[3]])
    lefts = np.array([b[2] for b in out])
    vals = np.array([b[0] for b in out])
    return lambda q: vals[np.clip(np.searchsorted(lefts, q, side="right") - 1, 0, len(vals) - 1)], {"steps": len(vals)}


def ece(p, y, bins=BINS):
    edges = np.linspace(0, 1, bins + 1)
    rows, total = [], 0.0
    for i in range(bins):
        m = (p >= edges[i]) & ((p < edges[i + 1]) if i < bins - 1 else (p <= 1))
        if m.sum() == 0:
            rows.append(None)
            continue
        conf, acc = p[m].mean(), y[m].mean()
        total += m.sum() / len(p) * abs(conf - acc)
        rows.append({"n": int(m.sum()), "conf": float(conf), "acc": float(acc)})
    return total, rows


# ── 写真と枠 ──

def half_of(key):
    return int(hashlib.sha1(key.encode("utf-8")).hexdigest(), 16)


def split(photos):
    """写真の組を、（本物の枠の数・誤検出の数・ハッシュ）の順に並べて、交互に較正用（0）・評価用（1）へ"""
    order = sorted(photos, key=lambda k: (sum(photos[k]), photos[k].count(0), half_of(k)))
    return {k: i % 2 for i, k in enumerate(order)}


def detections(model_path, threads):
    negatives, positives = et.collect(model_path, threads)
    groups = {"四つ葉の写真": positives, **negatives}
    saved = json.loads(SPLIT_FILE.read_text(encoding="utf-8")) if SPLIT_FILE.exists() else None
    new_split = {}
    rows = []  # (写真のキー, 組, 半分, スコア, 本物か)
    for gname, items in groups.items():
        per_photo = {}
        for e in items:
            gts = [tuple(g) for g in e.get("gts", [])]
            per_photo[e["key"]] = [(d["score"], int(any(eh.same_place(d["box"], g) for g in gts))) for d in et.fours(e["raw"], THRESHOLD)]
        halves = saved if saved is not None else split({k: [r for _, r in v] for k, v in per_photo.items()})
        missing = [k for k in per_photo if k not in halves]
        if missing:
            raise SystemExit(f"{SPLIT_FILE} に無い写真があります（{len(missing)} 枚）。分け方を作り直すときは、このファイルを消す")
        new_split.update({k: halves[k] for k in per_photo})
        for k, dets in per_photo.items():
            for score, real in dets:
                rows.append((k, gname, halves[k], score, real))
    if saved is None:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        SPLIT_FILE.write_text(json.dumps(new_split, ensure_ascii=False, indent=0), encoding="utf-8")
        print(f"  写真の分け方を残しました: {SPLIT_FILE}（次からは、このファイルの分け方で測る）")
    else:
        print(f"  写真の分け方: {SPLIT_FILE}（前と同じ）")
    return rows, {g: len(v) for g, v in groups.items()}


def choose_levels(s, y):
    """較正用の半分で、境目を選ぶ（high → mid の順。下限の目標を満たす、いちばん低いスコア）"""
    cands = np.unique(s)[::-1]
    high = None
    for c in cands:
        m = s >= c
        if m.sum() >= MIN_LEVEL_COUNT and cp_lower(int(y[m].sum()), int(m.sum())) >= HIGH_TARGET:
            high = float(c)
    if high is None:
        return None, None
    mid = None
    for c in cands[cands < high]:
        m = (s >= c) & (s < high)
        if m.sum() >= MIN_LEVEL_COUNT and cp_lower(int(y[m].sum()), int(m.sum())) >= MID_TARGET:
            mid = float(c)
    return high, mid


def short_value(c, scores):
    """境目 c を、ほかのスコアをまたがない、短い小数にする（切り捨て。c 以上の枠の組は変わらない）"""
    for d in range(2, 7):
        v = math.floor(c * 10 ** d) / 10 ** d
        if not np.any((scores >= v) & (scores < c)):
            return v
    return c


def current_levels():
    m = re.search(r"CONFIDENCE_LEVELS = \{ high: ([0-9.]+), mid: ([0-9.]+) \}", CONFIG.read_text(encoding="utf-8"))
    return float(m.group(1)), float(m.group(2))


def level_table(s, y, high, mid):
    out = []
    for name, m in [("●●● 高め", s >= high), ("●●○ ふつう", (s >= mid) & (s < high)), ("●○○ 低め", s < mid)]:
        k, n = int(y[m].sum()), int(m.sum())
        out.append({"level": name, "real": k, "n": n, "rate": k / n if n else 0.0, "cp_lower": cp_lower(k, n) if n else 0.0,
                    "cp_upper": cp_upper(k, n), "wilson_lower": wilson_lower(k, n)})
    return out


def print_levels(table):
    for r in table:
        print(f"    {r['level']}: 本物 {r['real']}/{r['n']}（{100 * r['rate']:.1f}%・95% 下限 CP {100 * r['cp_lower']:.1f}%"
              f"・Wilson {100 * r['wilson_lower']:.1f}%・95% 上限 CP {100 * r['cp_upper']:.1f}%）")


# ── 信頼度の図（SVG。外のライブラリを使わない）──

def reliability_svg(panels, path, title):
    W, H, P = 260, 260, 36
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{len(panels) * (W + 20) + 20}" height="{H + 80}" font-family="sans-serif" font-size="12">',
           f'<rect width="100%" height="100%" fill="#fff"/><text x="20" y="20" font-size="14" font-weight="bold">{title}</text>']
    for i, (name, rows, e) in enumerate(panels):
        ox, oy = 20 + i * (W + 20), 40
        x = lambda v: ox + P + v * (W - P - 8)
        yv = lambda v: oy + H - P - v * (H - P - 8)
        svg.append(f'<text x="{ox + P}" y="{oy - 4}" font-weight="bold">{name}（ECE {e:.3f}）</text>')
        svg.append(f'<rect x="{x(0)}" y="{yv(1)}" width="{x(1) - x(0)}" height="{yv(0) - yv(1)}" fill="none" stroke="#999"/>')
        svg.append(f'<line x1="{x(0)}" y1="{yv(0)}" x2="{x(1)}" y2="{yv(1)}" stroke="#bbb" stroke-dasharray="4 3"/>')
        for t in (0, 0.5, 1):
            svg.append(f'<text x="{x(t)}" y="{yv(0) + 14}" text-anchor="middle">{t:g}</text><text x="{x(0) - 4}" y="{yv(t) + 4}" text-anchor="end">{t:g}</text>')
        bw = (x(1) - x(0)) / BINS
        for j, r in enumerate(rows):
            if r is None:
                continue
            svg.append(f'<rect x="{x(j / BINS) + 1}" y="{yv(r["acc"])}" width="{bw - 2}" height="{yv(0) - yv(r["acc"])}" fill="#2F9E4F" fill-opacity="0.75"/>')
            svg.append(f'<circle cx="{x(r["conf"])}" cy="{yv(r["conf"])}" r="2.5" fill="#B3261E"/>')
            svg.append(f'<text x="{x(j / BINS) + bw / 2}" y="{yv(r["acc"]) - 3}" text-anchor="middle" font-size="9">{r["n"]}</text>')
        svg.append(f'<text x="{(x(0) + x(1)) / 2}" y="{yv(0) + 28}" text-anchor="middle">予測した確率</text>')
    svg.append(f'<text x="20" y="{H + 72}" font-size="11">緑の棒 = その区間の、本物の割合（評価用の半分）。赤い点 = 区間の予測の平均。棒の上の数 = 枠の数。点線にそろうほど、よく合っている</text>')
    svg.append("</svg>")
    path.write_text("\n".join(svg), encoding="utf-8")


def apply_to_config(high, mid):
    src = CONFIG.read_text(encoding="utf-8")
    new, n = re.subn(r"export const CONFIDENCE_LEVELS = \{ high: [0-9.]+, mid: [0-9.]+ \} as const;",
                     f"export const CONFIDENCE_LEVELS = {{ high: {high}, mid: {mid} }} as const;", src)
    if n != 1:
        raise SystemExit("detector-config.ts の CONFIDENCE_LEVELS が見つかりません")
    CONFIG.write_text(new, encoding="utf-8")
    print(f"  {CONFIG} を書きかえました: high {high}・mid {mid}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--apply", action="store_true", help="決めた境目を src/lib/detector-config.ts に書きこむ")
    args = ap.parse_args()

    rows, photos = detections(args.model, args.threads)
    stem = Path(args.model).stem
    s = np.array([r[3] for r in rows])
    y = np.array([r[4] for r in rows])
    half = np.array([r[2] for r in rows])
    cal, ev = half == 0, half == 1
    print(f"\n■ {args.model}  写真: {photos}")
    print(f"  四つ葉の枠（しきい値 {THRESHOLD}）: 較正用 {cal.sum()} 個（本物 {y[cal].sum()}）・評価用 {ev.sum()} 個（本物 {y[ev].sum()}）")

    methods = {"そのまま（スコア）": (lambda q: q, {}), "温度スケーリング": fit_temperature(s[cal], y[cal]),
               "Platt": fit_platt(s[cal], y[cal]), "等張回帰": fit_isotonic(s[cal], y[cal])}
    panels, result = [], {"model": args.model, "photos": photos, "threshold": THRESHOLD, "methods": {}}
    print("\n  方法 | ECE（評価用） | Brier（評価用） | パラメータ")
    for name, (f, params) in methods.items():
        p = f(s[ev])
        e, bins = ece(p, y[ev])
        brier = float(np.mean((p - y[ev]) ** 2))
        result["methods"][name] = {"ece": e, "brier": brier, "params": params, "bins": bins}
        panels.append((name, bins, e))
        print(f"  {name} | {e:.3f} | {brier:.3f} | {params}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    svg = OUT_DIR / f"reliability-{stem}.svg"
    reliability_svg(panels, svg, f"信頼度の図（{stem}・評価用の半分）")

    high, mid = choose_levels(s[cal], y[cal])
    if high is None or mid is None:
        raise SystemExit("目標を満たす境目が見つかりません（目標を下げるか、写真を増やす）")
    high, mid = short_value(high, s), short_value(mid, s)
    result["levels"] = {"high": high, "mid": mid, "targets": {"high": HIGH_TARGET, "mid": MID_TARGET},
                        "calibration_half": level_table(s[cal], y[cal], high, mid), "evaluation_half": level_table(s[ev], y[ev], high, mid),
                        "all": level_table(s, y, high, mid)}
    print(f"\n  めやすの境目（較正用の半分で決めた）: high {high}・mid {mid}"
          f"（目標: ●●● の 95% 下限 {HIGH_TARGET:.0%} 以上・●●○ は {MID_TARGET:.0%} 以上）")
    for label, key in [("較正用", "calibration_half"), ("評価用", "evaluation_half"), ("全部", "all")]:
        print(f"  {label}:")
        print_levels(result["levels"][key])
    ch, cm = current_levels()
    result["current"] = {"high": ch, "mid": cm, "evaluation_half": level_table(s[ev], y[ev], ch, cm), "all": level_table(s, y, ch, cm)}
    print(f"  （くらべる）今の境目 high {ch}・mid {cm} の、評価用の半分:")
    print_levels(result["current"]["evaluation_half"])
    ok = [r["cp_lower"] >= t for r, t in zip(result["levels"]["evaluation_half"], [HIGH_TARGET, MID_TARGET])]
    result["levels"]["guaranteed_on_evaluation_half"] = {"high": ok[0], "mid": ok[1]}
    print(f"  評価用の半分で、目標に届いたか: ●●● {'○' if ok[0] else '×'}・●●○ {'○' if ok[1] else '×'}")
    out = OUT_DIR / f"calibration-{stem}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  結果: {out}\n  信頼度の図: {svg}")
    if args.apply:
        apply_to_config(high, mid)


if __name__ == "__main__":
    main()
