// 写真の中の葉の数（本数）の型と、画面に出す文を作る
// 本数は、確かめたあとの枠から数える（src/lib/auto-verify.ts の confirmedCounts）
// 画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/leaf-count.test.ts）

export interface LeafCounts {
  three: number; // 三つ葉の本数
  four: number;  // 四つ葉の本数
}

// 数の文（やさしい言い方）
//   例: 「三つ葉 47本のなかに、四つ葉が 1本」
//       「三つ葉 47本を調べました。四つ葉は、見つかりませんでした」
export function leafCountMessage({ three, four }: LeafCounts): string {
  if (four > 0 && three > 0) return `三つ葉 ${three}本のなかに、四つ葉が ${four}本`;
  if (four > 0) return `四つ葉が ${four}本 ありました`;
  if (three > 0) return `三つ葉 ${three}本を調べました。四つ葉は、見つかりませんでした`;
  return '葉っぱは、見つかりませんでした';
}
