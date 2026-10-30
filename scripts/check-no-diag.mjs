// 本番のビルド（dist/）に、診断のコード（?diag=1 など。src/lib/diag.ts）と、測定・診断のファイルが入っていないかを確かめる
// 使い方: 本番と同じ設定でビルドしてから（VERCEL_ENV=production npm run build）npm run check:no-diag（入っていたら、失敗で終わる）
// ふつうの npm run build（プレビュー・手元）では、入っているのが正しいので、このチェックは使わない
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 診断の表示のコードにだけ出てくる文字（本番の画面の文言には使わない）
const MARKERS = ['diag-box', '同じ写真で', 'お休みなし', '/models/diag/', 'yotsuba-photo-repeat', 'bench-ort', 'bench-threads'];
// 本番に入れないファイル
const FILES = ['bench.html', 'bench-threads.html', 'models/diag', 'bench-ort', 'bench-models'];

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
for (const f of FILES) {
  if (existsSync(join('dist', f))) {
    console.error(`測定・診断のファイルが入っています: dist/${f}`);
    found++;
  }
}
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of MARKERS) {
    // sw.js の「/models/diag/ はキャッシュしない」は、どの版にも同じひな形（sw/sw.js）から入る。本番では、そのファイルが無い（404）
    if (m === '/models/diag/' && /(^|[\\/])sw\.js$/.test(f)) continue;
    if (text.includes(m)) {
      console.error(`診断のコードが入っています: ${f}（「${m}」）`);
      found++;
    }
  }
}
if (found) process.exit(1);
console.log(`OK: dist/ の ${files.length} 個のファイルに、診断のコードと測定・診断のファイルは入っていません`);
