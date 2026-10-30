// 小さな zip 作成（圧縮しない「格納」形式。写真は JPEG なので、圧縮してもほとんど小さくならない）
// ライブラリを足さずに、zip の決まり（PKWARE APPNOTE）どおりに並べるだけ。端末の中だけで作り、通信はしない
// テスト: tests/zip.test.ts

export interface ZipEntry {
  name: string;      // zip の中のファイル名（UTF-8。フォルダは「/」で区切る）
  data: Uint8Array;
  date?: Date;       // 更新日時（省略時は今）
}

// CRC-32（zip で使う、ファイルの中身の検査用の数）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// zip の日時（MS-DOS の形式。2 秒単位）
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_FLAG = 0x0800; // ファイル名が UTF-8 であることを示す印

// ファイルを並べて、1 つの zip（バイト列）にする
export function createZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const { time, date } = dosDateTime(entry.date ?? new Date());

    // ローカルファイルヘッダー（30 バイト）＋ 名前 ＋ 中身
    const local = new Uint8Array(30 + name.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);         // 展開に必要な版（2.0）
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true);          // 圧縮方法: 0 = 格納
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);      // 圧縮後の大きさ
    lv.setUint32(22, size, true);      // 元の大きさ
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);         // 追加の欄の長さ
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    locals.push(local);

    // セントラルディレクトリのヘッダー（46 バイト）＋ 名前
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);         // 作った版
    cv.setUint16(6, 20, true);         // 展開に必要な版
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    // 30〜41: 追加の欄・コメント・ディスク番号・属性（すべて 0）
    cv.setUint32(42, offset, true);    // ローカルファイルヘッダーの位置
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  // 終わりの印（22 バイト）
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(new ArrayBuffer(offset + centralSize + end.length));
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
