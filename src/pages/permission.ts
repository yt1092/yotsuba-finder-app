// Permission（カメラ許可）画面の初期化
// ここでは、カメラの許可を求めない。「カメラを許可する」を押すと、スキャン画面に移り、そこで 1 回だけ許可をきく
// （以前は、ここで 1 回きいてすぐ止め、スキャン画面でもう 1 回きいていたため、iPhone で 2 回きかれていた）
// すでに許可されているときは、この画面を飛ばす
import '../lib/register-sw';
import { injectSvgDefs } from '../components/svg-defs';

injectSvgDefs();

navigator.permissions?.query({ name: 'camera' as PermissionName })
  .then(s => { if (s.state === 'granted') location.replace('scan.html'); })
  .catch(() => undefined); // 調べられないブラウザでは、ふつうに出す

document.getElementById('allowBtn')?.addEventListener('click', () => {
  location.href = 'scan.html';
});
