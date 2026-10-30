# %% [markdown]
# # 今日のよつば: 小さな DiT（四つ葉の形を作る）
#
# - 64×64・白黒 1 チャンネルの四つ葉の形を作る、小さな DiT（Diffusion Transformer）。公式の DiT のコードは使わず、自分で書いたもの
# - 学習のしかた: rectified flow（ノイズから形へ、まっすぐ進む向きを学ぶ）。作るときは Euler 法で 8〜16 歩
# - 2 段階で学習する
#   1. **先に学習**: 数式で作った形（2,622 個）
#   2. **仕上げ**: 本物の四つ葉の形（28 枚・21 株。小さい学習率・少ない歩数）。式を 0% と 20% 混ぜた 2 つを作って比べる（1 回だけ）
# - 「仕上げ前」と「仕上げ後」を両方保存し、形の特徴（谷の比・葉の大きさのばらつき・縦横比）が本物に近づいたかを比べる
# - **丸写しのチェック**（いちばん似た学習の形との重なり）と、**妥当性のチェック**（葉がちょうど 4 枚か）をする
# - 出どころ: 本物は iNaturalist の CC0 の写真から取り出した形。数式の形は自作。ネットの画像は使わない
#
# 動かし方は `docs/reports/2026-10-27-gacha-colab.md`（上から順に、セルを実行するだけ）

# %% [markdown]
# ## 1. 設定
# ふつうは、変えなくてよい。時間がかかりすぎるときは `PRETRAIN_STEPS` を小さくする。
# `MODEL_SIZE` は `"base"`（幅 192・約 4.2M パラメータ）か `"small"`（幅 128・約 1.9M）。

# %%
import os

IN_COLAB = "COLAB_RELEASE_TAG" in os.environ or os.path.exists("/content")
QUICK = os.environ.get("GACHA_QUICK") == "1"   # パソコンでの、ごく短い試し（作者のパソコンでの確認用）

CONFIG = {
    "DRIVE_DIR": "/content/drive/MyDrive/yotsuba-gacha",   # Google ドライブの、このフォルダに final.zip を置く。結果もここに保存
    "MODEL_SIZE": "base",          # "base"（幅 192）か "small"（幅 128）
    "PRETRAIN_STEPS": 20000,       # 先に学習（数式の形）の歩数。T4 で 約 20〜30 分の見込み（見積もり）
    "FINETUNE_STEPS": 1500,        # 仕上げ（本物の形）の歩数
    "BATCH": 256,
    "LR_PRETRAIN": 3e-4,
    "LR_FINETUNE": 3e-5,           # 仕上げは小さい学習率
    "CFG_DROP": 0.1,               # 学習のとき、ラベルを「なし」にする割合（CFG のため）
    "MIX_SYNTHETIC": [0.0, 0.2],   # 仕上げのとき、数式の形を混ぜる割合（2 つ作って比べる。1 回だけ）
    "SAMPLE_STEPS": [8, 16],       # 作るときの歩数（Euler）
    "CFG_SCALES": [1.0, 1.5, 2.5], # 作るときの CFG の強さ（1.0 = CFG なし）
    "N_EVAL": 512,                 # 比べるときに作る形の数
    "COPY_IOU": 0.90,              # 丸写しの疑いの目安の下限。実際の目安は「別の株の本物どうしの、いちばん大きい重なり」と、この大きいほう
    "SEED": 0,
}
if QUICK:
    CONFIG.update({"DRIVE_DIR": os.environ.get("GACHA_QUICK_DIR", "quick-run"), "PRETRAIN_STEPS": 30, "FINETUNE_STEPS": 10, "BATCH": 16,
                   "SAMPLE_STEPS": [4], "CFG_SCALES": [1.0, 1.5], "N_EVAL": 16})
    if os.environ.get("GACHA_QUICK_STEPS"):  # 学習が進むかだけを見る、少し長い試し
        CONFIG.update({"PRETRAIN_STEPS": int(os.environ["GACHA_QUICK_STEPS"]), "BATCH": 64, "SAMPLE_STEPS": [16], "CFG_SCALES": [1.0], "N_EVAL": 64})
print(CONFIG)

# %% [markdown]
# ## 2. Google ドライブにつなぎ、データを広げる
# 初めて実行すると、Google のアカウントの確認が出る。許可する。

# %%
import shutil
import sys
import zipfile

if IN_COLAB and not QUICK:
    from google.colab import drive
    drive.mount("/content/drive")
DRIVE = CONFIG["DRIVE_DIR"]
ZIP = os.path.join(DRIVE, "final.zip")
WORKDIR = "/content/gacha" if IN_COLAB and not QUICK else os.path.join(DRIVE, "work")
OUT = os.path.join(DRIVE, "out")
os.makedirs(OUT, exist_ok=True)
if not os.path.exists(os.path.join(WORKDIR, "final")):
    os.makedirs(WORKDIR, exist_ok=True)
    with zipfile.ZipFile(ZIP) as z:
        z.extractall(WORKDIR)
DATA = os.path.join(WORKDIR, "final")
sys.path.insert(0, os.path.join(DATA, "code"))
import gacha_shape as sh  # noqa: E402  形の特徴と、幾何のチェック（training/gacha_shape.py の写し）
from validity import is_valid, validity_report  # noqa: E402
print("データ:", DATA, os.listdir(DATA))

# %% [markdown]
# ## 3. 妥当性のチェックが正しく動くかを、先に確かめる（4 枚・3 枚・5 枚の形）

# %%
import math

import cv2
import numpy as np


def polar_shape(lobes, base=0.2, scale=26):
    t = np.linspace(0, 2 * math.pi, 720, endpoint=False)
    r = base + (1 - base) * np.abs(np.cos(lobes / 2 * t))
    pts = np.stack([32 + scale * r * np.cos(t), 32 + scale * r * np.sin(t)], 1).round().astype(np.int32)
    m = np.zeros((64, 64), np.uint8)
    cv2.fillPoly(m, [pts], 1)
    return m


assert is_valid(polar_shape(4))[0], "4 枚の形が、通らない"
assert not is_valid(polar_shape(3))[0], "3 枚の形が、通ってしまう"
assert not is_valid(polar_shape(5))[0], "5 枚の形が、通ってしまう"
assert not is_valid(np.zeros((64, 64)))[0], "空の形が、通ってしまう"
print("妥当性のチェック: OK")

# %% [markdown]
# ## 4. データを読む
# - 本物: `real.csv` の重み（株ごとに 1 枚分・1 人の撮影者は全体の 1/2 まで）の割合で、くじ引きのように選ぶ
# - 水増し: 90 度ずつの回転と、左右反転（8 通り）。四つ葉は 90 度ごとに同じ形なので、向きのそろえ方がくずれない

# %%
import csv as _csv

import torch
from PIL import Image

torch.manual_seed(CONFIG["SEED"])
np.random.seed(CONFIG["SEED"])
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
print("計算に使うもの:", DEVICE, torch.cuda.get_device_name(0) if DEVICE == "cuda" else "")


def load_masks(folder, ids):
    arr = np.stack([(np.asarray(Image.open(os.path.join(folder, f"{i}.png")).convert("L")) >= 128).astype(np.float32) for i in ids])
    return torch.from_numpy(arr[:, None] * 2 - 1)  # 0/1 → -1/+1


with open(os.path.join(DATA, "real.csv"), encoding="utf-8") as f:
    real_meta = list(_csv.DictReader(f))
with open(os.path.join(DATA, "synthetic.csv"), encoding="utf-8") as f:
    syn_ids = [r["id"] for r in _csv.DictReader(f)]
REAL = load_masks(os.path.join(DATA, "real"), [r["id"] for r in real_meta])
REAL_W = torch.tensor([float(r["weight"]) for r in real_meta])
SYN = load_masks(os.path.join(DATA, "synthetic"), syn_ids)
print(f"本物 {len(REAL)} 枚（重みの合計 {REAL_W.sum():.2f}）・数式 {len(SYN)} 個")


def d4(x):
    """1 つずつ、8 通りの向き（90 度の回転 × 左右反転）のどれかにする"""
    k = torch.randint(0, 4, (x.shape[0],))
    f = torch.rand(x.shape[0]) < 0.5
    out = torch.empty_like(x)
    for kk in range(4):
        for ff in (False, True):
            sel = (k == kk) & (f == ff)
            if sel.any():
                y = torch.rot90(x[sel], kk, dims=(2, 3))
                out[sel] = torch.flip(y, dims=(3,)) if ff else y
    return out


def batch_from(n, mix_synthetic=None, synthetic_only=False):
    """ラベル: 0 = 数式・1 = 本物（2 = ラベルなし は学習の中で付ける）"""
    if synthetic_only:
        idx = torch.randint(0, len(SYN), (n,))
        return d4(SYN[idx]), torch.zeros(n, dtype=torch.long)
    n_syn = int(round(n * (mix_synthetic or 0.0)))
    n_real = n - n_syn
    ridx = torch.multinomial(REAL_W, n_real, replacement=True)
    xs, ys = [REAL[ridx]], [torch.ones(n_real, dtype=torch.long)]
    if n_syn:
        xs.append(SYN[torch.randint(0, len(SYN), (n_syn,))])
        ys.append(torch.zeros(n_syn, dtype=torch.long))
    return d4(torch.cat(xs)), torch.cat(ys)

# %% [markdown]
# ## 5. DiT（自分で書いたもの）
# - 64×64 を 8×8 の小片に分ける（64 個のトークン）
# - 深さ 6・幅 192（small は 128）・ヘッド 3（small は 2）。パラメータ: base 4.18M・small 1.88M（作者のパソコンで数えた）
# - adaLN-Zero: 時刻とラベルから、各ブロックのずらし・倍率・ゲートを作る。ゲートは 0 から始める（学習のはじめは、ブロックが何もしない）

# %%
import torch.nn as nn
import torch.nn.functional as F

SIZES = {"base": {"width": 192, "heads": 3}, "small": {"width": 128, "heads": 2}}
PATCH, IMG, DEPTH, N_CLASSES = 8, 64, 6, 2


def sincos_2d(width, grid):
    """2 次元の位置の印（学習しない sin・cos）"""
    def one(n, pos):
        omega = 1.0 / (10000 ** (torch.arange(n // 2, dtype=torch.float32) / (n // 2)))
        a = pos[:, None] * omega[None]
        return torch.cat([torch.sin(a), torch.cos(a)], 1)
    ys, xs = torch.meshgrid(torch.arange(grid, dtype=torch.float32), torch.arange(grid, dtype=torch.float32), indexing="ij")
    return torch.cat([one(width // 2, ys.reshape(-1)), one(width // 2, xs.reshape(-1))], 1)


def time_embed(t, dim=256):
    half = dim // 2
    freqs = torch.exp(-math.log(10000) * torch.arange(half, device=t.device, dtype=torch.float32) / half)
    a = t[:, None].float() * 1000 * freqs[None]
    return torch.cat([torch.cos(a), torch.sin(a)], 1)


class Block(nn.Module):
    def __init__(self, w, heads):
        super().__init__()
        self.heads = heads
        self.norm1 = nn.LayerNorm(w, elementwise_affine=False, eps=1e-6)
        self.qkv = nn.Linear(w, 3 * w)
        self.proj = nn.Linear(w, w)
        self.norm2 = nn.LayerNorm(w, elementwise_affine=False, eps=1e-6)
        self.mlp = nn.Sequential(nn.Linear(w, 4 * w), nn.GELU(approximate="tanh"), nn.Linear(4 * w, w))
        self.ada = nn.Sequential(nn.SiLU(), nn.Linear(w, 6 * w))
        nn.init.zeros_(self.ada[1].weight)
        nn.init.zeros_(self.ada[1].bias)

    def forward(self, x, c):
        s1, b1, g1, s2, b2, g2 = self.ada(c)[:, None].chunk(6, dim=2)
        h = self.norm1(x) * (1 + s1) + b1
        B, N, W = h.shape
        q, k, v = self.qkv(h).reshape(B, N, 3, self.heads, W // self.heads).permute(2, 0, 3, 1, 4)
        a = F.scaled_dot_product_attention(q, k, v).transpose(1, 2).reshape(B, N, W)
        x = x + g1 * self.proj(a)
        h = self.norm2(x) * (1 + s2) + b2
        return x + g2 * self.mlp(h)


class DiT(nn.Module):
    def __init__(self, width, heads, depth=DEPTH):
        super().__init__()
        self.embed = nn.Conv2d(1, width, PATCH, PATCH)
        self.register_buffer("pos", sincos_2d(width, IMG // PATCH)[None])
        self.t_mlp = nn.Sequential(nn.Linear(256, width), nn.SiLU(), nn.Linear(width, width))
        self.label = nn.Embedding(N_CLASSES + 1, width)  # 最後の 1 つ = ラベルなし（CFG のため）
        self.blocks = nn.ModuleList([Block(width, heads) for _ in range(depth)])
        self.norm = nn.LayerNorm(width, elementwise_affine=False, eps=1e-6)
        self.ada = nn.Sequential(nn.SiLU(), nn.Linear(width, 2 * width))
        self.out = nn.Linear(width, PATCH * PATCH)
        for m in (self.ada[1], self.out):
            nn.init.zeros_(m.weight)
            nn.init.zeros_(m.bias)

    def forward(self, x, t, y):
        h = self.embed(x).flatten(2).transpose(1, 2) + self.pos
        c = self.t_mlp(time_embed(t)) + self.label(y)
        for b in self.blocks:
            h = b(h, c)
        s, sh_ = self.ada(c)[:, None].chunk(2, dim=2)
        h = self.out(self.norm(h) * (1 + s) + sh_)
        g = IMG // PATCH
        return h.reshape(-1, g, g, PATCH, PATCH).permute(0, 1, 3, 2, 4).reshape(-1, 1, IMG, IMG)


for name, s in SIZES.items():
    print(f"{name}: パラメータ {sum(p.numel() for p in DiT(**s).parameters()) / 1e6:.2f}M")

# %% [markdown]
# ## 6. 学習と、形を作る関数（rectified flow・Euler 法・CFG）
# - x0 = ノイズ、x1 = 形。途中 x_t = (1 − t)·x0 + t·x1。モデルは向き v = x1 − x0 を当てる
# - 作るとき: ノイズから、v の向きに歩数ぶん進む。CFG は v = v(ラベルなし) + 強さ ×（v(ラベルあり) − v(ラベルなし)）

# %%
import copy
import time


TRAIN_LOG = {}  # 学習の記録（損失・かかった時間）。11 で train_log.json と loss.png に保存する


def train(model, steps, lr, make_batch, tag, log_name):
    """log_name: 記録とグラフに使う英語の名前（グラフの文字が化けないように）"""
    log = TRAIN_LOG.setdefault(log_name, {"step": [], "loss": [], "steps": steps, "lr": lr})
    model.train().to(DEVICE)
    ema = copy.deepcopy(model).eval()
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.0)
    use_amp = DEVICE == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    t0 = time.time()
    for step in range(1, steps + 1):
        x1, y = make_batch(CONFIG["BATCH"])
        x1, y = x1.to(DEVICE), y.to(DEVICE)
        y = torch.where(torch.rand(len(y), device=DEVICE) < CONFIG["CFG_DROP"], torch.full_like(y, N_CLASSES), y)
        x0 = torch.randn_like(x1)
        t = torch.sigmoid(torch.randn(len(x1), device=DEVICE))  # 真ん中あたりの t を多めに（logit-normal）
        xt = (1 - t)[:, None, None, None] * x0 + t[:, None, None, None] * x1
        with torch.autocast("cuda", dtype=torch.float16, enabled=use_amp):
            loss = F.mse_loss(model(xt, t, y).float(), x1 - x0)
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt)
        scaler.update()
        with torch.no_grad():
            d = 0.999 if steps > 500 else 0.9
            for pe, pm in zip(ema.parameters(), model.parameters()):
                pe.mul_(d).add_(pm.detach(), alpha=1 - d)
        if step % max(1, steps // 200) == 0 or step == steps:
            log["step"].append(step)
            log["loss"].append(float(loss.item()))
        if step % max(1, steps // 20) == 0 or step == steps:
            print(f"[{tag}] {step}/{steps} 損失 {loss.item():.4f}（{time.time() - t0:.0f} 秒）")
    log["seconds"] = round(time.time() - t0, 1)
    log["device"] = torch.cuda.get_device_name(0) if DEVICE == "cuda" else "cpu"
    return ema


@torch.no_grad()
def sample(model, n, label, steps=16, cfg=1.5, seed=0):
    g = torch.Generator(device="cpu").manual_seed(seed)
    model.eval().to(DEVICE)
    x = torch.randn(n, 1, IMG, IMG, generator=g).to(DEVICE)
    y = torch.full((n,), label, dtype=torch.long, device=DEVICE)
    null = torch.full_like(y, N_CLASSES)
    for i in range(steps):
        t = torch.full((n,), i / steps, device=DEVICE)
        v = model(x, t, y)
        if cfg != 1.0:
            vu = model(x, t, null)
            v = vu + cfg * (v - vu)
        x = x + v / steps
    return (x.clamp(-1, 1).cpu().numpy()[:, 0] + 1) / 2  # 0〜1（0.5 で白黒にする）

# %% [markdown]
# ## 7. 先に学習（数式の形だけ）→ 「仕上げ前」として保存

# %%
size = SIZES[CONFIG["MODEL_SIZE"]]
pre = train(DiT(**size), CONFIG["PRETRAIN_STEPS"], CONFIG["LR_PRETRAIN"], lambda n: batch_from(n, synthetic_only=True), "先に学習", "pretrain")
torch.save({"model": pre.state_dict(), "size": CONFIG["MODEL_SIZE"], "config": CONFIG}, os.path.join(OUT, "dit_pretrain.pt"))
print("保存:", os.path.join(OUT, "dit_pretrain.pt"))

# %% [markdown]
# ## 8. 仕上げ（本物の形・小さい学習率・少ない歩数）→ 「仕上げ後」として保存
# 数式の形を 0% 混ぜたものと、20% 混ぜたものの 2 つを作る（比べるのは 1 回だけ）。どちらも「仕上げ前」から始める。

# %%
finetuned = {}
for mix in CONFIG["MIX_SYNTHETIC"]:
    start = DiT(**size)
    start.load_state_dict(pre.state_dict())
    tag = f"仕上げ（数式 {int(mix * 100)}%）"
    finetuned[mix] = train(start, CONFIG["FINETUNE_STEPS"], CONFIG["LR_FINETUNE"], lambda n, m=mix: batch_from(n, mix_synthetic=m), tag, f"finetune-mix{int(mix * 100)}")
    path = os.path.join(OUT, f"dit_finetune_mix{int(mix * 100)}.pt")
    torch.save({"model": finetuned[mix].state_dict(), "size": CONFIG["MODEL_SIZE"], "config": CONFIG, "mix_synthetic": mix}, path)
    print("保存:", path)

# %% [markdown]
# ## 9. 比べる: 妥当性（葉がちょうど 4 枚の形の割合）と、形の特徴（本物の基準 baseline.json と並べる）
# - 「仕上げ前」はラベル 0（数式）、「仕上げ後」はラベル 1（本物）で作る
# - 歩数と CFG の強さを変えて、表にする

# %%
import json

with open(os.path.join(DATA, "baseline.json"), encoding="utf-8") as f:
    BASE = json.load(f)
METRICS = ["valley_mean", "valley_max", "leaf_cv", "tip_cv", "aspect"]


def quant(v, q):
    v = np.asarray([x for x in v if not np.isnan(x)])
    return float(np.quantile(v, q)) if len(v) else float("nan")


def evaluate(model, label, steps, cfg, seed=1):
    xs = sample(model, CONFIG["N_EVAL"], label, steps, cfg, seed)
    rep = validity_report(list(xs))
    bins = [(x >= 0.5).astype(np.uint8) for x in xs]
    feats = [sh.shape_metrics(b) for b in bins if b.any()]
    out = {"valid_share": rep["valid_share"], "reasons": rep["reasons"]}
    for k in METRICS:
        out[k] = {"median": quant([f[k] for f in feats], 0.5), "p10": quant([f[k] for f in feats], 0.1), "p90": quant([f[k] for f in feats], 0.9)}
    return out, xs


def closeness(m):
    """本物の基準との近さ: 特徴ごとの（中央値の差 ÷ 本物の 10%〜90% の幅）の平均。小さいほど近い"""
    d = []
    for k in METRICS:
        r = BASE["real"]["metrics"][k]
        d.append(abs(m[k]["median"] - r["median"]) / max(r["p90"] - r["p10"], 1e-6))
    return float(np.mean(d))


models = {"仕上げ前（数式で学習）": (pre, 0)} | {f"仕上げ後（数式 {int(m * 100)}%）": (fm, 1) for m, fm in finetuned.items()}
RESULTS, SAMPLES = {}, {}
for name, (model, label) in models.items():
    for steps in CONFIG["SAMPLE_STEPS"]:
        for cfg in CONFIG["CFG_SCALES"]:
            m, xs = evaluate(model, label, steps, cfg)
            key = f"{name}・{steps}歩・CFG {cfg}"
            RESULTS[key] = {**m, "closeness_to_real": closeness(m)}
            SAMPLES[key] = xs
            print(f"{key}: 正しい形の割合 {m['valid_share']:.0%}・本物との近さ {closeness(m):.2f}・谷の比 {m['valley_mean']['median']:.2f}"
                  f"・葉の大きさのばらつき {m['leaf_cv']['median']:.2f}・縦横比 {m['aspect']['median']:.2f}")
r = BASE["real"]["metrics"]
print(f"本物の基準: 谷の比 {r['valley_mean']['median']:.2f}・葉の大きさのばらつき {r['leaf_cv']['median']:.2f}・縦横比 {r['aspect']['median']:.2f}")

# %% [markdown]
# ## 10. 丸写しのチェック（いちばん似た学習の形）
# - 作った形ごとに、学習に使った形（本物・数式）すべてと、8 通りの向きで重ねて、いちばん大きい重なり（IoU）を求める
# - 向きと大きさをそろえた四つ葉どうしは、もともと重なりが大きい（別の株の本物どうしでも 0.85 くらい）
# - そこで、目安をデータから決める: 「別の株の本物どうしの、いちばん大きい重なり」（と `COPY_IOU` の大きいほう）をこえたら「丸写しの疑い」
# - 数式の形も同じ: 「数式の形どうし（ほかの形）の、いちばん大きい重なり」の 99%点をこえたら「丸写しの疑い」

# %%
def d4_all(m):
    out = []
    for k in range(4):
        r = np.rot90(m, k)
        out += [r, np.fliplr(r)]
    return out


def flat_bin(t):
    return ((t.numpy()[:, 0] + 1) / 2 >= 0.5).reshape(len(t), -1).astype(np.float32)


TRAIN_REAL, TRAIN_SYN = flat_bin(REAL), flat_bin(SYN)


def nearest(xs, bank):
    """作った形 xs（0〜1）ごとの、bank の中で、いちばん大きい IoU と、その番号"""
    B = torch.from_numpy(bank).to(DEVICE)
    best, arg = np.zeros(len(xs)), np.zeros(len(xs), dtype=int)
    for i, x in enumerate(xs):
        V = torch.from_numpy(np.stack([v.reshape(-1) for v in d4_all((x >= 0.5).astype(np.float32))])).to(DEVICE)
        inter = V @ B.T
        union = V.sum(1, keepdim=True) + B.sum(1)[None] - inter
        iou = (inter / union.clamp(min=1)).max(0).values
        j = int(iou.argmax())
        best[i], arg[i] = float(iou[j]), j
    return best, arg


# 目安: 本物どうし（同じ株は除く）のいちばん大きい重なり
obs = [r["observation"] for r in real_meta]
ref = []
for i in range(len(TRAIN_REAL)):
    others = np.array([j for j in range(len(TRAIN_REAL)) if obs[j] != obs[i]])
    b, _ = nearest([TRAIN_REAL[i].reshape(64, 64)], TRAIN_REAL[others])
    ref.append(b[0])
COPY_REAL = max(CONFIG["COPY_IOU"], float(np.max(ref)))
print(f"目安: 本物どうし（別の株）のいちばん大きい重なり 中央値 {np.median(ref):.2f}・最大 {np.max(ref):.2f} → 丸写しの疑いの目安 {COPY_REAL:.2f}")

# 数式の形どうし（200 個を、ほかの全部と比べる。自分自身は除く）
rng = np.random.default_rng(0)
pick = rng.choice(len(TRAIN_SYN), size=min(200, len(TRAIN_SYN)), replace=False)
ref_syn = []
for i in pick:
    b, _ = nearest([TRAIN_SYN[i].reshape(64, 64)], np.delete(TRAIN_SYN, i, axis=0))
    ref_syn.append(b[0])
COPY_SYN = max(CONFIG["COPY_IOU"], float(np.quantile(ref_syn, 0.99)))
print(f"目安: 数式の形どうしのいちばん大きい重なり 中央値 {np.median(ref_syn):.2f}・99%点 {np.quantile(ref_syn, 0.99):.2f} → 丸写しの疑いの目安 {COPY_SYN:.2f}")

COPY = {}
for key, xs in SAMPLES.items():
    if "16歩" not in key and len(CONFIG["SAMPLE_STEPS"]) > 1:
        continue
    br, ar = nearest(xs, TRAIN_REAL)
    bs, _ = nearest(xs, TRAIN_SYN)
    COPY[key] = {"real_iou_median": float(np.median(br)), "real_iou_max": float(br.max()), "copy_share_real": float((br > COPY_REAL).mean()),
                 "syn_iou_median": float(np.median(bs)), "copy_share_syn": float((bs > COPY_SYN).mean())}
    print(f"{key}: 本物との重なり 中央値 {np.median(br):.2f}・最大 {br.max():.2f}・丸写しの疑い {COPY[key]['copy_share_real']:.0%}"
          f"／数式との重なり 中央値 {np.median(bs):.2f}・丸写しの疑い {COPY[key]['copy_share_syn']:.0%}")

# %% [markdown]
# ## 11. 結果を保存する（Google ドライブの yotsuba-gacha/out/）
# - `results.json`: 上の表の数
# - `samples-*.png`: 作った形の一覧（1 枚に 64 個）
# - `features.png`: 特徴の分布（本物の基準の範囲と、仕上げ前・仕上げ後。グラフの文字は英語）
# - `train_log.json`・`loss.png`: 損失の曲線と、かかった時間
# - `dit_pretrain.pt`・`dit_finetune_mix0.pt`・`dit_finetune_mix20.pt`: モデル（次のフェーズで ONNX にする）

# %%
import matplotlib.pyplot as plt

with open(os.path.join(OUT, "results.json"), "w", encoding="utf-8") as f:
    json.dump({"config": CONFIG, "evaluate": RESULTS, "copy_check": COPY, "real_vs_real_iou_median": float(np.median(ref)),
               "copy_threshold_real": COPY_REAL, "copy_threshold_synthetic": COPY_SYN, "synthetic_vs_synthetic_iou_median": float(np.median(ref_syn)),
               "baseline_real": BASE["real"]["metrics"]}, f, ensure_ascii=False, indent=1)


def grid(xs, path, n=64):
    k = int(math.sqrt(n))
    img = np.ones((k * 66, k * 66))
    for i, x in enumerate(xs[:n]):
        r, c = divmod(i, k)
        img[r * 66 + 1:r * 66 + 65, c * 66 + 1:c * 66 + 65] = 1 - (x >= 0.5)
    Image.fromarray((img * 255).astype(np.uint8)).save(path)


for key, xs in SAMPLES.items():
    if "16歩" in key or len(CONFIG["SAMPLE_STEPS"]) == 1:
        grid(xs, os.path.join(OUT, "samples-" + key.replace("・", "_").replace(" ", "").replace("（", "_").replace("）", "").replace("%", "pct") + ".png"))

fig, axes = plt.subplots(1, 3, figsize=(14, 3.6))
for ax, k in zip(axes, ["valley_mean", "leaf_cv", "aspect"]):
    rr = BASE["real"]["metrics"][k]
    ax.axvspan(rr["p10"], rr["p90"], color="#2a78d6", alpha=0.15, label="real p10-p90")
    ax.axvline(rr["median"], color="#2a78d6", lw=2, label="real median")
    for (key, xs), col in zip([(k2, v) for k2, v in SAMPLES.items() if "CFG 1.5" in k2 and ("16歩" in k2 or len(CONFIG["SAMPLE_STEPS"]) == 1)], ["#7a7a7a", "#eb6834", "#1baf7a"]):
        vals = [sh.shape_metrics((x >= 0.5).astype(np.uint8))[k] for x in xs]
        ascii_name = "pretrain" if key.startswith("仕上げ前") else ("finetune-mix20" if "20%" in key else "finetune-mix0")
        ax.hist([v for v in vals if not np.isnan(v)], bins=30, histtype="step", lw=1.8, color=col, density=True, label=ascii_name)
    ax.set_title(k)
    ax.set_yticks([])
axes[0].legend(fontsize=7, frameon=False)
fig.suptitle("Shape features of samples (16 steps, cfg 1.5) vs real baseline")
fig.tight_layout()
fig.savefig(os.path.join(OUT, "features.png"), dpi=110)

# 学習の記録（損失の曲線・かかった時間）
with open(os.path.join(OUT, "train_log.json"), "w", encoding="utf-8") as f:
    json.dump(TRAIN_LOG, f, indent=1)
fig, axes = plt.subplots(1, len(TRAIN_LOG), figsize=(5 * len(TRAIN_LOG), 3.4), squeeze=False)
for ax, (name, lg) in zip(axes[0], TRAIN_LOG.items()):
    ax.plot(lg["step"], lg["loss"], color="#2F4A35", lw=1)
    ax.set_title(f"{name}: {lg['steps']} steps, {lg.get('seconds', 0) / 60:.1f} min")
    ax.set_xlabel("step")
    ax.set_ylabel("loss (MSE)")
fig.tight_layout()
fig.savefig(os.path.join(OUT, "loss.png"), dpi=110)
print("保存したもの:", sorted(os.listdir(OUT)))

# %% [markdown]
# ## 12. 作者がすること
# 1. 左の「ファイル」から、Google ドライブの `yotsuba-gacha/out/` を開き、`results.json`・`features.png`・`samples-*.png` を確かめる
# 2. その 3 種類（と、必要なら `.pt` のモデル）を、パソコンの `data/gacha/dit-out/` に置いて、Claude に知らせる
