// 日記カードに書く文を作る（日付・葉の数・ひとことの折り返し）
// 画面に頼らない計算だけを置く（Node.js でそのままテストできるように: tests/diary-text.test.ts）
import type { LeafCounts } from './leaf-count';

// ひとことの、いちばん長い文字数（日記カードには 2 行までで出す）
// 前に保存した、これより長いひとことは、消さずに残す（カードでは「…」で切り、図鑑の詳細では全文を出す）
export const NOTE_MAX = 50;

// メモとひとことを 1 つにまとめる（DB の版 3 への引っ越しで使う）。両方に文字があれば「／」でつなげる。切りつめはしない
export function mergeNote(note: string | undefined, memo: string | undefined): string {
  const parts = [note, memo].map(s => (s ?? '').trim()).filter(Boolean);
  return parts.join(' ／ ');
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 「2026年10月22日（木）」
export function diaryDate(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}

// ファイル名に使う日付「2026-10-22」（端末の時計の日付。UTC にすると、日本の朝は前の日になるため）
export function fileDate(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 「三つ葉 47本のなかから 四つ葉を 1本 見つけた！」（四つ葉が複数なら、本数をそのまま）
// 数が無い記録（カメラで見つけたものなど）は「四つ葉を 見つけた！」
// 今日のよつば（source: 'gacha'）は、見つけた四つ葉ではないので「今日のよつばが できた！」（「見つけた」とは書かない）
export const GACHA_DIARY_LINE = '今日のよつばが できた！';
export function diaryCountLine(counts: LeafCounts | undefined, source?: 'camera' | 'photo' | 'gacha'): string {
  if (source === 'gacha') return GACHA_DIARY_LINE;
  if (!counts || counts.four <= 0) return '四つ葉を 見つけた！';
  if (counts.three <= 0) return `四つ葉を ${counts.four}本 見つけた！`;
  return `三つ葉 ${counts.three}本のなかから 四つ葉を ${counts.four}本 見つけた！`;
}

// ひとことを整える（前後の空白を取り、改行や続いた空白を 1 つの空白にする。切りつめはしない）
export function cleanNote(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ひとことの文字数（絵文字なども 1 文字と数える）
export function noteLength(text: string): number {
  return [...text].length;
}

// 保存してよいか（NOTE_MAX 文字以内）
export function noteFits(text: string): boolean {
  return noteLength(cleanNote(text)) <= NOTE_MAX;
}

// ひとことを、決まった行数に収める。大きい文字から順にためし、収まる大きさを選ぶ
// いちばん小さい文字でも収まらなければ、最後の行の終わりを「…」にする
export function fitNote(text: string, maxWidth: number, measureAt: (size: number) => (s: string) => number,
  sizes: readonly number[], maxLines = 2): { size: number; lines: string[] } {
  for (const size of sizes) {
    const measure = measureAt(size);
    const lines = wrapText(text, maxWidth, measure, 99);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  const measure = measureAt(size);
  const lines = wrapText(text, maxWidth, measure, maxLines);
  let last = lines[maxLines - 1] ?? '';
  while (last && measure(last + '…') > maxWidth) last = [...last].slice(0, -1).join('');
  lines[maxLines - 1] = last + '…';
  return { size, lines };
}

// 文を、幅に収まるように行に分ける（measure は、その文の幅を返す関数）
// 日本語は単語の区切りが無いので、1 文字ずつ足していき、はみ出したら次の行にする
// 句読点・小さい文字・閉じかっこは、行の頭に来ないように前の行に付ける
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 2): string[] {
  const NO_START = '、。，．,.！？!?）」』ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ';
  const lines: string[] = [];
  let line = '';
  for (const ch of [...text]) {
    if (line && measure(line + ch) > maxWidth && !NO_START.includes(ch)) {
      lines.push(line);
      line = '';
      if (lines.length === maxLines) break;
    }
    line += ch;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

// 1 行に収まらない文を、空白のところで 2 行に分ける（2 行の長さが、なるべくそろう所で）
// 空白で分けても収まらないときは、そのまま 1 行で返す（描く側で文字を小さくする）
export function splitAtSpace(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  if (measure(text) <= maxWidth) return [text];
  let best: string[] | null = null, bestDiff = Infinity;
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) {
    const a = text.slice(0, i).trim(), b = text.slice(i + 1).trim();
    const wa = measure(a), wb = measure(b);
    if (wa <= maxWidth && wb <= maxWidth && Math.abs(wa - wb) < bestDiff) { best = [a, b]; bestDiff = Math.abs(wa - wb); }
  }
  return best ?? [text];
}
