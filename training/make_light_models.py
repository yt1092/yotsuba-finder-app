"""
モデルを軽くする: v3 から FP16 版と INT8 版を作り、正しく読めるか確かめる（速さを測るページ public/bench.html は 2026-10-30 に消した。Git の履歴にある）

    pip install onnx onnxruntime onnxconverter-common sympy numpy pillow
    python training/make_light_models.py public/models/yotsuba-v3.onnx

作るもの（public/bench-models/。Git には入れない。公開前に消す。README の「公開前に削除するもの」）
  <名前>-fp16.onnx         … 重みと計算を float16 にしたもの（入力・出力は float32 のまま。アプリの前処理を変えずに使える）
  <名前>-int8-dynamic.onnx … 重みだけ int8（onnxruntime の quantize_dynamic。ConvInteger を使う）
  <名前>-int8-qdq.onnx     … 重みと途中の値を int8（quantize_static・QDQ 形式・チャンネルごと。opset 13 に上げてから）。
                            最後の検出の部分（/model.23/。枠の座標とスコアを作る）は量子化しない（すると、何も検出しなくなった）。
                            途中の値の幅は、学習用の写真 64 枚（clover-detection の train。評価には使っていない）で決める
  <名前>-fp16w.onnx        … 精度を測るためだけのもの: 重みを float16 にして、float32 に戻したもの（パソコンの CPU は、FP16 の Conv を
                            動かせないため。float16 にしたことによる精度の変化だけが分かる。配らない）
精度は training/eval_threshold.py で測る（モデルのパスを渡すだけ。途中保存は、モデルの中身ごとに別になる）
"""

import argparse
import random
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper
from onnx import version_converter
from onnxconverter_common import float16
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_dynamic, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process
from PIL import Image

import eval_hardneg as eh

OUT_DIR = eh.PROJECT_DIR / "public" / "bench-models"
CALIB_DIR = eh.DATA_DIR / "public" / "clover-detection" / "train" / "images"
CALIB_COUNT = 64


class Letterboxed(CalibrationDataReader):
    """アプリと同じ前処理（960×960 に灰色 114 でレターボックス）の写真を、1 枚ずつ渡す"""

    def __init__(self, input_name, paths):
        self.input_name, self.paths = input_name, list(paths)

    def get_next(self):
        if not self.paths:
            return None
        image = eh.open_image(self.paths.pop())
        scale = min(eh.INPUT_SIZE / image.width, eh.INPUT_SIZE / image.height)
        dw, dh = round(image.width * scale), round(image.height * scale)
        canvas = Image.new("RGB", (eh.INPUT_SIZE, eh.INPUT_SIZE), (eh.PAD_VALUE,) * 3)
        canvas.paste(image.resize((dw, dh), Image.BILINEAR), ((eh.INPUT_SIZE - dw) // 2, (eh.INPUT_SIZE - dh) // 2))
        return {self.input_name: (np.asarray(canvas, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]}


def check(path):
    onnx.checker.check_model(str(path))
    m = onnx.load(str(path))
    shape = lambda v: [d.dim_value for d in v.type.tensor_type.shape.dim]
    io = (shape(m.graph.input[0]), shape(m.graph.output[0]), m.graph.input[0].type.tensor_type.elem_type)
    assert io[0] == [1, 3, 960, 960] and io[1] == [1, 6, 18900] and io[2] == onnx.TensorProto.FLOAT, f"{path}: 入出力の形が違う {io}"
    ops = sorted({n.op_type for n in m.graph.node})
    print(f"  {path.name}: {path.stat().st_size / 1e6:.1f} MB・checker OK・入力 float32 [1,3,960,960] → [1,6,18900]")
    print(f"    使う演算: {', '.join(ops)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    args = ap.parse_args()
    src = Path(args.model)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = src.stem
    print(f"■ {src}（{src.stat().st_size / 1e6:.1f} MB）")

    # FP16（入出力は float32 のまま）。元のモデルに残っている途中の型の情報（value_info）を消してから変換する
    # （消さないと、Resize の出力の型が float のまま残り、「Type Error」で読みこめなかった）
    fp16 = OUT_DIR / f"{stem}-fp16.onnx"
    model = onnx.load(str(src))
    del model.graph.value_info[:]
    onnx.save(float16.convert_float_to_float16(model, keep_io_types=True), str(fp16))
    check(fp16)

    # 精度を測るためだけの、float16 → float32 に戻した重み
    fp16w = OUT_DIR / f"{stem}-fp16w.onnx"
    m = onnx.load(str(src))
    for init in m.graph.initializer:
        a = numpy_helper.to_array(init)
        if a.dtype == np.float32:
            init.CopyFrom(numpy_helper.from_array(a.astype(np.float16).astype(np.float32), init.name))
    onnx.save(m, str(fp16w))
    check(fp16w)

    # INT8（重みだけ）
    dyn = OUT_DIR / f"{stem}-int8-dynamic.onnx"
    quantize_dynamic(str(src), str(dyn), weight_type=QuantType.QInt8)
    check(dyn)

    # INT8（QDQ。途中の値の幅を、学習用の写真で決める）
    pre = OUT_DIR / f"{stem}-pre.onnx"
    # チャンネルごとの量子化（DequantizeLinear の axis）は opset 13 から。v3 は opset 12 なので、上げてから量子化する
    up = OUT_DIR / f"{stem}-opset13.onnx"
    onnx.save(version_converter.convert_version(onnx.load(str(src)), 13), str(up))
    quant_pre_process(str(up), str(pre))
    up.unlink()
    paths = sorted(CALIB_DIR.glob("*.jpg"))
    random.Random(0).shuffle(paths)
    qdq = OUT_DIR / f"{stem}-int8-qdq.onnx"
    pm = onnx.load(str(pre))
    name = pm.graph.input[0].name
    head = [n.name for n in pm.graph.node if "/model.23/" in n.name]
    quantize_static(str(pre), str(qdq), Letterboxed(name, paths[:CALIB_COUNT]), quant_format=QuantFormat.QDQ,
                    per_channel=True, activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, nodes_to_exclude=head)
    pre.unlink()
    check(qdq)


if __name__ == "__main__":
    main()
