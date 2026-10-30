"""
「今日のよつば」: DiT の 1 歩ぶん（x と t から、向き v を返す）を ONNX に書き出し、PyTorch と結果が同じかを確かめる

    python training/gacha_export_onnx.py

書き出すもの（data/gacha/onnx/。Git に入れない）。アプリが使うのは、仕上げ前の fp32 だけ（作者の決定 2026-10-28）。
  それを public/models/gacha-pretrain-fp32.onnx に写す（src/lib/gacha-config.ts の GACHA_MODEL_URL）
  gacha-<model>-fp32.onnx … そのまま
  gacha-<model>-fp16.onnx … 重みと計算を float16 にしたもの（入力・出力は float32 のまま）。ただし時刻の埋め込み（sin・cos）は
                             float32 のまま（t × 1000 × 周波数 が数百になり、float16 では角度がくずれるため）
  <model> = pretrain（仕上げ前・ラベル 0）・mix20（仕上げ後 数式 20%・ラベル 1）
  入力: x [1, 1, 64, 64]（float32）・t [1]（float32。0〜1）→ 出力: v [1, 1, 64, 64]。ラベルと CFG なし（作者の決定）は、中に固定した
  opset 17（onnxruntime-web 1.30 の WebGPU・WASM で動く範囲。LayerNormalization・Gather・MatMul・Softmax・Sin・Cos など）
確かめること（パソコンの onnxruntime。CPU）
  1. 1 歩の v: PyTorch と ONNX（fp32）の差
  2. 4 歩の Euler 全体（同じノイズ）: 最後の形の差と、0.5 で白黒にしたときに、ちがう画素の数
  3. fp16: パソコンの CPU は float16 の Conv を動かせないので、「重みを float16 に丸めて float32 に戻したもの」で、丸めの影響だけを見る
     （本当の fp16 の計算は、ブラウザで確かめた。ブランチ gacha-phase2 の bench-gacha.html。iPhone の WebGPU では落ちたので、使わない）
  4. ブラウザで確かめるための答え data/gacha/onnx/reference.json（決まったノイズ・PyTorch の 1 歩目の v・4 歩の最後の形）
"""

import base64
import json
import shutil
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import numpy_helper
from onnxconverter_common import float16

import gacha_dit_eval as ev
from validity import is_valid

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "gacha" / "onnx"
REF = OUT / "reference.json"
APP_MODEL = ROOT / "public" / "models" / "gacha-pretrain-fp32.onnx"  # アプリが使うモデル
MODELS = {"pretrain": "pretrain", "mix20": "finetune-mix20"}
STEPS = 4
OPSET = 17


class OneStep(torch.nn.Module):
    """ラベルを固定した 1 歩ぶん（CFG なし）"""

    def __init__(self, model, label: int):
        super().__init__()
        self.model = model
        self.register_buffer("y", torch.tensor([label], dtype=torch.long))

    def forward(self, x, t):
        return self.model(x, t, self.y)


def export(name: str) -> tuple[torch.nn.Module, Path, Path]:
    model = ev.load_model(MODELS[name])
    step = OneStep(model, ev.MODELS[MODELS[name]][1]).eval()
    OUT.mkdir(parents=True, exist_ok=True)
    fp32 = OUT / f"gacha-{name}-fp32.onnx"
    torch.onnx.export(step, (torch.zeros(1, 1, 64, 64), torch.zeros(1)), str(fp32), input_names=["x", "t"], output_names=["v"],
                      opset_version=OPSET, do_constant_folding=True, dynamo=False)
    m = onnx.load(str(fp32))
    onnx.checker.check_model(m)
    # 時刻の埋め込み: 入力 t から、Sin・Cos までのノードは float32 のまま
    producers = {o: n for n in m.graph.node for o in n.output}
    keep, todo = set(), [n for n in m.graph.node if n.op_type in ("Sin", "Cos")]
    while todo:
        n = todo.pop()
        if n.name in keep:
            continue
        keep.add(n.name)
        todo += [producers[i] for i in n.input if i in producers]
    fp16 = OUT / f"gacha-{name}-fp16.onnx"
    original_casts = {n.name for n in m.graph.node if n.op_type == "Cast"}  # 変換の道具が足す Cast は、ふくめない
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, node_block_list=sorted(keep))
    # 元のグラフの Cast（注意の 1/√d を求める所など）は、行き先が float32 のまま残り、型が合わなくなる → float16 に直す
    for n in m16.graph.node:
        if n.op_type == "Cast" and n.name in original_casts and n.name not in keep:
            for a in n.attribute:
                if a.name == "to" and a.i == onnx.TensorProto.FLOAT:
                    a.i = onnx.TensorProto.FLOAT16
    onnx.checker.check_model(m16)
    onnx.save(m16, str(fp16))
    print(f"{name}: {fp32.name} {fp32.stat().st_size / 2**20:.1f}MB・{fp16.name} {fp16.stat().st_size / 2**20:.1f}MB"
          f"・ノード {len(m.graph.node)}・float32 のまま残したノード {len(keep)}・演算 {sorted({n.op_type for n in m.graph.node})}")
    return step, fp32, fp16


def fp16_rounded(path32: Path) -> ort.InferenceSession:
    m = onnx.load(str(path32))
    for init in m.graph.initializer:
        a = numpy_helper.to_array(init)
        if a.dtype == np.float32:
            init.CopyFrom(numpy_helper.from_array(a.astype(np.float16).astype(np.float32), init.name))
    return ort.InferenceSession(m.SerializeToString(), providers=["CPUExecutionProvider"])


def euler(run, x0: np.ndarray) -> np.ndarray:
    x = x0.copy()
    for i in range(STEPS):
        x = x + run(x, np.array([i / STEPS], np.float32)) / STEPS
    return (np.clip(x, -1, 1) + 1) / 2


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=np.float32).tobytes()).decode("ascii")


def main():
    rng = np.random.default_rng(2026)
    reference = {"steps": STEPS, "note": "x0 = 決まったノイズ（float32・リトルエンディアン・base64）。v0 = PyTorch の 1 歩目の v。out = PyTorch の 4 歩の最後の形（0〜1）", "models": {}}
    report = {}
    for name in MODELS:
        step, p32, p16 = export(name)
        s32 = ort.InferenceSession(str(p32), providers=["CPUExecutionProvider"])
        s16w = fp16_rounded(p32)
        torch_run = lambda x, t: step(torch.from_numpy(x), torch.from_numpy(t)).detach().numpy()
        ort_run = lambda x, t, s=s32: s.run(["v"], {"x": x, "t": t})[0]
        w16_run = lambda x, t, s=s16w: s.run(["v"], {"x": x, "t": t})[0]
        dv, dout, dout16, pix, pix16, valid_same, valid16_same = [], [], [], [], [], 0, 0
        n = 64
        for k in range(n):
            x0 = rng.standard_normal((1, 1, 64, 64)).astype(np.float32)
            t = np.array([rng.uniform(0, 1)], np.float32)
            with torch.no_grad():
                dv.append(float(np.abs(torch_run(x0, t) - ort_run(x0, t)).max()))
                a = euler(torch_run, x0)
            b, c = euler(ort_run, x0), euler(w16_run, x0)
            dout.append(float(np.abs(a - b).max()))
            dout16.append(float(np.abs(a - c).max()))
            pix.append(int(((a >= 0.5) != (b >= 0.5)).sum()))
            pix16.append(int(((a >= 0.5) != (c >= 0.5)).sum()))
            valid_same += is_valid(a[0, 0])[0] == is_valid(b[0, 0])[0]
            valid16_same += is_valid(a[0, 0])[0] == is_valid(c[0, 0])[0]
            if k == 0:
                with torch.no_grad():
                    v0 = torch_run(x0, np.array([0.0], np.float32))
                reference["models"][name] = {"x0": b64(x0), "v0": b64(v0), "out": b64(a), "valid": bool(is_valid(a[0, 0])[0])}
        report[name] = {"v_maxdiff_fp32": max(dv), "out_maxdiff_fp32": max(dout), "pixels_diff_fp32_max": max(pix), "pixels_diff_fp32_total": sum(pix),
                        "valid_same_fp32": f"{valid_same}/{n}", "out_maxdiff_fp16w": max(dout16), "pixels_diff_fp16w_max": max(pix16),
                        "pixels_diff_fp16w_total": sum(pix16), "valid_same_fp16w": f"{valid16_same}/{n}"}
        print(name, json.dumps(report[name], ensure_ascii=False))
    REF.write_text(json.dumps(reference), encoding="utf-8")
    (ROOT / "data" / "gacha" / "dit-out" / "onnx-check.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {REF}")
    shutil.copyfile(OUT / "gacha-pretrain-fp32.onnx", APP_MODEL)
    print(f"→ {APP_MODEL}（アプリが使うモデル）")


if __name__ == "__main__":
    main()
