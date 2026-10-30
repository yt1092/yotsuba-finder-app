// レベル・経験値・バッジの計算（画面や DB に頼らない計算だけ。Node.js でそのままテストできるように: tests/progress.test.ts）
// 保存は src/lib/progress-db.ts。画面に出すのは、レベル・ランク・本数・次までの点だけ（確率やパーセントは出さない）

// 保存する中身（IndexedDB の入れ物「progress」に、1 件だけ）
export interface Progress {
  id: 'me';
  leaves: number;        // 調べた葉の合計（三つ葉＋四つ葉。同じ写真の 2 回目は数えない）
  fours: number;         // 四つ葉の数（保存したもの。同じ写真の 2 回目は数えない）
  diaryCards: number;    // 日記カードを作った数（1 つの記録につき 1 回まで）
  xp: number;            // 経験値の合計
  badges: { id: BadgeId; date: number }[]; // 獲得したバッジ
  photoHashes: string[]; // すでに数えた写真の目印（写真の内容から作った短いハッシュ）
  photoFourXp: Record<string, number>; // 写真ごとに、四つ葉の経験値を入れた数（-1 = 同じ写真の 2 回目を調べたので、もう入れない）
  diaryRecordIds: number[]; // 日記カードを作った記録の ID（2 回目は数えない）
  wroteNote: boolean;    // ひとことを書いたことがある
  drewInk: boolean;      // てがきをしたことがある
  taughtMistake?: boolean; // まちがいをおしえた（「入れない」を選んで、記録された）ことがある。経験値は付けない
}

export function emptyProgress(): Progress {
  return { id: 'me', leaves: 0, fours: 0, diaryCards: 0, xp: 0, badges: [], photoHashes: [], photoFourXp: {}, diaryRecordIds: [], wroteNote: false, drewInk: false };
}

// ── 経験値 ──

export const XP_PER_LEAF = 1;    // 写真から探すで、葉 1 本につき
export const XP_PER_FOUR = 100;  // 四つ葉を 1 つ保存するごとに
export const XP_PER_DIARY = 30;  // 日記カードを 1 枚作るごとに（1 つの記録につき 1 回まで）
// 1 枚の写真から入る経験値の上限（三つ葉を四つ葉と間違えやすい写真で、点が増えすぎないように）
export const MAX_LEAF_XP_PER_PHOTO = 200; // 葉の分（200 点まで）
export const MAX_FOURS_PER_PHOTO = 3;     // 四つ葉の分（3 つ = 300 点まで）

// ── レベル ──
// Lv1→2 は 100 点。そのあと、次のレベルまでの点が 50 ずつ増える（Lv2→3 は 150 点、Lv3→4 は 200 点…）

// Lv から Lv+1 に上がるのに要る点
export function xpForNext(level: number): number {
  return 100 + 50 * (level - 1);
}

// その Lv になるのに要る、経験値の合計（Lv1 は 0）
export function xpToReach(level: number): number {
  const n = level - 1;
  return 100 * n + 25 * n * (n - 1);
}

export interface LevelInfo {
  level: number;
  rank: string;
  into: number;   // 今の Lv になってから、ためた点
  need: number;   // 今の Lv から次の Lv までに要る点
  toNext: number; // 次の Lv まで、あと何点
}

export function levelInfo(xp: number): LevelInfo {
  const total = Math.max(0, Math.floor(xp));
  // xpToReach(L) <= total となる、いちばん大きい L（2 次式から見当をつけて、前後を直す）
  let level = Math.max(1, Math.floor((-75 + Math.sqrt(75 * 75 + 100 * total)) / 50) + 1);
  while (xpToReach(level + 1) <= total) level++;
  while (level > 1 && xpToReach(level) > total) level--;
  const into = total - xpToReach(level);
  const need = xpForNext(level);
  return { level, rank: rankName(level), into, need, toNext: need - into };
}

// ランクの名前
export const RANKS: { from: number; name: string }[] = [
  { from: 1, name: 'たね' },
  { from: 3, name: 'めばえ' },
  { from: 6, name: 'わかば' },
  { from: 10, name: 'みつば' },
  { from: 15, name: 'よつば' },
  { from: 25, name: 'よつばマスター' },
];

export function rankName(level: number): string {
  let name = RANKS[0].name;
  for (const r of RANKS) if (level >= r.from) name = r.name;
  return name;
}

// ── バッジ ──

export type BadgeId =
  | 'first-photo' | 'first-four'
  | 'leaves-100' | 'leaves-1000' | 'leaves-5000' | 'leaves-10000'
  | 'four-3' | 'four-10' | 'diary-3' | 'note' | 'ink' | 'first-teach';

export interface Badge {
  id: BadgeId;
  name: string;   // バッジの名前
  how: string;    // どうすれば取れるか（まだ取れていないときに出す）
  done: (p: Progress) => boolean;
}

// 「はじめての しゃしん」は、調べた写真の目印が 1 つでもあれば取れる
export const BADGES: Badge[] = [
  { id: 'first-photo', name: 'はじめての しゃしん', how: '写真から探すを、1回 つかう', done: p => p.photoHashes.length > 0 },
  { id: 'first-four', name: 'はじめての 四つ葉', how: '四つ葉を 1本 見つける', done: p => p.fours >= 1 },
  { id: 'leaves-100', name: '葉っぱ 100本', how: '葉を 100本 しらべる', done: p => p.leaves >= 100 },
  { id: 'leaves-1000', name: '葉っぱ 1,000本', how: '葉を 1,000本 しらべる', done: p => p.leaves >= 1000 },
  { id: 'leaves-5000', name: '葉っぱ 5,000本', how: '葉を 5,000本 しらべる', done: p => p.leaves >= 5000 },
  { id: 'leaves-10000', name: '葉っぱ 10,000本', how: '葉を 10,000本 しらべる', done: p => p.leaves >= 10000 },
  { id: 'four-3', name: '四つ葉 3本', how: '四つ葉を 3本 見つける', done: p => p.fours >= 3 },
  { id: 'four-10', name: '四つ葉 10本', how: '四つ葉を 10本 見つける', done: p => p.fours >= 10 },
  { id: 'diary-3', name: '日記カード 3まい', how: '日記カードを 3まい つくる', done: p => p.diaryCards >= 3 },
  { id: 'note', name: 'ひとこと', how: 'ひとことを 書く', done: p => p.wroteNote },
  { id: 'ink', name: 'てがき', how: '日記カードに てがきで かく', done: p => p.drewInk },
  // 経験値は付けない（「入れない」を増やすと点が増える、ということにしないため）
  { id: 'first-teach', name: 'はじめて まちがいを おしえた', how: '四つ葉ではない枠で「入れない」を えらぶ', done: p => p.taughtMistake === true },
];

// まだ使えないバッジ（あとで有効にする機能のもの）
export const DISABLED_BADGES = new Set<BadgeId>([]);

export const activeBadges = (): Badge[] => BADGES.filter(b => !DISABLED_BADGES.has(b.id));

// ── できごと（経験値と、本数を足す）──

export type ProgressEvent =
  | { kind: 'photo'; hash: string; leaves: number }      // 写真から探した（葉の数。四つ葉の分は 'four' で入れる）
  | { kind: 'four'; count: number; photoHash?: string }  // 四つ葉を図鑑に保存した（src/lib/save-four.ts から。写真のときはハッシュつき）
  | { kind: 'diary'; recordId: number }                                 // 日記カードを作った
  | { kind: 'note' }                                                    // ひとことを書いた
  | { kind: 'ink' }                                                     // てがきをした
  | { kind: 'teach' };                                                  // 「入れない」を選び、まちがいの記録に足した（経験値なし）

export interface ProgressResult {
  progress: Progress;
  gained: number;          // 今回入った経験値（0 のこともある）
  repeated: boolean;       // 同じ写真の 2 回目（経験値も本数も入れない）
  levelUp?: LevelInfo;     // レベルが上がったときの、新しいレベル
  newBadges: Badge[];      // 新しく取れたバッジ
}

// できごとを 1 つ反映した、新しい中身を返す（元の中身は変えない）
export function applyEvent(before: Progress, ev: ProgressEvent, now: number): ProgressResult {
  const p: Progress = { ...before, badges: [...before.badges], photoHashes: [...before.photoHashes],
    photoFourXp: { ...before.photoFourXp }, diaryRecordIds: [...before.diaryRecordIds] };
  let gained = 0;
  let repeated = false;
  switch (ev.kind) {
    case 'photo':
      if (p.photoHashes.includes(ev.hash)) {
        repeated = true;
        p.photoFourXp[ev.hash] = -1; // 同じ写真の 2 回目: この写真の四つ葉の分も、もう入れない
      } else {
        p.photoHashes.push(ev.hash);
        p.photoFourXp[ev.hash] = 0;
        p.leaves += ev.leaves;
        gained = Math.min(ev.leaves * XP_PER_LEAF, MAX_LEAF_XP_PER_PHOTO);
      }
      break;
    case 'four':
      if (ev.photoHash === undefined) {
        // カメラ: 上限なし
        p.fours += ev.count;
        gained = ev.count * XP_PER_FOUR;
      } else {
        const done = p.photoFourXp[ev.photoHash];
        if (done === undefined || done < 0) {
          repeated = true; // 調べていない写真・同じ写真の 2 回目: 本数も経験値も入れない
        } else {
          const counted = Math.min(ev.count, MAX_FOURS_PER_PHOTO - done);
          p.photoFourXp[ev.photoHash] = done + counted;
          p.fours += ev.count;
          gained = counted * XP_PER_FOUR;
        }
      }
      break;
    case 'diary':
      if (p.diaryRecordIds.includes(ev.recordId)) {
        repeated = true;
      } else {
        p.diaryRecordIds.push(ev.recordId);
        p.diaryCards += 1;
        gained = XP_PER_DIARY;
      }
      break;
    case 'note':
      p.wroteNote = true;
      break;
    case 'ink':
      p.drewInk = true;
      break;
    case 'teach':
      p.taughtMistake = true;
      break;
  }
  p.xp += gained;
  const oldLevel = levelInfo(before.xp).level;
  const info = levelInfo(p.xp);
  const have = new Set(p.badges.map(b => b.id));
  const newBadges = activeBadges().filter(b => !have.has(b.id) && b.done(p));
  for (const b of newBadges) p.badges.push({ id: b.id, date: now });
  return { progress: p, gained, repeated, levelUp: info.level > oldLevel ? info : undefined, newBadges };
}

// 2 つのできごとの結果を、1 つの知らせにまとめる（写真から探す: 葉の分 → 四つ葉の分）
export function mergeResults(a: ProgressResult, b: ProgressResult): ProgressResult {
  return {
    progress: b.progress,
    gained: a.gained + b.gained,
    repeated: a.repeated,
    levelUp: b.levelUp ?? a.levelUp,
    newBadges: [...a.newBadges, ...b.newBadges],
  };
}

// 写真の内容から作る、短いハッシュ（SHA-256 の先頭 16 文字）。同じ写真の 2 回目を見分けるため
export async function photoHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 数字を 3 けたごとに区切る（1,000 など）
export const formatCount = (n: number): string => n.toLocaleString('ja-JP');
