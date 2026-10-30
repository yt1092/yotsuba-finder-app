"""
training/gacha_dit_src.py（セルの区切り「# %%」付きの Python）から、Colab のノートブック training/gacha_dit.ipynb を作る

    python training/make_gacha_notebook.py

- 「# %% [markdown]」のセルは、行頭の「# 」を取って、説明のセルにする
- 中身を直すときは gacha_dit_src.py を直して、これを実行し直す（ノートブックを直接直さない）
- パソコンで短く試す: GACHA_QUICK=1 GACHA_QUICK_DIR=<final.zip を置いたフォルダ> python training/gacha_dit_src.py
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "gacha_dit_src.py"
OUT = HERE / "gacha_dit.ipynb"


def cells(text: str) -> list[dict]:
    out, kind, buf = [], None, []

    def flush():
        if kind is None:
            return
        lines = buf[:]
        while lines and not lines[-1].strip():
            lines.pop()
        while lines and not lines[0].strip():
            lines.pop(0)
        if kind == "markdown":
            lines = [l[2:] if l.startswith("# ") else l.lstrip("#") for l in lines]
            out.append({"cell_type": "markdown", "metadata": {}, "source": [l + "\n" for l in lines[:-1]] + lines[-1:]})
        else:
            out.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
                        "source": [l + "\n" for l in lines[:-1]] + lines[-1:]})

    for line in text.splitlines():
        if line.startswith("# %%"):
            flush()
            kind, buf = ("markdown" if "[markdown]" in line else "code"), []
        else:
            buf.append(line)
    flush()
    return out


def main():
    nb = {"nbformat": 4, "nbformat_minor": 5,
          "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"},
                       "kernelspec": {"display_name": "Python 3", "name": "python3"}, "language_info": {"name": "python"}},
          "cells": cells(SRC.read_text(encoding="utf-8"))}
    OUT.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {OUT}（セル {len(nb['cells'])} 個）")


if __name__ == "__main__":
    main()
