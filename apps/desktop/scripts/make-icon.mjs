// Renders build/icon.png (1024px) for electron-builder: three overlapping account rings on a warm tile.
import sharp from 'sharp';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#E9805E"/><stop offset="1" stop-color="#B8553A"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-opacity="0.28"/></filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#s)"/>
  <g fill="none" stroke-width="58" stroke-linecap="round" opacity="0.97">
    <circle cx="420" cy="440" r="150" stroke="#FFF4EE"/>
    <circle cx="604" cy="440" r="150" stroke="#FFD9C9"/>
    <circle cx="512" cy="600" r="150" stroke="#FFFFFF"/>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(new URL('../build/icon.png', import.meta.url).pathname);
console.log('wrote build/icon.png');
