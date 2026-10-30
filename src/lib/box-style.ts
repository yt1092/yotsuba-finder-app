// 検出の枠の見た目（カメラ・写真の結果・全画面で、同じにする）
// 色だけに頼らず、線の太さ・点線・四隅の印・ラベルでも、四つ葉と三つ葉を区別できるようにする
//   四つ葉: 金色の太い枠（暗い背景でも明るい背景でも見えるように、濃い縁取りつき）・四隅の印・「四つ葉 ●●●」の小さなラベル
//           カメラで追っているあいだ（まだ安定していない）は、金色の点線と、安定までの進み具合の輪
//   三つ葉: 細い白の枠。ラベルは出さない（密集した場面で、うるさくならないように）
import { CONFIDENCE_LEVELS } from './detector-config';
import { CONFIDENCE_TEXT, confidenceLevel } from './four-review';
import type { Detection } from './detector';

export const GOLD = '#F5C242';
export const GOLD_EDGE = 'rgba(58, 42, 0, 0.85)';  // 金色の枠の、濃い縁取り
export const THREE_LINE = 'rgba(255, 255, 255, 0.9)';
export const THREE_EDGE = 'rgba(0, 0, 0, 0.35)';

// 四つ葉のラベル（たしかさのめやすは記号だけ。数字は出さない）
export const fourLabel = (score: number | undefined): string =>
  `四つ葉 ${CONFIDENCE_TEXT[confidenceLevel(score, CONFIDENCE_LEVELS)].dots}`;

// 開発者向けの表示の文（クラス・スコアの数字・追跡の回数）。開発者向けの表示がオンのときだけ使う（src/lib/dev-mode.ts）
export const devLabel = (d: Detection, tracked?: number): string =>
  `${d.label} ${(d.score ?? 0).toFixed(2)}${tracked !== undefined ? ` 追跡${tracked}` : ''}`;
