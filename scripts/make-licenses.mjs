// 「このアプリについて」（about.html）で見せるファイルを、public/about/ に作る（npm run dev・npm run build の前に自動で動く）
//   - licenses.json: アプリと一緒に配る部品（package.json の dependencies と、その先の依存）の名前・版・ライセンス・ライセンスの文
//     node_modules の中の package.json と LICENSE を読むだけ（外への通信はしない）。開発用（devDependencies）は配らないので入れない
//   - LICENSE.txt: このアプリのライセンス（AGPL-3.0）の全文
//   - CREDITS.md: 使ったデータ・絵・フォント・部品の出どころ
// public/about/ は Git に入れない（.gitignore。元のファイルから、いつでも作り直せるため）
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'about');

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

// 部品の中にライセンスの文のファイルが無いもの: 元のリポジトリの LICENSE と同じ文を入れる
const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const ISC = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
const KNOWN_TEXT = {
  // onnxruntime の LICENSE（https://github.com/microsoft/onnxruntime の v1.30.0 と同じ文）
  'onnxruntime-web': `MIT License\n\nCopyright (c) Microsoft Corporation\n\n${MIT}`,
  'onnxruntime-common': `MIT License\n\nCopyright (c) Microsoft Corporation\n\n${MIT}`,
  // 部品にも元のリポジトリにも LICENSE が無い。package.json の license（ISC）と author（nicolas）から書いた ISC の文（年の記録は無い）
  'guid-typescript': `ISC License\n\nCopyright (c) nicolas\n\n${ISC}`,
};
// 部品の wasm に入っている、ほかの部品のライセンス（onnxruntime の ThirdPartyNotices.txt。v1.30.0 のものを scripts/third-party/ に写した）
// 部品の版が変わったら、その版の ThirdPartyNotices.txt に置きかえる（版が合わなければ、止まる）
const NOTICES = {
  'onnxruntime-web': { version: '1.30.0', file: join(dirname(fileURLToPath(import.meta.url)), 'third-party', 'onnxruntime-1.30.0-ThirdPartyNotices.txt') },
};

// 依存をたどる（node_modules は平らに入っている。入れ子の node_modules も見る）
function findPackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) return null;
  }
}

export function collectLicenses(root = ROOT) {
  const seen = new Map();
  const visit = (name, from) => {
    const pj = findPackage(name, from);
    if (!pj) throw new Error(`見つからない部品: ${name}（npm ci を先に）`);
    const pkg = readJson(pj);
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return;
    const dir = dirname(pj);
    const files = readdirSync(dir).filter(f => LICENSE_FILE.test(f)).sort();
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map(l => l.type).join(' OR ');
    const repository = (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
    const fileText = files.map(f => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
    // ライセンスの全文が無い部品は、作れないようにする（全文を KNOWN_TEXT に足す）
    let text = fileText || KNOWN_TEXT[pkg.name];
    if (!text) throw new Error(`ライセンスの全文が無い部品: ${key}（${license}）。scripts/make-licenses.mjs の KNOWN_TEXT に足す`);
    const notice = NOTICES[pkg.name];
    if (notice) {
      if (notice.version !== pkg.version) throw new Error(`${key}: ThirdPartyNotices の版（${notice.version}）が合わない。scripts/third-party/ を、この版のものに置きかえる`);
      text += `\n\n----- ThirdPartyNotices（${pkg.name} ${pkg.version} の wasm に入っている部品のライセンス）-----\n\n${readFileSync(notice.file, 'utf8').trim()}`;
    }
    seen.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: license || '（package.json に書かれていない）',
      repository,
      text,
      fileFound: Boolean(fileText),
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir);
  };
  for (const dep of Object.keys(readJson(join(root, 'package.json')).dependencies ?? {})) visit(dep, root);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT, { recursive: true });
  const list = collectLicenses();
  writeFileSync(join(OUT, 'licenses.json'), JSON.stringify(list));
  copyFileSync(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE.txt'));
  copyFileSync(join(ROOT, 'CREDITS.md'), join(OUT, 'CREDITS.md'));
  const unknown = list.filter(p => !p.fileFound);
  console.log(`public/about/ を作りました（部品 ${list.length} 個${unknown.length ? `。部品の中にライセンスの文のファイルが無いので、この中の全文を入れた: ${unknown.map(p => p.name).join(', ')}` : ''}）`);
}
