"""
「今日のよつば」: Colab で学習した DiT（data/gacha/dit-out/out/*.pt）を、パソコンで調べる（CPU で動く）

    python training/gacha_dit_eval.py

モデルの形は training/gacha_dit_src.py（ノートブックの元）の「5. DiT」の節を、そのまま読み込んで使う（同じ定義）
調べること（3 つのモデル × 作るときの歩数 4・8・16 × CFG の強さ 1.0・1.5・2.5。512 個ずつ・同じシード）
  - 正しい形の割合（training/validity.py）。参考に「小さなかけら・小さな穴を消したあと」の割合も出す（アプリで後から直せるか）
  - 形の特徴（谷の比・葉の大きさのばらつき・葉の先の遠さのばらつき・縦横比）の分位点と、本物の基準（gacha_baseline.json の real）との近さ
  - 多様さ: 作った形どうしの重なり（IoU）の平均（小さいほど、いろいろな形）
  - 丸写しのチェック: 学習の形（本物・数式）との、いちばん大きい重なり（8 通りの向き）。目安は本物 0.90・数式 0.94（ノートブックがデータから決めた値）
出力（Git の対象外）
  data/gacha/dit-out/eval.json            … 全部の数
  data/gacha/dit-out/sheet-<model>-<steps>steps.png … 同じシードの 16 個（4 枚葉でない形も、そのまま。赤い枠 = 通らない）
  data/gacha/dit-out/validity-by-steps.png・features-vs-real.png・diversity-vs-cfg.png・nearest-pairs.png
グラフの文字は英語（日本語のフォントが無い環境でも読めるように）
"""

import json
import math
from pathlib import Path

import cv2
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

import gacha_shape as sh  # noqa: E402
from validity import is_valid  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
OUT = ROOT / "data" / "gacha" / "dit-out"
CKPT = OUT / "out"
FINAL = ROOT / "data" / "gacha" / "final"
MODELS = {"pretrain": ("dit_pretrain.pt", 0), "finetune-mix0": ("dit_finetune_mix0.pt", 1), "finetune-mix20": ("dit_finetune_mix20.pt", 1)}
STEPS = [4, 8, 16]
CFGS = [1.0, 1.5, 2.5]
N = 512
SEED = 1
COPY_REAL, COPY_SYN = 0.90, 0.9366   # ノートブックの results.json の copy_threshold_real・copy_threshold_synthetic
METRICS = ["valley_mean", "valley_max", "leaf_cv", "tip_cv", "aspect"]
COLORS = {"pretrain": "#7a7a7a", "finetune-mix0": "#eb6834", "finetune-mix20": "#1baf7a", "real": "#2a78d6"}

# ノートブックの元から、モデルの定義（「## 5. DiT」の節）だけを読み込む
_src = (HERE / "gacha_dit_src.py").read_text(encoding="utf-8")
_model_code = _src[_src.index("import torch.nn as nn"):_src.index("# %% [markdown]\n# ## 6.")]
_ns: dict = {"math": math, "torch": torch}
exec(_model_code.replace("for name, s in SIZES.items():", "for name, s in []:"), _ns)
DiT, SIZES, N_CLASSES, IMG = _ns["DiT"], _ns["SIZES"], _ns["N_CLASSES"], _ns["IMG"]


def load_model(name: str):
    ck = torch.load(CKPT / MODELS[name][0], map_location="cpu", weights_only=False)
    m = DiT(**SIZES[ck["size"]])
    m.load_state_dict(ck["model"])
    return m.eval()


@torch.no_grad()
def sample(model, n, label, steps, cfg, seed):
    """ノートブックの sample と同じ（Euler 法・CFG）。返す値は 0〜1"""
    g = torch.Generator().manual_seed(seed)
    x = torch.randn(n, 1, IMG, IMG, generator=g)
    y = torch.full((n,), label, dtype=torch.long)
    null = torch.full_like(y, N_CLASSES)
    for i in range(steps):
        t = torch.full((n,), i / steps)
        v = model(x, t, y)
        if cfg != 1.0:
            vu = model(x, t, null)
            v = vu + cfg * (v - vu)
        x = x + v / steps
    return (x.clamp(-1, 1).numpy()[:, 0] + 1) / 2


def cleanup(b: np.ndarray, min_px: int = 20) -> np.ndarray:
    """参考: 小さなかけら（min_px 未満の離れたかたまり）と、小さな穴（min_px 未満）を消す"""
    n, lab, st, _ = cv2.connectedComponentsWithStats(b, connectivity=8)
    if n > 1:
        big = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
        b = np.isin(lab, [i for i in range(1, n) if i == big or st[i, cv2.CC_STAT_AREA] >= min_px]).astype(np.uint8)
    inv = 1 - b
    n, lab, st, _ = cv2.connectedComponentsWithStats(np.pad(inv, 1, constant_values=1), connectivity=4)
    holes = [i for i in range(1, n) if i != lab[0, 0] and st[i, cv2.CC_STAT_AREA] < min_px]
    if holes:
        b = b | np.isin(lab, holes)[1:-1, 1:-1].astype(np.uint8)
    return b


def quant(v, q):
    v = np.asarray([x for x in v if not np.isnan(x)])
    return float(np.quantile(v, q)) if len(v) else float("nan")


def d4_all(m):
    out = []
    for k in range(4):
        r = np.rot90(m, k)
        out += [r, np.fliplr(r)]
    return out


def nearest(bins, bank):
    B = torch.from_numpy(bank)
    Bs = B.sum(1)
    best, arg = np.zeros(len(bins)), np.zeros(len(bins), dtype=int)
    for i, b in enumerate(bins):
        V = torch.from_numpy(np.stack([v.reshape(-1) for v in d4_all(b.astype(np.float32))]))
        inter = V @ B.T
        iou = (inter / (V.sum(1, keepdim=True) + Bs[None] - inter).clamp(min=1)).max(0).values
        j = int(iou.argmax())
        best[i], arg[i] = float(iou[j]), j
    return best, arg


def diversity(bins, n=200):
    """作った形どうしの重なり（IoU）の平均（小さいほど、いろいろな形）"""
    X = torch.from_numpy(np.stack([b.reshape(-1) for b in bins[:n]]).astype(np.float32))
    inter = X @ X.T
    s = X.sum(1)
    iou = inter / (s[:, None] + s[None] - inter).clamp(min=1)
    k = len(X)
    return float((iou.sum() - iou.diag().sum()) / (k * (k - 1)))


def load_bank(folder):
    ids = sorted(p.stem for p in (FINAL / folder).glob("*.png"))
    return ids, np.stack([(np.asarray(Image.open(FINAL / folder / f"{i}.png").convert("L")) >= 128).reshape(-1) for i in ids]).astype(np.float32)


def main():
    base = json.loads((HERE / "gacha_baseline.json").read_text(encoding="utf-8"))["real"]["metrics"]
    real_ids, REAL = load_bank("real")
    syn_ids, SYN = load_bank("synthetic")
    results, keep = {}, {}
    for name in MODELS:
        model = load_model(name)
        label = MODELS[name][1]
        for steps in STEPS:
            for cfg in CFGS:
                xs = sample(model, N, label, steps, cfg, SEED)
                bins = [(x >= 0.5).astype(np.uint8) for x in xs]
                valid = [is_valid(b)[0] for b in bins]
                cleaned = [is_valid(cleanup(b))[0] for b in bins]
                feats = [sh.shape_metrics(b) for b, v in zip(bins, valid) if v]  # 特徴は、正しい形だけで測る
                r = {"valid_share": float(np.mean(valid)), "valid_share_after_cleanup": float(np.mean(cleaned)), "diversity_mean_iou": diversity(bins)}
                for k in METRICS:
                    r[k] = {"median": quant([f[k] for f in feats], 0.5), "p10": quant([f[k] for f in feats], 0.1), "p90": quant([f[k] for f in feats], 0.9)}
                r["closeness_to_real"] = float(np.mean([abs(r[k]["median"] - base[k]["median"]) / max(base[k]["p90"] - base[k]["p10"], 1e-6) for k in METRICS]))
                if cfg == 1.0 or steps == 16:
                    br, ar = nearest(bins, REAL)
                    bs, _ = nearest(bins, SYN)
                    r["copy"] = {"real_iou_median": float(np.median(br)), "real_iou_max": float(br.max()), "copy_share_real": float((br > COPY_REAL).mean()),
                                 "syn_iou_median": float(np.median(bs)), "syn_iou_max": float(bs.max()), "copy_share_syn": float((bs > COPY_SYN).mean())}
                    keep[(name, steps, cfg)] = (bins, br, ar)
                key = f"{name}/{steps}steps/cfg{cfg}"
                results[key] = r
                print(f"{key}: valid {r['valid_share']:.2f} (cleanup {r['valid_share_after_cleanup']:.2f}) close {r['closeness_to_real']:.2f} "
                      f"div {r['diversity_mean_iou']:.2f}" + (f" copy-real {r['copy']['copy_share_real']:.3f} max {r['copy']['real_iou_max']:.3f} copy-syn {r['copy']['copy_share_syn']:.3f}" if "copy" in r else ""))
        # 見本シート: 同じシードの 16 個（CFG 1.0）
        for steps in STEPS:
            xs = sample(model, 16, label, steps, 1.0, 123)
            sheet(xs, OUT / f"sheet-{name}-{steps}steps.png", f"{name}  {steps} steps  cfg 1.0  seed 123")
    (OUT / "eval.json").write_text(json.dumps({"baseline_real": base, "results": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    plots(results, base, keep, REAL, real_ids)


def sheet(xs, path, title):
    S, P = 96, 8
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 13)
    big = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 15)
    img = Image.new("RGB", (4 * (S + P) + P, 4 * (S + P + 16) + 30), (250, 252, 246))
    d = ImageDraw.Draw(img)
    d.text((P, 6), title + "   (red = not valid)", fill=(47, 74, 53), font=big)
    for i, x in enumerate(xs):
        b = (x >= 0.5).astype(np.uint8)
        ok, why = is_valid(b)
        r, c = divmod(i, 4)
        X, Y = P + c * (S + P), 30 + r * (S + P + 16)
        img.paste(Image.fromarray(((1 - b) * 255).astype(np.uint8)).resize((S, S), Image.NEAREST).convert("RGB"), (X, Y + 16))
        d.rectangle([X - 2, Y + 14, X + S + 1, Y + S + 17], outline=(214, 59, 59) if not ok else (205, 215, 205), width=3 if not ok else 1)
        lobes = sh.count_lobes(b)
        reason = "ok" if ok else ("pieces" if any("つながって" in w for w in why) else "hole" if any("穴" in w for w in why) else f"{lobes} leaves" if any("葉の数" in w for w in why) else "area")
        d.text((X, Y), f"#{i + 1} {reason}", fill=(214, 59, 59) if not ok else (47, 74, 53), font=font)
    img.save(path)


def plots(results, base, keep, REAL, real_ids):
    names = list(MODELS)
    # 1. 正しい形の割合 × 歩数
    fig, ax = plt.subplots(figsize=(6.5, 4))
    for n in names:
        ax.plot(STEPS, [results[f"{n}/{s}steps/cfg1.0"]["valid_share"] for s in STEPS], "o-", color=COLORS[n], lw=2, label=f"{n} (raw)")
        ax.plot(STEPS, [results[f"{n}/{s}steps/cfg1.0"]["valid_share_after_cleanup"] for s in STEPS], "o--", color=COLORS[n], lw=1.2, label=f"{n} (after cleanup)")
    ax.set_xticks(STEPS)
    ax.set_xlabel("sampling steps (Euler)")
    ax.set_ylabel("valid share (exactly 4 leaves, 1 piece, no hole)")
    ax.set_ylim(0, 1)
    ax.set_title("Valid four-leaf shapes by sampling steps (cfg 1.0)")
    ax.legend(fontsize=8, frameon=False)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    fig.tight_layout()
    fig.savefig(OUT / "validity-by-steps.png", dpi=110)
    plt.close(fig)
    # 2. 特徴 × 本物の基準（16 steps・cfg 1.0。正しい形だけ）
    show = ["valley_mean", "valley_max", "leaf_cv", "aspect"]
    titles = {"valley_mean": "valley ratio (mean)", "valley_max": "shallowest valley ratio", "leaf_cv": "leaf size variation (CV)", "aspect": "aspect ratio"}
    fig, axes = plt.subplots(1, len(show), figsize=(15, 3.8))
    for ax, k in zip(axes, show):
        ax.axvspan(base[k]["p10"], base[k]["p90"], color=COLORS["real"], alpha=0.15, label="real p10-p90")
        ax.axvline(base[k]["median"], color=COLORS["real"], lw=2.4, label="real median")
        for j, n in enumerate(names):
            r = results[f"{n}/16steps/cfg1.0"][k]
            y = 0.25 + 0.25 * j
            ax.plot([r["p10"], r["p90"]], [y, y], color=COLORS[n], lw=3)
            ax.plot(r["median"], y, "o", color=COLORS[n], ms=9, label=n)
        ax.set_ylim(0, 1)
        ax.set_yticks([])
        ax.set_title(titles[k])
        for s in ("top", "right", "left"):
            ax.spines[s].set_visible(False)
    axes[0].legend(fontsize=8, frameon=False, loc="upper left")
    fig.suptitle("Shape features of valid samples (16 steps, cfg 1.0): median and p10-p90 vs real baseline")
    fig.tight_layout()
    fig.savefig(OUT / "features-vs-real.png", dpi=110)
    plt.close(fig)
    # 3. 多様さ × CFG
    fig, ax = plt.subplots(figsize=(6.5, 4))
    for n in names:
        ax.plot(CFGS, [results[f"{n}/16steps/cfg{c}"]["diversity_mean_iou"] for c in CFGS], "o-", color=COLORS[n], lw=2, label=f"{n}: mean IoU between samples")
        ax.plot(CFGS, [results[f"{n}/16steps/cfg{c}"]["valid_share"] for c in CFGS], "s--", color=COLORS[n], lw=1.2, label=f"{n}: valid share")
    ax.set_xticks(CFGS)
    ax.set_xlabel("CFG scale (1.0 = no guidance)")
    ax.set_ylim(0, 1)
    ax.set_title("Diversity (lower IoU = more varied) and validity by CFG (16 steps)")
    ax.legend(fontsize=7, frameon=False)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    fig.tight_layout()
    fig.savefig(OUT / "diversity-vs-cfg.png", dpi=110)
    plt.close(fig)
    # 4. 本物といちばん似た 8 組（仕上げ後・数式 0%・16 steps・cfg 1.0）
    bins, br, ar = keep[("finetune-mix0", 16, 1.0)]
    order = np.argsort(-br)[:8]
    S = 96
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 13)
    img = Image.new("RGB", (8 * (S + 10) + 10, 2 * S + 60), (250, 252, 246))
    d = ImageDraw.Draw(img)
    d.text((10, 4), "Most similar pairs: top = generated (finetune-mix0, 16 steps), bottom = nearest real mask (best of 8 orientations)", fill=(47, 74, 53), font=font)
    for c, i in enumerate(order):
        X = 10 + c * (S + 10)
        img.paste(Image.fromarray(((1 - bins[i]) * 255).astype(np.uint8)).resize((S, S), Image.NEAREST).convert("RGB"), (X, 24))
        img.paste(Image.fromarray(((1 - REAL[ar[i]].reshape(64, 64)) * 255).astype(np.uint8)).resize((S, S), Image.NEAREST).convert("RGB"), (X, 30 + S))
        d.text((X, 34 + 2 * S), f"IoU {br[i]:.2f}", fill=(214, 59, 59) if br[i] > COPY_REAL else (47, 74, 53), font=font)
    img.save(OUT / "nearest-pairs.png")


if __name__ == "__main__":
    main()
