// 本番のビルド（dist/）に、デバッグ表示（枠ごとのスコアの数字など。src/lib/dev-mode.ts）のコードが入っていないかを確かめる
// 使い方: npm run build のあとに npm run check:no-debug（入っていたら、失敗で終わる）
// 開発用の版（VITE_DEBUG_OVERLAY=1 npm run build）では、入っているのが正しいので、このチェックは使わない
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// デバッグ表示のコードにだけ出てくる文字（本番の画面の文言には使わない）
const MARKERS = ['yotsuba-dev', 'デバッグ表示', '追跡', 'ui-monospace'];

const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html)$/.test(name)) files.push(p);
  }
};
walk('dist');

let found = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of MARKERS) {
    if (text.includes(m)) {
      console.error(`デバッグ表示のコードが入っています: ${f}（「${m}」）`);
      found++;
    }
  }
}
if (found) process.exit(1);
console.log(`OK: dist/ の ${files.length} 個のファイルに、デバッグ表示のコードは入っていません`);
