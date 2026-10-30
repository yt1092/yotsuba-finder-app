/// <reference types="vite/client" />

// onnxruntime-web の版（vite.config.ts の define で、ビルド時に文字列に置き換わる）
declare const __ORT_VERSION__: string;
declare const __APP_VERSION__: string; // package.json の version（設定の画面に出す）
declare const __DIAG__: boolean; // 診断の URL パラメータ（?diag=1 など。src/lib/diag.ts）と測定のファイルを入れるか（vite.config.ts。本番では false）
declare const __DEBUG_OVERLAY__: boolean; // 開発用の版か（vite.config.ts。false の本番では、デバッグ表示のコードが入らない）
