// 「今日のよつば」の確認のポップアップ: 図鑑に入れる前に、形を大きく見せて「図鑑に入れる」「入れない」を選ぶ
// 見た目は、検出の確認のポップアップ（four-confirm.ts）と同じ部品（.confirm）を使う
// four-confirm.ts は使わない: あちらは検出の候補のためのもので、「入れない」を、まちがいの記録・調整の記録に足すため
// 戻り値: true = 図鑑に入れる・false = 入れない（× や Esc で閉じたときも）
export function openGachaConfirm(src: string, alt: string): Promise<boolean> {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.innerHTML = `
      <div class="confirm" role="dialog" aria-modal="true" aria-labelledby="gachaConfirmTitle">
        <div class="sheet-head">
          <h2 id="gachaConfirmTitle" class="confirm-title">図鑑に入れますか</h2>
          <button type="button" class="btn-icon" data-close aria-label="とじる">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="gacha-confirm-img"><img alt=""></div>
        <div class="confirm-choice">
          <button type="button" class="btn-primary" data-keep>図鑑に入れる</button>
          <button type="button" class="btn-secondary" data-skip>入れない</button>
        </div>
      </div>`;
    const img = backdrop.querySelector('img')!;
    img.src = src;
    img.alt = alt;
    const before = document.activeElement as HTMLElement | null;

    const close = (keep: boolean) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      before?.focus();
      resolve(keep);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    backdrop.querySelector('[data-keep]')!.addEventListener('click', () => close(true));
    backdrop.querySelector('[data-skip]')!.addEventListener('click', () => close(false));
    backdrop.querySelector('[data-close]')!.addEventListener('click', () => close(false));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    (backdrop.querySelector('[data-keep]') as HTMLButtonElement).focus();
  });
}
