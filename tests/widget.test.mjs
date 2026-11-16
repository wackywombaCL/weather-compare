// Test of the phone-widget feed (scripts/widget.mjs) with fake sources.
// Run: node tests/widget.test.mjs
import assert from "node:assert/strict";
import { bestFor, flatten } from "../scripts/widget.mjs";
import { PRESETS, dayKey } from "../src/sources.js";

const H = 3600e3, NOW = Date.parse("2026-11-08T16:45:00Z"), loc = PRESETS.vallejo;
const fake = (dt, cat) => {
  const t0 = Math.floor(NOW / H) * H - 6 * H, hourly = [], daily = {};
  for (let i = 0; i < 24 * 7; i++) hourly.push({ t: t0 + i * H, temp: 60 + dt, pop: 10, wind: 5, cat });
  for (let i = 0; i < 7; i++) daily[dayKey(NOW + i * 24 * H, loc.tz)] = { hi: 70 + dt, lo: 50 + dt, pop: 10, cat };
  return { current: { temp: 56 + dt, cat }, hourly, daily };
};
const results = { nws: fake(0, "cloudy"), metno: fake(2, "cloudy"), m_gfs: fake(-2, "clear") };
// History: NWS nails the temps, GFS is 4° off.
const days = [];
for (let d = 1; d <= 5; d++) days.push({ date: `2026-11-0${d}`, loc: "vallejo", lead: 0, src: {
  nws: { ok: true, hiErr: 0, loErr: 0, mae: 0.5, brier: 0.05, windMae: 2 },
  metno: { ok: true, hiErr: 2, loErr: 2, mae: 2, brier: 0.05, windMae: 2 },
  m_gfs: { ok: true, hiErr: 4, loErr: 4, mae: 4, brier: 0.05, windMae: 2 } } });
let n = 0;
const check = (name, fn) => { fn(); n++; console.log("  ✓ " + name); };
const b = bestFor(results, days, loc, NOW), o = flatten("v", b, loc, NOW);
check("weighted toward the most accurate source", () => { assert.ok(b.weighted); assert.ok(Math.abs(b.now - 56) < 0.6, b.now); assert.ok(Math.abs(b.days[0].hi - 70) < 0.6); });
check("widget fields are filled and formatted", () => {
  assert.equal(o.v_loc, "Vallejo"); assert.equal(o.v_now, "56°"); assert.equal(o.v_cond, "Cloudy"); assert.equal(o.v_hilo, "70° · 50°");
  assert.equal(o.v_h0_l, "Now"); assert.equal(o.v_h1_l, "9am"); assert.ok(o.v_h4_t.endsWith("°"));
  assert.equal(o.v_d1_n, "Monday"); assert.equal(o.v_d5_n, "Friday"); assert.equal(o.v_d1_t, "70°  50°"); assert.equal(o.v_d1_i, "☁️");
  assert.match(o.v_upd, /^Updated 8:45am$/);
});
check("without history it falls back to a plain average", () => { const p = bestFor(results, null, loc, NOW); assert.equal(p.weighted, false); assert.equal(Math.round(p.now), 56); });
console.log(`\nAll ${n} widget checks passed.`);

// Bias correction and the "right now" nudge (src/best.js).
import { computeBias, biasFor, bestHours, nudge, leadOf, weightsBy } from "../src/best.js";
{
  // GFS has run 4° warm at every hour and on highs/lows for 5 days; NWS has been spot on.
  const win = d => Date.parse(`2026-11-0${d}T14:00:00Z`);   // 6am PST
  const scored = [1, 2, 3, 4, 5].map(d => ({ date: `2026-11-0${d}`, loc: "vallejo", lead: 0, windowStart: win(d), obs: { hours: Array(24).fill(60) },
    src: { nws: { ok: true, hiErr: 0, loErr: 0, mae: 0.2, brier: 0.05 }, m_gfs: { ok: true, hiErr: 4, loErr: 4, mae: 4, brier: 0.05 }, best: { ok: true, hiErr: 9, loErr: 9, mae: 9 } } }));
  const table = computeBias(scored, (d, id) => Array(24).fill(id === "m_gfs" ? 64 : 60));
  const B = biasFor({ table }, "vallejo");
  const t = NOW + 2 * H;
  assert.ok(!("best" in table.vallejo[0]), "blends are never corrected or used");
  assert.ok(Math.abs(B.hour("m_gfs", 0, t, loc.tz) - 4 * 5 / 6) < 0.11, "bias is the average miss, pulled slightly toward zero");
  assert.equal(B.hour("nws", 0, t, loc.tz), 0); assert.ok(Math.abs(B.hi("m_gfs", 0) - 3.3) < 0.11); assert.equal(B.hi("nope", 2), 0);
  assert.equal(leadOf(NOW, NOW, loc.tz), 0); assert.equal(leadOf(NOW + 30 * H, NOW, loc.tz), 1); assert.equal(leadOf(NOW + 200 * H, NOW, loc.tz), 2);
  // Blend with equal weights: the warm source is pulled back before averaging.
  const maps = { nws: new Map([[t, { t, temp: 60, pop: 0 }]]), m_gfs: new Map([[t, { t, temp: 64, pop: 0 }]]) };
  const eq = () => null;
  assert.equal(bestHours(maps, [t], { W: eq, bias: null, tz: loc.tz, now: NOW })[0].temp, 62);
  assert.ok(Math.abs(bestHours(maps, [t], { W: eq, bias: B, tz: loc.tz, now: NOW })[0].temp - 60.33) < 0.06);
  // Nudge: stations read 3° above the blend now → full shift now, fading to ~37% three hours on, ~0 a day on.
  const rows = Array.from({ length: 30 }, (_, k) => ({ t: h0(NOW) + k * H, temp: 50 }));
  const nd = nudge(rows, { temp: 53, at: h0(NOW) + 0.5 * H });
  assert.equal(nd.delta, 3); assert.equal(nd.rows[0].temp, 53); assert.ok(Math.abs(nd.rows[1].temp - (50 + 3 * Math.exp(-0.5 / 3))) < 1e-9);
  assert.ok(Math.abs(nd.rows[3].temp - 50 - 3 * Math.exp(-2.5 / 3)) < 1e-9); assert.ok(nd.rows[29].temp - 50 < 0.01);
  assert.equal(nudge(rows, { temp: 90, at: h0(NOW) }).delta, 8, "never more than 8°");
  assert.equal(nudge(rows, null).delta, null); assert.equal(nudge(rows, { temp: 53, at: h0(NOW) - 5 * H }).delta, null, "stale reading ignored");
  // Widget: a station reading becomes "now" and lifts the first hours.
  const w = bestFor(results, days, loc, NOW, { obs: { temp: 63, at: NOW - 10 * 60e3 } });
  assert.equal(w.now, 63); assert.ok(w.measured && w.nudge > 0); assert.ok(w.hours[1].temp > b.hours[1].temp + 1);
  console.log("  ✓ bias correction, blending and the right-now nudge");
}
function h0(t) { return Math.floor(t / H) * H; }
