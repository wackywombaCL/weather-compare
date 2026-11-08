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
