// データの書き出しと読み込み（設定の「データの 書き出しと 読み込み」）の、画面や DB に頼らない部分（tests/backup.test.ts）
// 1 つの JSON にまとめる: 図鑑の記録（ひとこと・日記の手書きも記録の中）・今日のよつばの一覧・まちがいの記録・きろく（経験値・バッジ）・調整・設定
// 入れないもの: 今日のよつばの端末ごとの値（種のもと）と今日の形・最後に調べた写真・チュートリアルの「見た」印・
//               版 5 へ上げたときに残した、移す前の元の値（src/lib/gacha-move.ts）
// 版 1: 今日のよつばも records に入っていた。版 2: 今日のよつばは gacha に分けた（版 1 のファイルも読める。records の中の今日のよつばを分ける）
// 外部との通信はしない（ファイルは、使う人が共有画面かダウンロードで受けとる。読み込みも、使う人が選んだファイルだけ）
// IndexedDB との読み書きは src/lib/backup-db.ts
import type { CloverRecord } from './db';
import type { FeedbackEntry } from './feedback';
import type { Progress } from './progress';
import type { TuningState } from './tuning-db';
import type { SaveMode } from './save-mode';
import { splitGacha } from './gacha-list.ts';

export const BACKUP_APP = 'yotsuba-finder';
export const BACKUP_SCHEMA = 2;               // 中身の形の版。形を変えたら上げて、古い版を読めるように直す（版 1 も読める）
export const BIG_EXPORT_BYTES = 50 * 1024 * 1024; // これを超えたら、「写真なしで 書き出す」も選べるようにする
export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024; // 読み込むファイルの大きさの上限（1GB）

// まちがいの記録は、写真（JPEG）を base64 の文字にして入れる
export type BackupFeedback = Omit<FeedbackEntry, 'photo'> & { photo: string };

export interface BackupSettings {
  saveMode: SaveMode;
}

export interface BackupData {
  app: typeof BACKUP_APP;
  schemaVersion: number;
  exportedAt: number;
  appVersion: string;
  withPhotos: boolean;         // false のときは、写真の記録の写真（imageDataUrl）と、まちがいの記録が入っていない
  records: CloverRecord[];     // id も入れる（日記カードの経験値・まちがいの記録が、記録の id を使うため）。見つけた写真だけ
  gacha: CloverRecord[];       // 今日のよつばの一覧（版 2 から。id も入れる。図鑑の記録の id とは重ならない）
  feedback: BackupFeedback[];
  progress: Progress | null;   // きろく（経験値・バッジ）
  tuning: TuningState | null;  // あなたに合わせた調整
  settings: BackupSettings;
}

// ── base64（ArrayBuffer ⇔ 文字）──

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBuffer(text: string): ArrayBuffer {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

// ── 書き出し ──

export interface BackupSource {
  records: CloverRecord[];
  gacha: CloverRecord[];
  feedback: FeedbackEntry[];
  progress: Progress | null;
  tuning: TuningState | null;
  settings: BackupSettings;
}

export function buildBackup(src: BackupSource, opts: { withPhotos: boolean; now: number; appVersion: string }): BackupData {
  const split = splitGacha(src.records); // 図鑑の入れ物に移せずに残った今日のよつばも、gacha に入れる
  return {
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA,
    exportedAt: opts.now,
    appVersion: opts.appVersion,
    withPhotos: opts.withPhotos,
    records: split.photos.map(r => (opts.withPhotos ? r : { ...r, imageDataUrl: '' })),
    gacha: [...src.gacha, ...split.gacha], // 今日のよつばの絵は、写真ではなく小さいので、いつも入れる
    feedback: opts.withPhotos ? src.feedback.map(f => ({ ...f, photo: bufferToBase64(f.photo) })) : [],
    progress: src.progress,
    tuning: src.tuning,
    settings: src.settings,
  };
}

export const backupText = (data: BackupData): string => JSON.stringify(data);

// UTF-8 にしたときの大きさ（バイト。書き出す前に、目安として出す）
export const textBytes = (text: string): number => new TextEncoder().encode(text).length;

// 画面に出す大きさ（「約 12MB」。1MB より小さければ「1MB より 小さい」）
export function sizeLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? '1MB より 小さい' : `約 ${Math.round(mb)}MB`;
}

export const backupFileName = (day: string): string => `yotsuba-backup-${day}.json`;

// ── 読み込み: 形・版・大きさを確かめる（だめなら、何も書きかえない）──

export type ParseResult = { ok: true; data: BackupData } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function checkRecord(r: unknown): boolean {
  if (!isObj(r)) return false;
  if (r.id !== undefined && !(isNum(r.id) && Number.isInteger(r.id) && r.id > 0)) return false;
  if (!isNum(r.date) || !isStr(r.imageDataUrl)) return false;
  if (r.imageDataUrl && !r.imageDataUrl.startsWith('data:image/')) return false; // 写真は data: の画像だけ（外の URL は読まない）
  if (r.label !== '四つ葉' && r.label !== '三つ葉') return false;
  if (r.source !== 'camera' && r.source !== 'photo' && r.source !== 'gacha') return false;
  if (r.note !== undefined && !isStr(r.note)) return false;
  if (r.detections !== undefined && !Array.isArray(r.detections)) return false;
  if (r.shape64 !== undefined && !(isStr(r.shape64) && r.shape64.startsWith('data:image/'))) return false;
  return true;
}

function checkFeedback(f: unknown): boolean {
  return isObj(f) && isStr(f.key) && isNum(f.date) && isStr(f.photo) && isNum(f.width) && isNum(f.height)
    && Array.isArray(f.detections) && Array.isArray(f.answers);
}

export function parseBackup(text: string, bytes: number, maxBytes = MAX_IMPORT_BYTES): ParseResult {
  const bad = (error: string): ParseResult => ({ ok: false, error });
  if (bytes > maxBytes) return bad('ファイルが 大きすぎます。このアプリで 書き出した ファイルを えらんでください');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad('ファイルが こわれているか、このアプリの ファイルでは ありません');
  }
  if (!isObj(raw) || raw.app !== BACKUP_APP) return bad('このアプリで 書き出した ファイルでは ありません');
  if (!isNum(raw.schemaVersion) || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) return bad('ファイルが こわれています');
  if (raw.schemaVersion > BACKUP_SCHEMA) return bad('新しい アプリで 書き出した ファイルです。アプリを 新しくしてから、読み込んでください');
  if (!Array.isArray(raw.records) || !raw.records.every(checkRecord)) return bad('ファイルが こわれています（図鑑の 記録）');
  // 版 1 には gacha が無い（今日のよつばは records の中）。版 2 からは、かならずある
  if (raw.schemaVersion >= 2 && !(Array.isArray(raw.gacha) && raw.gacha.every(g => checkRecord(g) && (g as { source: unknown }).source === 'gacha'))) {
    return bad('ファイルが こわれています（今日のよつば）');
  }
  const split = splitGacha(raw.records as CloverRecord[]);
  const gacha = [...(raw.schemaVersion >= 2 ? (raw.gacha as CloverRecord[]) : []), ...split.gacha];
  if (!Array.isArray(raw.feedback) || !raw.feedback.every(checkFeedback)) return bad('ファイルが こわれています（まちがいの 記録）');
  if (raw.progress !== null && !(isObj(raw.progress) && raw.progress.id === 'me' && isNum(raw.progress.xp))) return bad('ファイルが こわれています（きろく）');
  if (raw.tuning !== null && !(isObj(raw.tuning) && raw.tuning.id === 'tuning' && Array.isArray(raw.tuning.choices))) return bad('ファイルが こわれています（調整）');
  if (!isObj(raw.settings)) return bad('ファイルが こわれています（設定）');
  const ids = [...split.photos, ...gacha].map(r => r.id).filter(id => id !== undefined);
  if (new Set(ids).size !== ids.length) return bad('ファイルが こわれています（図鑑の 記録）'); // 図鑑と今日のよつばで、id は重ならない
  for (const f of raw.feedback as BackupFeedback[]) {
    try { atob(f.photo); } catch { return bad('ファイルが こわれています（まちがいの 記録の 写真）'); }
  }
  const settings: BackupSettings = { saveMode: (raw.settings as { saveMode?: unknown }).saveMode === 'auto' ? 'auto' : 'confirm' };
  return { ok: true, data: { ...(raw as unknown as BackupData), records: split.photos, gacha, withPhotos: raw.withPhotos !== false, settings } };
}

// ── 読み込み: 何を書くかを決める ──
// 上書き: 今のデータ（図鑑・まちがいの記録・きろく・調整）を、ファイルの中身に置きかえる。設定も置きかえる
// 足す: 図鑑・今日のよつば・まちがいの記録だけを足す（同じ記録は足さない）。きろく（経験値）・調整・設定は、今のまま（経験値の決まりは変えない）

export type ImportMode = 'replace' | 'add';

export interface ImportPlan {
  mode: ImportMode;
  // 書く記録。上書きは id のまま、足すは id を付け直す（oldId は、ファイルの中の id。まちがいの記録の名前を直すのに使う）
  records: { oldId?: number; record: Omit<CloverRecord, 'id'> & { id?: number } }[];
  gacha: { record: Omit<CloverRecord, 'id'> & { id?: number } }[]; // 今日のよつば（上書きは id のまま、足すは id を付け直す）
  feedback: BackupFeedback[];
  progress: Progress | null | 'keep';
  tuning: TuningState | null | 'keep';
  settings: BackupSettings | 'keep';
  skipped: number; // 足すときに、もうあるので足さなかった記録の数
}

// 同じ記録か（日時・出どころ・ラベル・今日のよつばの日付が同じ）
const sameKey = (r: Pick<CloverRecord, 'date' | 'source' | 'label' | 'gachaDay'>): string => `${r.date}|${r.source}|${r.label}|${r.gachaDay ?? ''}`;

// 写真が入っていない記録は、写真の目印を付ける（画面では、写真の代わりの絵を出す。src/lib/backup-db.ts）
const markMissing = <T extends CloverRecord>(r: T): T => (r.imageDataUrl ? r : { ...r, photoMissing: true, detections: [] });

export function planImport(data: BackupData, mode: ImportMode, current: Pick<CloverRecord, 'date' | 'source' | 'label' | 'gachaDay'>[], currentFeedbackKeys: string[]): ImportPlan {
  if (mode === 'replace') {
    return {
      mode,
      records: data.records.map(r => ({ oldId: r.id, record: markMissing(r) })),
      gacha: data.gacha.map(r => ({ record: r })),
      feedback: data.feedback,
      progress: data.progress,
      tuning: data.tuning,
      settings: data.settings,
      skipped: 0,
    };
  }
  const have = new Set(current.map(sameKey));
  const records: ImportPlan['records'] = [];
  let skipped = 0;
  for (const r of data.records) {
    const key = sameKey(r);
    if (have.has(key)) { skipped++; continue; }
    have.add(key);
    const { id, ...rest } = markMissing(r);
    records.push({ oldId: id, record: rest });
  }
  const gacha: ImportPlan['gacha'] = [];
  for (const r of data.gacha) {
    const key = sameKey(r);
    if (have.has(key)) { skipped++; continue; }
    have.add(key);
    const { id: _id, ...rest } = r;
    gacha.push({ record: rest });
  }
  const keys = new Set(currentFeedbackKeys);
  return {
    mode,
    records,
    gacha,
    feedback: data.feedback.filter(f => !keys.has(f.key)),
    progress: 'keep',
    tuning: 'keep',
    settings: 'keep',
    skipped,
  };
}

// まちがいの記録の名前（record:<id>）を、足したあとの記録の id に直す。足さなかった記録のもの（id が無い）は、null（足さない）
export function remapFeedbackKey(key: string, ids: Map<number, number>, mode: ImportMode): string | null {
  if (mode === 'replace') return key;
  const m = /^record:(\d+)$/.exec(key);
  if (!m) return key;
  const next = ids.get(Number(m[1]));
  return next === undefined ? null : `record:${next}`;
}
