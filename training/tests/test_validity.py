"""
training/validity.py のテスト（作った形が四つ葉として正しいか）

    cd training && python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_gacha_shape import disk, polar_shape  # noqa: E402
from gacha_shape import check  # noqa: E402
from validity import MIN_PIECE, binarize, cleanup, is_valid, validity_report  # noqa: E402


class Validity(unittest.TestCase):
    def test_four_leaves_are_valid(self):
        ok, why = is_valid(polar_shape(4))
        self.assertTrue(ok, why)

    def test_three_and_five_leaves_are_not(self):
        self.assertFalse(is_valid(polar_shape(3))[0])
        self.assertFalse(is_valid(polar_shape(5))[0])

    def test_two_pieces_and_holes_are_not(self):
        self.assertIn("つながっていない", is_valid(disk(18, 32, 10) | disk(46, 32, 10))[1])
        m = polar_shape(4, base=0.4)
        cv2.circle(m, (32, 32), 4, 0, -1)
        self.assertIn("穴がある", is_valid(m)[1])

    def test_soft_output_is_thresholded(self):
        # DiT の出力のような 0〜1 の値: 0.5 で白黒にしてから確かめる
        soft = polar_shape(4).astype(np.float32) * 0.8 + 0.1
        self.assertTrue(is_valid(soft)[0])
        self.assertTrue(is_valid(soft[None])[0])  # (1, 64, 64) の形も受け取る
        self.assertEqual(binarize(np.full((64, 64), 0.49)).sum(), 0)

    def test_cleanup_removes_small_pieces_and_holes(self):
        m = polar_shape(4)
        m[2:5, 2:5] = 1          # 9 画素の、離れたかけら
        m[31:34, 31:34] = 0      # 9 画素の穴（まん中）
        before = check(binarize(m))  # 後処理の前は、つながっていない・穴がある
        self.assertIn("つながっていない", before)
        self.assertIn("穴がある", before)
        ok, why = is_valid(m)
        self.assertTrue(ok, why)  # 後処理を含めた「妥当な形」では通る
        c = cleanup(m)
        self.assertEqual(c[3, 3], 0)
        self.assertEqual(c[32, 32], 1)

    def test_cleanup_keeps_big_pieces_and_holes(self):
        # MIN_PIECE 画素以上のかけら・穴は消さない（形が 2 つに分かれたもの・大きな穴は、だめなまま）
        two = disk(18, 32, 10) | disk(46, 32, 10)
        self.assertEqual(cleanup(two).sum(), two.sum())
        m = polar_shape(4, base=0.4)
        cv2.circle(m, (32, 32), 4, 0, -1)  # 約 50 画素の穴
        self.assertEqual(cleanup(m)[32, 32], 0)  # 大きな穴は埋めない
        self.assertFalse(is_valid(m)[0])
        self.assertEqual(MIN_PIECE, 20)

    def test_cleanup_keeps_largest_even_if_small(self):
        m = np.zeros((64, 64), np.uint8)
        m[10:13, 10:13] = 1  # 9 画素だけ（いちばん大きいかたまり）
        self.assertEqual(cleanup(m).sum(), 9)

    def test_wrong_size(self):
        with self.assertRaises(ValueError):
            is_valid(np.zeros((32, 32)))

    def test_report(self):
        r = validity_report([polar_shape(4), polar_shape(4), polar_shape(3), np.zeros((64, 64))])
        self.assertEqual(r["count"], 4)
        self.assertEqual(r["valid"], 2)
        self.assertAlmostEqual(r["valid_share"], 0.5)
        self.assertIn("葉の数が 3", r["reasons"])
        self.assertIn("形がない", r["reasons"])


if __name__ == "__main__":
    unittest.main()
