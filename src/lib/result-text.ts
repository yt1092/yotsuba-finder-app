// 写真から探したあとの、結果の画面の見出しと、その下の文を決める（画面に頼らない計算だけ。tests/result-text.test.ts）
// 見出しと中身が食い違わないように、結果の状態ごとの文は、ここだけで決める
//   検出なし            … 「四つ葉は 見つかりませんでした」／「三つ葉が ◯本 ありました」
//   すべて「入れない」   … 「四つ葉は ありませんでした」／「三つ葉が ◯本 ありました」
//   × で閉じて、入れたものなし … 「四つ葉は 図鑑に入れませんでした」／「三つ葉が ◯本 ありました」
//   入れた（一部・すべて・自動で入れる）… 「四つ葉を ◯本 図鑑に入れました」／「三つ葉が ◯本 ありました」
//   同じ写真の 2 回目    … 「この写真は、調べたことがあります」／「経験値は、増えません」（いつもの見出しは、その下に出す）
//   確認のポップアップで、まだ決めていない … 「四つ葉の候補を たしかめています」
// 失敗した感じの言葉（「ざんねん」など）は使わない

export interface ResultInput {
  fourDetected: number;   // 見つけた四つ葉の候補の数（確認の前）
  kept: number;           // 図鑑に入れた四つ葉の数
  three: number;          // 三つ葉の本数
  pending?: boolean;      // 確認のポップアップで、まだ決めていない
  closedEarly?: boolean;  // × で閉じた（決めていない候補が残った）
  repeated?: boolean;     // 同じ写真の 2 回目（経験値が増えない）
}

export interface ResultText {
  mascot: 'happy' | 'smile' | null; // 見出しの上のキャラクター（図鑑に入れた = happy・四つ葉がなかった = smile）
  title: string;
  sub: string;      // 見出しのすぐ下（空なら出さない）
  detail: string;   // その下（同じ写真の 2 回目のときに、いつもの見出しを出す。空なら出さない）
}

export const threeLine = (three: number): string => (three > 0 ? `三つ葉が ${three}本 ありました` : '');

function usual(r: ResultInput): Omit<ResultText, 'detail'> {
  const sub = threeLine(r.three);
  if (r.fourDetected === 0) return { mascot: 'smile', title: '四つ葉は 見つかりませんでした', sub };
  if (r.pending) return { mascot: null, title: '四つ葉の候補を たしかめています', sub };
  if (r.kept > 0) return { mascot: 'happy', title: `四つ葉を ${r.kept}本 図鑑に入れました`, sub };
  if (r.closedEarly) return { mascot: null, title: '四つ葉は 図鑑に入れませんでした', sub };
  return { mascot: 'smile', title: '四つ葉は ありませんでした', sub };
}

export function resultText(r: ResultInput): ResultText {
  const u = usual(r);
  if (!r.repeated) return { ...u, detail: '' };
  return { mascot: u.mascot, title: 'この写真は、調べたことがあります', sub: '経験値は、増えません', detail: [u.title, u.sub].filter(Boolean).join('。') };
}
