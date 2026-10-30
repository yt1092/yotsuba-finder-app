// onnxruntime-web の wasm を public/ort/<版>/ にコピーする（外部の CDN を使わず、自分のサイトから配るため）
// npm run dev / npm run build の前に自動で実行される（package.json の predev / prebuild）
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = 'node_modules/onnxruntime-web';
const from = join(pkgDir, 'dist');
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const root = 'public/ort';
const to = join(root, version); // 例: public/ort/1.30.0

// onnxruntime-web/webgpu が WebGPU でも WASM でも使う「asyncify」版のファイルだけをコピーする
const files = readdirSync(from).filter(name => /^ort-wasm-simd-threaded\.asyncify\.(wasm|mjs)$/.test(name));
if (files.length !== 2) {
  throw new Error(`${from} に ort-wasm-simd-threaded.asyncify.{wasm,mjs} が見つかりません。npm install を実行してください。`);
}

mkdirSync(to, { recursive: true });

// public/ort/ の中の、今の版以外のもの（古い版のフォルダや、以前の置き方のファイル）を消す
for (const name of readdirSync(root)) {
  if (name !== version) {
    rmSync(join(root, name), { recursive: true, force: true });
    console.log(`removed ${root}/${name}`);
  }
}

// 中身が同じなら書き直さない（開発サーバーが監視しているファイルを書き換えると、Windows でエラーになるため）
for (const name of files) {
  const src = join(from, name);
  const dest = join(to, name);
  if (existsSync(dest) && readFileSync(src).equals(readFileSync(dest))) continue;
  copyFileSync(src, dest);
  console.log(`copied ${name} → ${to}/`);
}
