// 記録が勝手に消されにくくする（navigator.storage.persist()。ブラウザが空き容量を作るときに、この端末のデータを消さないように頼む）
// 頼むのは、チュートリアルのあと（src/components/tutorial.ts）と、図鑑に初めて入れたとき（src/lib/db.ts の addRecord）
// 結果（許可された・断られた・使えない）は、この端末のブラウザ（localStorage）に残し、断られた・使えないときは、
// 設定の「データの 書き出し」に、書き出しの案内を出す（src/pages/settings.ts）。エラーにはせず、静かに扱う
export type PersistResult = 'granted' | 'denied' | 'unsupported';

export interface PersistRecord {
  result: PersistResult;
  at: number;
}

// テストで差しかえられるように、使う部分だけを型にする
export interface PersistApi {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const PERSIST_KEY = 'yotsuba-persist';

const local: KeyValue = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* 残せなくても、続ける */ } },
};

const storageApi = (): PersistApi | undefined => {
  try {
    return typeof navigator !== 'undefined' ? navigator.storage : undefined;
  } catch {
    return undefined;
  }
};

// 頼んで、結果を返す（すでに許可されていれば、頼まない）。どんなエラーも投げない
export async function askPersist(api: PersistApi | undefined = storageApi()): Promise<PersistResult> {
  try {
    if (!api?.persist) return 'unsupported';
    if (api.persisted && (await api.persisted())) return 'granted';
    return (await api.persist()) ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

// 頼んで、結果を残す。once が true のときは、前に結果を残していれば、頼まない（図鑑に入れるたびに頼まないため）
export async function requestPersist(opts: { once?: boolean; api?: PersistApi; store?: KeyValue; now?: () => number } = {}): Promise<PersistResult | null> {
  const store = opts.store ?? local;
  if (opts.once && readPersist(store)) return null;
  const result = await askPersist(opts.api ?? storageApi());
  store.set(PERSIST_KEY, JSON.stringify({ result, at: (opts.now ?? Date.now)() } satisfies PersistRecord));
  return result;
}

export function readPersist(store: KeyValue = local): PersistRecord | null {
  try {
    const raw = store.get(PERSIST_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as PersistRecord;
    return r && (r.result === 'granted' || r.result === 'denied' || r.result === 'unsupported') ? r : null;
  } catch {
    return null;
  }
}

// 設定に、書き出しの案内を出すか（断られた・使えないとき）
export const needsExportHint = (r: PersistRecord | null): boolean => r !== null && r.result !== 'granted';
