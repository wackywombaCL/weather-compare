// Drawn weather icons (instead of emoji, which look different on every phone). One hidden
// sprite is added to the page; wicon() returns a small <svg> that points at one symbol in it.
// Colours come from CSS variables (--wi-*, see styles.css) so they suit light, dark and the
// coloured Best card. The phone widget still uses emoji (src/sources.js icon()): it shows text.
const CLOUD = "M9.6 24.5a6.1 6.1 0 0 1-1-12.12 7.6 7.6 0 0 1 14.6-.9 5.6 5.6 0 0 1-.9 13.02z";
const cloud = (fill = "var(--wi-cloud)", tf = "") => `<path d="${CLOUD}" fill="${fill}"${tf ? ` transform="${tf}"` : ""}/>`;
const rays = (cx, cy, r1, r2, w) => Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4, c = Math.cos(a), s = Math.sin(a); return `M${(cx + c * r1).toFixed(1)} ${(cy + s * r1).toFixed(1)}L${(cx + c * r2).toFixed(1)} ${(cy + s * r2).toFixed(1)}`; }).join("");
const sun = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--wi-sun)"/><path d="${rays(cx, cy, r + 2.4, r + 5, 0)}" stroke="var(--wi-sun)" stroke-width="2.3" stroke-linecap="round" fill="none"/>`;
const moon = (tf = "") => `<path d="M20.6 4.6a11.2 11.2 0 1 0 7 19.3A9.6 9.6 0 0 1 20.6 4.6z" fill="var(--wi-moon)"${tf ? ` transform="${tf}"` : ""}/>`;
const UP = "translate(0 -4.5)";                       // cloud moved up to leave room for rain below
const drops = xs => `<path d="${xs.map(x => `M${x} 23.2l-1.9 5`).join("")}" stroke="var(--wi-rain)" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
const dots = (xs, y, fill) => xs.map((x, i) => `<circle cx="${x}" cy="${y + (i % 2) * 2.6}" r="1.7" fill="${fill}"/>`).join("");
const lines = (ys, x1, x2, stroke) => `<path d="${ys.map((y, i) => `M${x1 + (i % 2) * 2.5} ${y}H${x2 - ((i + 1) % 2) * 2.5}`).join("")}" stroke="${stroke}" stroke-width="2.3" stroke-linecap="round" fill="none"/>`;

const SYMBOLS = {
  "clear-d": sun(16, 16, 6.3),
  "clear-n": moon(),
  "partly-d": `<g transform="translate(-3.2 -4.2) scale(.78)">${sun(16, 16, 6.3)}</g>${cloud("var(--wi-cloud)", "translate(4.4 5) scale(.86)")}`,
  "partly-n": `${moon("translate(-1.5 -1.5) scale(.66)")}${cloud("var(--wi-cloud)", "translate(4.4 5) scale(.86)")}`,
  cloudy: `${cloud("var(--wi-cloud2)", "translate(7.6 -1.4) scale(.74)")}${cloud("var(--wi-cloud)", "translate(-.6 3.2) scale(.92)")}`,
  fog: `${cloud("var(--wi-cloud)", "translate(1.4 -2.6) scale(.9)")}${lines([23.4, 27.6], 6, 26, "var(--wi-cloud2)")}`,
  haze: `<g transform="translate(0 -3.5) scale(.82) translate(3.5 0)">${sun(16, 16, 6.3)}</g>${lines([21.5, 25.4, 29.3], 5, 27, "var(--wi-cloud2)")}`,
  "drizzle-d": `<g transform="translate(-3.2 -5.2) scale(.72)">${sun(16, 16, 6.3)}</g>${cloud("var(--wi-cloud)", `translate(3.6 1.6) scale(.86)`)}${dots([12.5, 17.5, 22.5], 25.4, "var(--wi-rain)")}`,
  "drizzle-n": `${cloud("var(--wi-cloud)", UP)}${dots([11, 16, 21], 24.4, "var(--wi-rain)")}`,
  rain: `${cloud("var(--wi-cloud)", UP)}${drops([12, 17.2, 22.4])}`,
  sleet: `${cloud("var(--wi-cloud)", UP)}${drops([12, 22.4])}${dots([16.2], 25.4, "var(--wi-snow)")}`,
  snow: `${cloud("var(--wi-cloud)", UP)}${dots([10.6, 16, 21.4], 24.2, "var(--wi-snow)")}${dots([13.3, 18.7], 28.2, "var(--wi-snow)")}`,
  thunder: `${cloud("var(--wi-cloud2)", UP)}<path d="M17.6 18.6l-4.6 6h3.3l-1.4 4.8 5.2-6.6h-3.4z" fill="var(--wi-bolt)" stroke="var(--wi-bolt)" stroke-width=".8" stroke-linejoin="round"/>${drops([10.2, 23.6])}`,
};
const KEY = { clear: ["clear-d", "clear-n"], partly: ["partly-d", "partly-n"], cloudy: ["cloudy", "cloudy"], fog: ["fog", "fog"], haze: ["haze", "fog"],
  drizzle: ["drizzle-d", "drizzle-n"], rain: ["rain", "rain"], sleet: ["sleet", "sleet"], snow: ["snow", "snow"], thunder: ["thunder", "thunder"] };

export const spriteSvg = () => `<svg id="wi-sprite" xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(SYMBOLS).map(([k, v]) => `<symbol id="wi-${k}" viewBox="0 0 32 32">${v}</symbol>`).join("")}</svg>`;
function ensureSprite() {
  if (typeof document === "undefined" || document.getElementById("wi-sprite")) return;
  (document.body || document.documentElement).insertAdjacentHTML("afterbegin", spriteSvg());
}
// The icon for a condition category ("clear", "rain", …) by day or night, as an <svg> string.
export function wicon(cat, night) {
  ensureSprite();
  return `<svg class="wi" viewBox="0 0 32 32" aria-hidden="true"><use href="#wi-${(KEY[cat] || KEY.cloudy)[night ? 1 : 0]}"/></svg>`;
}
