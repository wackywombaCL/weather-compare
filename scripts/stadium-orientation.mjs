// One-off helper: measures which way each open-air NFL field runs, from the field outline in
// OpenStreetMap (leisure=pitch near the stadium), and prints the end-zone-to-end-zone bearing.
// Run by hand (Actions → "Stadium orientation"); the results are copied into src/stadiums.js.
import { STADIUMS } from "../src/stadiums.js";

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const s of STADIUMS.filter(x => x.roof === "open" && (!ONLY || ONLY.test(x.name)))) {
  const q = `[out:json][timeout:25];way(around:450,${s.lat},${s.lon})["leisure"="pitch"];out geom tags;`;
  let res = null, lastErr = "";
  for (let attempt = 0; attempt < 6 && !res; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "User-Agent": "weather-compare/1.0 (github.com/wackywombaCL/weather-compare)", "Content-Type": "application/x-www-form-urlencoded" } });
      const text = await r.text();
      if (!r.ok || !text.startsWith("{")) throw new Error(`HTTP ${r.status}`);
      res = JSON.parse(text);
    } catch (e) { lastErr = e.message; await sleep(4000 * (attempt + 1)); }
  }
  if (!res) { console.log(`${s.name}: query failed (${lastErr})`); continue; }
  const ways = (res.elements || []).filter(w => w.geometry?.length >= 4).map(w => {
    const lat0 = w.geometry[0].lat * Math.PI / 180;
    const pts = w.geometry.map(p => [(p.lon - s.lon) * 111320 * Math.cos(lat0), (p.lat - s.lat) * 110540]);   // metres east, north
    let area = 0; for (let i = 0; i < pts.length - 1; i++) area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    // Long axis: try every edge direction (rotating calipers) and keep the tightest bounding rectangle.
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      const c = Math.cos(a), sn = Math.sin(a);
      const u = pts.map(([x, y]) => x * c + y * sn), v = pts.map(([x, y]) => -x * sn + y * c);
      const L = Math.max(...u) - Math.min(...u), Wd = Math.max(...v) - Math.min(...v);
      if (!best || L * Wd < best.area) best = { area: L * Wd, a: L >= Wd ? a : a + Math.PI / 2, len: Math.max(L, Wd), wid: Math.min(L, Wd) };
    }
    const bearing = ((90 - best.a * 180 / Math.PI) % 180 + 180) % 180;   // compass bearing of the long axis, 0–180
    const sport = w.tags?.sport || "";
    const dist = Math.hypot(...pts.reduce((m, p) => [m[0] + p[0] / pts.length, m[1] + p[1] / pts.length], [0, 0]));
    return { sport, area: Math.abs(area) / 2, bearing: Math.round(bearing), len: Math.round(best.len), wid: Math.round(best.wid), dist: Math.round(dist) };
  });
  // Prefer an American-football pitch about the size of a field (~110 x 49 m), closest to the stadium.
  const fieldish = w => w.len > 90 && w.len < 150 && w.wid > 40 && w.wid < 90;
  const pick = ways.filter(w => /american_football/.test(w.sport) && fieldish(w)).sort((a, b) => a.dist - b.dist)[0]
    || ways.filter(fieldish).sort((a, b) => a.dist - b.dist)[0];
  console.log(`${s.name.padEnd(28)} ${pick ? `axis ${String(pick.bearing).padStart(3)}° (${pick.len}x${pick.wid} m, ${pick.sport || "no sport tag"}, ${pick.dist} m from pin)` : "no field found"}  [${ways.length} pitches]`);
  await sleep(1500);
}
