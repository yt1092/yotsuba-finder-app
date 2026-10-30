// 使うほど合う、端末内の調整: 選んだ記録と、オン・オフを IndexedDB に残す（外には送らない。計算は src/lib/tuning.ts）
// 入れ物は「progress」の id: 'tuning'（きろくを消しても、これは消えない。設定の「調整を もとに もどす」で消す）
// 開発用の ?detector=dummy のときは、記録しない（本物の検出ではないため）
import { openDb, PROGRESS_STORE } from './db';
import { MODEL_URL, SCORE_THRESHOLD } from './detector-config';
import type { DetectMode } from './detector';
import { tuneThreshold, type Choice, type TuningResult } from './tuning';
import { usingDummyDetector } from './progress-db';

const MAX_CHOICES = 1000; // 新しいものから、この数まで残す

export interface TuningState {
  id: 'tuning';
  enabled: boolean;                          // 「あなたに合わせて調整する」（既定はオン）
  choices: (Choice & { at: number })[];
  model?: string;                            // 記録のスコアを出したモデル（MODEL_URL）。今のモデルとちがえば、記録は使わない
}

const empty = (): TuningState => ({ id: 'tuning', enabled: true, choices: [], model: MODEL_URL });

// モデルが変わったら、前のモデルのスコアの記録は使わない（スコアの出かたが変わるため。オン・オフはそのまま）
const forCurrentModel = (s: TuningState): TuningState => (s.model === MODEL_URL ? s : { ...s, choices: [], model: MODEL_URL });

export async function getTuning(): Promise<TuningState> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(PROGRESS_STORE, 'readonly').objectStore(PROGRESS_STORE).get('tuning');
    req.onsuccess = () => resolve(forCurrentModel({ ...empty(), model: undefined, ...(req.result as TuningState | undefined) }));
    req.onerror = () => reject(req.error);
  });
}

async function update(change: (s: TuningState) => TuningState): Promise<TuningState> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROGRESS_STORE, 'readwrite');
    const store = tx.objectStore(PROGRESS_STORE);
    let next: TuningState;
    const req = store.get('tuning');
    req.onsuccess = () => {
      next = change(forCurrentModel({ ...empty(), model: undefined, ...(req.result as TuningState | undefined) }));
      store.put(next);
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => reject(tx.error);
  });
}

// 確認のポップアップで選んだもの（スコアと、入れたか）を足す
export async function addChoices(choices: Choice[]): Promise<void> {
  if (choices.length === 0 || usingDummyDetector()) return;
  const at = Date.now();
  await update(s => ({ ...s, choices: [...s.choices, ...choices.map(c => ({ score: c.score, keep: c.keep, at }))].slice(-MAX_CHOICES) }));
}

export const setTuningEnabled = (enabled: boolean): Promise<TuningState> => update(s => ({ ...s, enabled }));

// 調整を もとに もどす（選んだ記録を消す。オン・オフはそのまま）
export const resetTuning = (): Promise<TuningState> => update(s => ({ ...s, choices: [] }));

// 今の調整（写真から探すのしきい値を基準に計算し、同じ差を、カメラのしきい値にも使う）
export function currentTuning(s: TuningState): TuningResult {
  return tuneThreshold(s.choices, SCORE_THRESHOLD.photo, s.enabled);
}

// 四つ葉の候補を出すしきい値（調整なし・読めないときは、場面ごとのもとの値）
export async function fourThresholdFor(mode: DetectMode): Promise<number> {
  try {
    return Math.round((SCORE_THRESHOLD[mode] + currentTuning(await getTuning()).shift) * 1000) / 1000;
  } catch {
    return SCORE_THRESHOLD[mode];
  }
}
