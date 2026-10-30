// 四つ葉・三つ葉の SVG シンボルを body 先頭に注入する
// 全ページで共通の shape（#lf, #lfH, #cH, #c3）と filter を定義する
export function injectSvgDefs(): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;pointer-events:none';
  svg.innerHTML = `
    <defs>
      <radialGradient id="gLeaf" cx="0.5" cy="0.85" r="0.95">
        <stop offset="0" stop-color="#C9F58A"/>
        <stop offset="0.5" stop-color="#5DC25B"/>
        <stop offset="1" stop-color="#1F8A44"/>
      </radialGradient>
      <path id="lf" d="M0 0 C-15 -9 -24 -27 -11 -35 C-5 -38.5 0 -33 0 -28.5 C0 -33 5 -38.5 11 -35 C24 -27 15 -9 0 0 Z"/>
      <g id="lfH">
        <use href="#lf" fill="url(#gLeaf)" stroke="rgba(8,70,28,0.5)" stroke-width="0.7"/>
        <path d="M-9 -26 L0 -17 L9 -26" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M0 -5 L0 -13" fill="none" stroke="rgba(8,70,28,0.3)" stroke-width="1" stroke-linecap="round"/>
      </g>
      <g id="cH">
        <use href="#lfH"/>
        <use href="#lfH" transform="rotate(90)"/>
        <use href="#lfH" transform="rotate(180)"/>
        <use href="#lfH" transform="rotate(270)"/>
        <circle r="2.2" fill="#F4FFC9"/>
      </g>
      <g id="c3">
        <use href="#lf"/>
        <use href="#lf" transform="rotate(120)"/>
        <use href="#lf" transform="rotate(240)"/>
      </g>
      <filter id="fB2" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2"/>
      </filter>
      <filter id="fB3" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2.4"/>
      </filter>
      <filter id="fB7" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="7"/>
      </filter>
      <filter id="fGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="4" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <linearGradient id="gG1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#B4E08E"/>
        <stop offset="1" stop-color="#5FAE55"/>
      </linearGradient>
      <linearGradient id="gG2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#9FD87F"/>
        <stop offset="1" stop-color="#4E9E52"/>
      </linearGradient>
      <linearGradient id="gShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.5" stop-color="#0A2A12" stop-opacity="0"/>
        <stop offset="1" stop-color="#0A2A12" stop-opacity="0.65"/>
      </linearGradient>
      <linearGradient id="gGrass" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#B4E08E"/>
        <stop offset="1" stop-color="#5FAE55"/>
      </linearGradient>
      <radialGradient id="gSun" cx="0.3" cy="0.1" r="0.9">
        <stop offset="0" stop-color="#FFF6C8" stop-opacity="0.9"/>
        <stop offset="1" stop-color="#FFF6C8" stop-opacity="0"/>
      </radialGradient>
    </defs>
  `;
  document.body.insertBefore(svg, document.body.firstChild);
}
