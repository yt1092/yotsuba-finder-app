// 日記カードの手書き風フォント（Klee One）の読み込み
// 手書き風のフォントは、カードの中だけで使う（アプリの画面のフォントは変えない）
// 日本語は文字の範囲ごとに分かれた版なので、読み込むのは、指定した文字を含むファイルだけ
import '@fontsource/klee-one/400.css';
import '@fontsource/klee-one/600.css';

export const HAND = '"Klee One", "Zen Maru Gothic", sans-serif';
export const STAMP = '"Nunito", system-ui, sans-serif';

// 文に使うフォントの読み込みを待つ（待たないと、別のフォントで描かれてしまう）
export async function loadDiaryFonts(text: string): Promise<void> {
  await Promise.all([
    document.fonts.load(`600 56px ${HAND}`, text),
    document.fonts.load(`400 44px ${HAND}`, text),
    document.fonts.load(`800 24px ${STAMP}`, 'YOTSUBA FINDER'),
  ]);
}

// 先読みする文字: 日付・曜日・葉の数の文の文字、ひらがな・カタカナ、数字・英字・記号
// （ひとことの漢字は、カードを作るときに、その場で必要な分だけを読み込む）
const range = (from: number, to: number) => String.fromCodePoint(...Array.from({ length: to - from + 1 }, (_, i) => from + i));
export const PREFETCH_TEXT = range(0x3041, 0x3096) + range(0x30a1, 0x30fa) + 'ー'
  + '年月日（）日月火水木金土三つ葉本のなかから四つ葉を見つけた！、。…／今日のよつばができた'
  + range(0x20, 0x7e);

// 先読み: 読み込んだフォントは、サービスワーカーがキャッシュに入れるので、そのあとはオフラインでも使える
export function prefetchDiaryFonts(): Promise<void> {
  return loadDiaryFonts(PREFETCH_TEXT);
}
