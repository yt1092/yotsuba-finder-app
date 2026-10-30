"""
WiSE-FT の実験: 2 つのモデル（v3 と v4）の重みを、線形に混ぜた ONNX を作る（学習はやり直さない）

    pip install onnx onnxruntime numpy pillow
    python training/mix_models.py public/models/yotsuba-v3.onnx data/models/yotsuba-v4.onnx --alphas 0.25 0.5 0.75

  - 混ぜた重み = (1 − α) × v3 ＋ α × v4（α は v4 の割合）。出力: data/models/yotsuba-mix-025.onnx など（Git に入れない）
  - 先に、2 つのグラフの構造（ノードの数・順序・種類・入出力の名前・属性、重みの名前・形・型）が同じかを確かめる。
    違えば、そこで止める（対応づけられないため）
  - 小数の重み（float32）だけを混ぜる。整数の定数（形など）は、2 つで同じであることを確かめて、そのまま使う
  - 近似: ONNX にしたとき、BatchNormalization は畳み込みにまとめられている（BN のノードは 0 個）。
    まとめたあとの重みを混ぜるのは、学習の重み（畳み込みと BN を別々）を混ぜてからまとめるのと、同じではない
  - 混ぜたモデルの出力の形（[1,6,18900]）と、NaN・無限大がないことを確かめる
"""

import argparse
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import numpy_helper

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "models"


def same_structure(a: onnx.ModelProto, b: onnx.ModelProto) -> list[str]:
    """構造のちがいを返す（空なら同じ）"""
    problems = []
    if len(a.graph.node) != len(b.graph.node):
        problems.append(f"ノードの数: {len(a.graph.node)} と {len(b.graph.node)}")
    for i, (x, y) in enumerate(zip(a.graph.node, b.graph.node)):
        if onnx.helper.printable_node(x) != onnx.helper.printable_node(y):
            problems.append(f"{i} 番目のノード: {x.op_type} {x.name} と {y.op_type} {y.name}")
            break
    ia = {i.name: i for i in a.graph.initializer}
    ib = {i.name: i for i in b.graph.initializer}
    if list(ia) != list(ib):
        problems.append("重みの名前・順序がちがう")
    for k in ia:
        if k in ib and (list(ia[k].dims) != list(ib[k].dims) or ia[k].data_type != ib[k].data_type):
            problems.append(f"重み {k} の形・型: {list(ia[k].dims)} と {list(ib[k].dims)}")
    if [o.version for o in a.opset_import] != [o.version for o in b.opset_import]:
        problems.append("opset がちがう")
    return problems


def mix(a: onnx.ModelProto, b: onnx.ModelProto, alpha: float) -> onnx.ModelProto:
    m = onnx.ModelProto()
    m.CopyFrom(a)
    wb = {i.name: numpy_helper.to_array(i) for i in b.graph.initializer}
    for init in m.graph.initializer:
        x = numpy_helper.to_array(init)
        y = wb[init.name]
        if x.dtype == np.float32:
            z = ((1 - alpha) * x.astype(np.float64) + alpha * y.astype(np.float64)).astype(np.float32)
            init.CopyFrom(numpy_helper.from_array(z, init.name))
        elif not np.array_equal(x, y):
            raise SystemExit(f"整数の定数 {init.name} が 2 つのモデルでちがう（混ぜられない）")
    return m


def check_output(path: Path) -> None:
    s = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    x = np.random.default_rng(0).random((1, 3, 960, 960), dtype=np.float32)
    y = s.run(None, {s.get_inputs()[0].name: x})[0]
    assert list(y.shape) == [1, 6, 18900], y.shape
    assert np.isfinite(y).all(), "NaN か無限大がある"
    print(f"  {path.name}: 出力 {list(y.shape)}・NaN なし・スコアの最大 {y[0, 4:].max():.3f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", help="v3（α = 0 のとき）")
    ap.add_argument("other", help="v4（α = 1 のとき）")
    ap.add_argument("--alphas", type=float, nargs="+", default=[0.25, 0.5, 0.75])
    args = ap.parse_args()
    a, b = onnx.load(args.base), onnx.load(args.other)
    problems = same_structure(a, b)
    if problems:
        raise SystemExit("構造がちがうので、混ぜられません:\n  " + "\n  ".join(problems))
    n_bn = sum(n.op_type == "BatchNormalization" for n in a.graph.node)
    print(f"構造は同じ: ノード {len(a.graph.node)}・重み {len(a.graph.initializer)}・BatchNormalization のノード {n_bn}（0 なら畳み込みにまとめられている）")
    for alpha in args.alphas:
        out = OUT_DIR / f"yotsuba-mix-{round(alpha * 100):03d}.onnx"
        m = mix(a, b, alpha)
        onnx.checker.check_model(m)
        onnx.save(m, str(out))
        check_output(out)


if __name__ == "__main__":
    main()
