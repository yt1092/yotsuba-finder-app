// サービスワーカーを登録する（オフライン対応・PWA 化）
// どの画面から開いても登録されるように、すべての画面のスクリプトで読み込む
// 開発中（npm run dev）は、古いキャッシュで混乱しないように登録しない
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(error => {
    // 登録に失敗してもアプリは使えるので、記録だけ残して続ける
    console.warn('サービスワーカーを登録できませんでした', error);
  });
}
