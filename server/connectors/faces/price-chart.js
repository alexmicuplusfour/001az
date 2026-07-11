// Shared connector face producer — renders a price-history series to a card
// face (SVG → webp), with the ticker + name baked in so it stays legible at
// card size and can double as visual input for the tagger.
import sharp from "sharp";

// White face; the line spans the full width (no lateral padding), small vertical
// insets so peaks/troughs and the ticker overlay aren't clipped.
const W = 600, H = 360, TOP = 26, BOT = 16;
const TARGET_POINTS = 150;

// Stride down to at most n points, keeping the first and last.
function downsample(series, n) {
  if (series.length <= n) return series;
  const step = (series.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(series[Math.round(i * step)]);
  return out;
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

export async function renderChart(series, { symbol = "", name = "", period = "" } = {}) {
  const pts = downsample((series || []).filter((p) => Number.isFinite(p.price)), TARGET_POINTS);
  const n = pts.length;
  const prices = pts.map((p) => p.price);
  const min = n ? Math.min(...prices) : 0;
  const max = n ? Math.max(...prices) : 1;
  const span = max - min || 1;
  const x = (i) => (n <= 1 ? 0 : (i * W) / (n - 1)); // full width, no lateral padding
  const y = (v) => TOP + (1 - (v - min) / span) * (H - TOP - BOT);
  const up = n < 2 || prices[n - 1] >= prices[0];
  const stroke = up ? "#16a34a" : "#dc2626"; // deeper for contrast on white
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const area = n ? `${line} L${x(n - 1).toFixed(1)},${H} L0,${H} Z` : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${stroke}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${stroke}" stop-opacity="0"/>
    </linearGradient></defs>
    ${area ? `<path d="${area}" fill="url(#g)"/>` : ""}
    ${line ? `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
    <text x="14" y="30" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="700" fill="#111111">${esc(symbol)}</text>
    <text x="15" y="47" font-family="DejaVu Sans, sans-serif" font-size="11" fill="#777777">${esc(name)}</text>
    <text x="${W - 10}" y="${H - 8}" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="10" fill="#bbbbbb">${esc(period)}</text>
  </svg>`;
  const webp = await sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
  return { webp, w: W, h: H };
}
