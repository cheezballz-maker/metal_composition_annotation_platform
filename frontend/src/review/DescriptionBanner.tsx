import React from "react";

/** Decorative artwork adapted from the original annotation platform. */
export function DescriptionBannerArt() {
  const id = React.useId().replace(/:/g, "");
  return <>
      <div className="description-banner-atmosphere" aria-hidden="true">
        <svg className="molecule-waveband band-back" viewBox="0 0 1800 180" role="presentation">
          <defs>
            <radialGradient id="description-sphere-sage-back" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#edf4f0" />
              <stop offset="72%" stopColor="#b8cabe" />
              <stop offset="100%" stopColor="#91aa9e" />
            </radialGradient>
            <radialGradient id="description-sphere-blue-back" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#eef4f7" />
              <stop offset="72%" stopColor="#b8c8d4" />
              <stop offset="100%" stopColor="#92a9ba" />
            </radialGradient>
            <radialGradient id="description-sphere-lilac-back" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#f2eff6" />
              <stop offset="72%" stopColor="#c7bfd0" />
              <stop offset="100%" stopColor="#a9a1b6" />
            </radialGradient>
          </defs>
          <path className="waveband-link" d="M-120 104C12 84 128 44 244 44C374 44 470 118 594 118C720 118 826 44 952 44C1076 44 1184 114 1300 114C1426 114 1538 52 1662 52C1732 52 1800 78 1888 100" />
          <path className="waveband-link soft" d="M120 42C148 18 180 8 220 8C266 8 302 24 334 58" />
          <path className="waveband-link soft" d="M818 44C850 18 884 6 924 6C970 6 1008 24 1040 58" />
          <path className="waveband-link soft" d="M1516 52C1548 24 1582 12 1624 12C1668 12 1702 28 1738 60" />
          <circle className="waveband-sphere large sphere-sage" cx="52" cy="104" r="18" />
          <circle className="waveband-sphere large sphere-lilac" cx="244" cy="44" r="20" />
          <circle className="waveband-sphere large sphere-blue" cx="594" cy="118" r="21" />
          <circle className="waveband-sphere large sphere-sage" cx="952" cy="44" r="22" />
          <circle className="waveband-sphere large sphere-lilac" cx="1300" cy="114" r="20" />
          <circle className="waveband-sphere large sphere-blue" cx="1662" cy="52" r="21" />
          <circle className="waveband-sphere small sphere-blue" cx="334" cy="58" r="10" />
          <circle className="waveband-sphere small sphere-sage" cx="1040" cy="58" r="10" />
          <circle className="waveband-sphere small sphere-lilac" cx="1738" cy="60" r="10" />
        </svg>
        <svg className="molecule-waveband band-mid" viewBox="0 0 1800 180" role="presentation">
          <defs>
            <radialGradient id="description-sphere-peach-mid" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#f7f2e9" />
              <stop offset="72%" stopColor="#d3c5ac" />
              <stop offset="100%" stopColor="#b3a187" />
            </radialGradient>
            <radialGradient id="description-sphere-blue-mid" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#edf3f6" />
              <stop offset="72%" stopColor="#bdcad3" />
              <stop offset="100%" stopColor="#9bafbb" />
            </radialGradient>
            <radialGradient id="description-sphere-rose-mid" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#f4eff2" />
              <stop offset="72%" stopColor="#cdbec7" />
              <stop offset="100%" stopColor="#aa9ca8" />
            </radialGradient>
          </defs>
          <path className="waveband-link midline" d="M-180 128C-30 128 104 72 232 72C360 72 456 142 584 142C712 142 812 72 936 72C1060 72 1168 140 1294 140C1426 140 1534 84 1654 84C1754 84 1834 106 1940 128" />
          <path className="waveband-link soft" d="M232 72C262 42 294 28 336 28C380 28 414 42 452 76" />
          <path className="waveband-link soft" d="M936 72C968 42 1002 28 1044 28C1088 28 1124 44 1160 80" />
          <circle className="waveband-sphere large sphere-peach" cx="54" cy="128" r="19" />
          <circle className="waveband-sphere large sphere-blue" cx="232" cy="72" r="21" />
          <circle className="waveband-sphere large sphere-rose" cx="584" cy="142" r="22" />
          <circle className="waveband-sphere large sphere-peach" cx="936" cy="72" r="20" />
          <circle className="waveband-sphere large sphere-blue" cx="1294" cy="140" r="21" />
          <circle className="waveband-sphere large sphere-rose" cx="1654" cy="84" r="20" />
          <circle className="waveband-sphere small sphere-rose" cx="452" cy="76" r="10" />
          <circle className="waveband-sphere small sphere-peach" cx="1160" cy="80" r="10" />
        </svg>
        <svg className="molecule-waveband band-front" viewBox="0 0 1800 180" role="presentation">
          <defs>
            <radialGradient id="description-sphere-gold-front" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#f8f4e8" />
              <stop offset="72%" stopColor="#d2c6a8" />
              <stop offset="100%" stopColor="#ad9f80" />
            </radialGradient>
            <radialGradient id="description-sphere-lilac-front" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#f1eef6" />
              <stop offset="72%" stopColor="#c5bfd1" />
              <stop offset="100%" stopColor="#a7a0b7" />
            </radialGradient>
            <radialGradient id="description-sphere-mist-front" cx="34%" cy="28%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#eef3f3" />
              <stop offset="72%" stopColor="#becbcc" />
              <stop offset="100%" stopColor="#9eafb1" />
            </radialGradient>
          </defs>
          <path className="waveband-link crisp" d="M-160 96C-36 96 72 144 188 144C308 144 404 78 524 78C644 78 740 142 862 142C984 142 1088 86 1202 86C1320 86 1412 132 1530 132C1648 132 1746 96 1880 96" />
          <circle className="waveband-sphere medium sphere-gold" cx="16" cy="96" r="15" />
          <circle className="waveband-sphere medium sphere-lilac" cx="188" cy="144" r="16" />
          <circle className="waveband-sphere medium sphere-mist" cx="524" cy="78" r="16" />
          <circle className="waveband-sphere medium sphere-gold" cx="862" cy="142" r="15" />
          <circle className="waveband-sphere medium sphere-lilac" cx="1202" cy="86" r="16" />
          <circle className="waveband-sphere medium sphere-mist" cx="1530" cy="132" r="15" />
        </svg>
        <div className="molecule-haze haze-a" />
        <div className="molecule-haze haze-b" />
      </div>

    <svg className="description-banner-mark" viewBox="0 0 84 84" aria-hidden="true" focusable="false">
      <defs><linearGradient id={id} x1="18" y1="68" x2="66" y2="18" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#8ee6bd"/><stop offset="22%" stopColor="#8bd7f0"/><stop offset="48%" stopColor="#cdbdff"/><stop offset="72%" stopColor="#f5d982"/><stop offset="100%" stopColor="#8fe3cf"/>
      </linearGradient></defs>
      <g className="description-brand-assembly" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path stroke={`url(#${id})`} strokeWidth="8.6" d="M20 72C25 60 29 52 36 34C39 26 42 20 46 18C50 20 53 26 56 34C63 52 67 60 72 72"/>
        <path stroke="rgba(255,255,255,.84)" strokeWidth="4.4" d="M34 66C36 55 38 46 41 36C43 29 44 24 46 20C48 26 50 34 53 44C56 52 61 59 67 66"/>
        <path stroke={`url(#${id})`} strokeWidth="5.4" d="M28 50C33 44 39 42 46 42C53 42 59 44 64 50"/>
        <path stroke={`url(#${id})`} strokeWidth="3.1" d="M21 60C26 62 31 62 36 58M56 58C61 62 66 62 71 60"/>
        <circle cx="46" cy="18" r="3.5" fill="#f8dd89"/><circle cx="20" cy="72" r="3" fill="#aaf0ce"/><circle cx="72" cy="72" r="3" fill="#a7e3f4"/>
      </g>
    </svg>
  </>;
}
