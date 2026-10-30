"""
「今日のよつば」の形のチェック・数式の形・比べる仕組みのテスト（標準の unittest。追加のパッケージは不要）

    cd training && python -m unittest discover -s tests -v
"""

import math
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gacha_shape as sh  # noqa: E402
import gacha_synth as gs  # noqa: E402
import gacha_reference as gr  # noqa: E402
from gacha_compare import ks  # noqa: E402


def polar_shape(lobes: int, base: float = 0.2, rot_deg: float = 0.0, scale: float = 26) -> np.ndarray:
    """葉が lobes 枚の、極座標の形（r = base + (1 − base)·|cos(lobes/2·θ)|）"""
    t = np.linspace(0, 2 * math.pi, 720, endpoint=False)
    r = base + (1 - base) * np.abs(np.cos(lobes / 2 * t))
    a = t + math.radians(rot_deg)
    pts = np.stack([32 + scale * r * np.cos(a), 32 + scale * r * np.sin(a)], 1).round().astype(np.int32)
    m = np.zeros((64, 64), np.uint8)
    cv2.fillPoly(m, [pts], 1)
    return m


def disk(cx, cy, r) -> np.ndarray:
    m = np.zeros((64, 64), np.uint8)
    cv2.circle(m, (cx, cy), r, 1, -1)
    return m


class LobeCount(unittest.TestCase):
    def test_four_leaves_pass(self):
        m = polar_shape(4)
        self.assertEqual(sh.count_lobes(m), 4)
        self.assertEqual(sh.check(m), [])

    def test_three_and_five_are_rejected(self):
        self.assertIn("葉の数が 3", sh.check(polar_shape(3)))
        self.assertIn("葉の数が 5", sh.check(polar_shape(5)))

    def test_count_does_not_depend_on_rotation(self):
        for deg in (0, 17, 45, 73):
            self.assertEqual(sh.count_lobes(polar_shape(4, rot_deg=deg)), 4, deg)

    def test_heart_notch_is_not_an_extra_leaf(self):
        # 葉の先のへこみ（ハート形）を、別の葉と数えない（はじめの数え方で、起きたまちがい）
        p = {"base": 0.25, "sharp": 1.0, "notch_depth": 0.3, "notch_width_deg": 8.0, "rotation_deg": 0.0, "jitter": 0.0}
        self.assertEqual(sh.count_lobes(gs.render(p, 0)), 4)


class LobeCountOnData(unittest.TestCase):
    """数式の形と、作者が選んだ実物（○）で、葉の数を数える（実物は data/ があるときだけ）"""

    def test_synthetic_four_leaves_count_four(self):
        rng = np.random.default_rng(11)
        shapes = [gs.render(gs.sample_params(rng, 0.15, 4), 4) for _ in range(200)]
        four = sum(sh.count_lobes(m) == 4 for m in shapes)
        print(f"  数式の形 200 個のうち、4 と数えた数: {four}")
        self.assertGreaterEqual(four, 190)

    def test_picked_real_four_leaves(self):
        import json
        g = Path(__file__).resolve().parent.parent.parent / "data" / "gacha"
        if not (g / "review-index.csv").exists():
            self.skipTest("data/gacha が無い")
        import csv
        from PIL import Image
        pick = json.loads((Path(__file__).resolve().parent.parent / "gacha_reference_pick.json").read_text(encoding="utf-8"))
        with (g / "review-index.csv").open(encoding="utf-8") as f:
            ids = {int(r["number"]): r["id"] for r in csv.DictReader(f)}

        def lobes(n):
            return sh.count_lobes((np.asarray(Image.open(g / "masks" / f"{ids[n]}.png").convert("L")) >= 128).astype(np.uint8))
        use = {n: lobes(n) for n in pick["use"]}
        hold = {n: lobes(n) for n in pick["hold"]}  # ？ は数を出すだけ（調整には使っていない）
        four = [n for n, v in use.items() if v == 4]
        print(f"  ○ {len(use)} 個のうち、4 と数えた数: {len(four)}（{four}）・ほか {dict((n, v) for n, v in use.items() if v != 4)}")
        print(f"  ？ の葉の数: {hold}")
        self.assertGreaterEqual(len(four), 10)  # 半分以上（依頼の止める条件）


class Topology(unittest.TestCase):
    def test_two_pieces_are_rejected(self):
        m = disk(18, 32, 10) | disk(46, 32, 10)
        self.assertIn("つながっていない", sh.check(m))

    def test_hole_is_rejected(self):
        m = polar_shape(4, base=0.4)
        cv2.circle(m, (32, 32), 4, 0, -1)
        self.assertIn("穴がある", sh.check(m))

    def test_tiny_diagonal_gap_is_not_a_hole(self):
        m = polar_shape(4)
        m[31, 31] = 0  # 1px のすき間は穴とみなさない
        self.assertEqual(sh.features(m)["bg_components"], 1)

    def test_empty(self):
        self.assertIn("形がない", sh.check(np.zeros((64, 64), np.uint8)))


class Area(unittest.TestCase):
    def test_too_small_and_too_large(self):
        self.assertIn("面積が小さすぎる", sh.check(polar_shape(4, scale=8)))
        self.assertIn("面積が大きすぎる", sh.check(np.ones((64, 64), np.uint8)))


class Features(unittest.TestCase):
    def test_symmetry_and_round(self):
        f4 = sh.features(polar_shape(4))
        f3 = sh.features(polar_shape(3))
        self.assertGreater(f4["sym4"], 0.85)
        self.assertLess(f3["sym4"], f4["sym4"])
        circle = sh.features(disk(32, 32, 20))
        self.assertGreater(circle["compactness"], 0.85)
        self.assertLess(f4["compactness"], circle["compactness"])

    def test_normalize_centers_and_scales(self):
        m = np.zeros((64, 64), np.uint8)
        m[:40, :40] = polar_shape(4, scale=12)[12:52, 12:52]  # 左上にずらす
        n = sh.normalize(m)
        ys, xs = np.nonzero(n)
        self.assertAlmostEqual(xs.mean(), 31.5, delta=1.5)
        self.assertAlmostEqual(ys.mean(), 31.5, delta=1.5)
        self.assertAlmostEqual(np.hypot(xs - xs.mean(), ys - ys.mean()).max(), sh.RADIUS, delta=2)
        self.assertEqual(sh.count_lobes(n), 4)


class Metrics(unittest.TestCase):
    def test_symmetric_four_leaves(self):
        f = sh.shape_metrics(polar_shape(4))
        self.assertLess(f["leaf_cv"], 0.05)   # 4 枚とも同じ大きさ
        self.assertLess(f["tip_cv"], 0.05)
        self.assertGreater(f["aspect"], 0.95)  # 縦横が同じ
        self.assertLess(f["valley_mean"], 0.5)  # 深い谷

    def test_shallow_valleys_and_uneven_leaves(self):
        deep = sh.shape_metrics(polar_shape(4, base=0.15))
        shallow = sh.shape_metrics(polar_shape(4, base=0.5))
        self.assertGreater(shallow["valley_mean"], deep["valley_mean"])
        m = polar_shape(4)
        m[:, 40:] = 0  # 右の葉を切って、大きさをそろえない
        self.assertGreater(sh.shape_metrics(m)["leaf_cv"], 0.1)

    def test_aspect_of_ellipse(self):
        m = np.zeros((64, 64), np.uint8)
        cv2.ellipse(m, (32, 32), (24, 12), 30, 0, 360, 1, -1)
        self.assertAlmostEqual(sh.shape_metrics(m)["aspect"], 0.5, delta=0.05)


class Synth(unittest.TestCase):
    def test_same_seed_same_params(self):
        a = gs.sample_params(np.random.default_rng(3), 0.15, 4)
        b = gs.sample_params(np.random.default_rng(3), 0.15, 4)
        self.assertEqual(a, b)

    def test_no_jitter_shapes_mostly_pass(self):
        rng = np.random.default_rng(0)
        ok = sum(not sh.check(gs.render(gs.sample_params(rng, 0.0, 4), 4)) for _ in range(40))
        self.assertGreaterEqual(ok, 36)

    def test_render_is_binary_64(self):
        m = gs.render(gs.sample_params(np.random.default_rng(1), 0.15, 4), 4)
        self.assertEqual(m.shape, (64, 64))
        self.assertTrue(set(np.unique(m)) <= {0, 1})


class Compare(unittest.TestCase):
    def test_ks(self):
        a = np.arange(100, dtype=float)
        self.assertEqual(ks(a, a), 0.0)
        self.assertEqual(ks(a, a + 1000), 1.0)


class ReferencePick(unittest.TestCase):
    def setUp(self):
        import json
        import tempfile
        self.tmpdir = tempfile.TemporaryDirectory()  # テストのあとで自動で消える
        self.tmp = Path(self.tmpdir.name)
        with (self.tmp / "review-index.csv").open("w", encoding="utf-8", newline="") as f:
            f.write("number,sheet,id,source,license,author,url,score,status,reason\n")
            for n in range(1, 8):
                f.write(f"{n},s,id{n},iNaturalist,CC0,a,u,0.9,使える,\n")
        self.pick = self.tmp / "pick.json"
        self.pick.write_text(json.dumps({"use": [1, 3, 5], "hold": [2]}), encoding="utf-8")
        self.old = gr.G
        gr.G = self.tmp

    def tearDown(self):
        gr.G = self.old
        self.tmpdir.cleanup()

    def test_use_and_hold_are_marked(self):
        rows = gr.pick_rows(pick=self.pick)
        self.assertEqual([(int(r["number"]), r["judge"]) for r in rows], [(1, "○"), (3, "○"), (5, "○"), (2, "？")])

    def test_unknown_number_stops(self):
        with self.assertRaises(SystemExit):
            gr.pick_rows(numbers="1,99")


if __name__ == "__main__":
    unittest.main()
