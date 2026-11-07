// Test of the daily stadium tracking (scripts/stadiums.mjs) and the best blend, with fake services.
// Two stadiums, run every hour for 7 days. The "truth" is 50°F, 12 mph wind and rain every hour;
// the fake models: Euro exactly right · GFS 4° too warm, 6 mph too windy, dry · ICON 2° too cold
// · GEM 2° too warm · Open-Meteo blend 1° warm, 1 mph windy.
// Run: node tests/stadiums.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../scripts/stadiums.mjs";
import { STADIUMS } from "../src/stadiums.js";
import { weightsFor, addBest } from "../src/stadiumskill.js";
import { gameWeather } from "../src/nflwx.js";

const H = 3600e3;
const START = Date.parse("2026-11-01T08:00:00Z");
const dataDir = process.env.STADIUM_TEST_DIR || await mkdtemp(path.join(tmpdir(), "wc-st-"));
const stadiums = STADIUMS.filter(s => /Lincoln Financial|Lumen/.test(s.name));
const OFF = { best_match: [1, 1, true], ecmwf_ifs025: [0, 0, true], gfs_seamless: [4, 6, false], icon_seamless: [-2, 0, true], gem_seamless: [2, 0, true] };
let NOW = START, omCalls = 0;
Date.now = () => NOW;
globalThis.fetch = async (url) => {
  const u = new URL(url), j = d => new Response(JSON.stringify(d), { status: 200 });
  if (u.host === "api.open-meteo.com") {
    omCalls++;
    const models = u.searchParams.get("models").split(","), start = Math.floor(NOW / H) * H - 72 * H;
    const time = Array.from({ length: 24 * 13 }, (_, i) => (start + i * H) / 1000), hourly = { time };
    for (const m of models) {
      const [dt, dw, wet] = OFF[m];
      const s = (n, f) => hourly[`${n}_${m}`] = time.map(f);
      s("temperature_2m", () => 50 + dt); s("apparent_temperature", () => 45 + dt); s("wind_speed_10m", () => 12 + dw); s("wind_gusts_10m", () => 22 + dw);
      s("wind_direction_10m", () => 270); s("precipitation", () => wet ? 0.05 : 0); s("precipitation_probability", () => wet ? 80 : 10);
      s("snowfall", () => 0); s("weather_code", () => wet ? 61 : 2); s("relative_humidity_2m", () => 80); s("visibility", () => 20000);
    }
    return j({ timezone: +u.searchParams.get("longitude") < -100 ? "America/Los_Angeles" : "America/New_York", hourly });
  }
  if (u.host === "api.weather.gov") {
    if (u.pathname.startsWith("/points/")) return j({ properties: { observationStations: "https://api.weather.gov/g/st/" + (u.pathname.includes("-122") ? "KBFI" : "KPHL") } });
    if (u.pathname.startsWith("/g/st/")) { const id = u.pathname.split("/").pop(); return j({ features: [{ properties: { stationIdentifier: id, name: id }, geometry: { coordinates: id === "KPHL" ? [-75.231, 39.873] : [-122.30, 47.53] } }] }); }
    if (u.pathname.endsWith("/observations")) {
      const s = Date.parse(u.searchParams.get("start")), e = Math.min(Date.parse(u.searchParams.get("end")), NOW), f = [];
      for (let t = Math.floor(s / H) * H + 54 * 60e3; t < e; t += H) f.push({ properties: { timestamp: new Date(t).toISOString(), temperature: { value: (50 - 32) * 5 / 9 }, windSpeed: { value: 12 * 1.609 }, windGust: { value: 22 * 1.609 }, precipitationLastHour: { value: 0.05 * 25.4 }, textDescription: "Light Rain" } });
      return j({ features: f.reverse() });
    }
  }
  return new Response("nope", { status: 404 });
};

const logs = [];
for (; NOW < START + 7 * 24 * H; NOW += H) await run({ dataDir, now: NOW, stadiums, log: m => logs.push(m) });
if (process.env.VERBOSE) console.log(logs.join("\n"));

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log("  ✓ " + name); };
const rd = async f => JSON.parse(await readFile(path.join(dataDir, "stadiums", f), "utf8"));
const scores = await rd("scores.json"), skill = await rd("skill.json"), fc = await rd("forecast.json");

await check("each stadium locked once a day (7 days × 2 stadiums), without fetching every hour", () => {
  assert.equal(logs.filter(l => l.startsWith("locked")).length, 14);
  assert.ok(omCalls < 7 * 24, `Open-Meteo called ${omCalls} times`);
});
await check("days verified once each against each stadium's nearest station", () => {
  const ids = scores.days.map(d => d.st + d.date);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(scores.days.length >= 10, `${scores.days.length} days`);
  assert.deepEqual([...new Set(scores.days.map(d => d.station))].sort(), ["KBFI", "KPHL"]);
  assert.ok(scores.days.every(d => d.obs.rained && d.obs.hi === 50));
});
await check("leads 0–3 days are all scored, and planted errors come out right", () => {
  const last = scores.days.at(-1);
  assert.deepEqual(Object.keys(last.leads).sort(), ["0", "1", "2", "3"]);
  const s = last.leads["1"];
  assert.equal(s.ecmwf_ifs025.tempMae, 0); assert.equal(s.gfs_seamless.tempMae, 4); assert.equal(s.gfs_seamless.rain, "miss");
  assert.equal(s.gem_seamless.tempBias, 2); assert.equal(s.icon_seamless.tempBias, -2);
});
await check("weights favor the most accurate model for each element; GFS gets no say on rain", () => {
  const W = weightsFor(skill, "lincoln-financial-field", 1);
  assert.equal(W.from, "stadium");
  assert.equal(W.lead.temp, "ecmwf_ifs025");
  assert.ok(W.temp.ecmwf_ifs025 > 0.4, JSON.stringify(W.temp));
  assert.ok(!W.temp.gfs_seamless && !W.wind.gfs_seamless && !W.rain.gfs_seamless, JSON.stringify(W));
  assert.equal(W.bias.gem_seamless, 2);
});
await check("the best blend is locked and verified once there's history, and beats every single model but Euro", () => {
  const withBest = scores.days.filter(d => d.leads["1"]?.best);
  assert.ok(withBest.length >= 2, "best blend scored");
  const b = withBest.at(-1).leads["1"];
  assert.ok(b.best.tempMae <= 0.2, "bias-corrected blend temp error " + b.best.tempMae);
  for (const m of ["gfs_seamless", "icon_seamless", "gem_seamless", "best_match"]) assert.ok(b.best.score >= b[m].score, m);
  assert.ok(skill.recent.all["1"].best.n >= 2);
});
await check("NFL game windows use the best blend when there is one", async () => {
  const wx = { tz: "America/New_York", models: {} };
  const t0 = Math.floor(NOW / H) * H;
  for (const [m, [dt]] of Object.entries(OFF)) wx.models[m] = Array.from({ length: 72 }, (_, i) => [t0 + i * H, { temp: 50 + dt, feels: 45 + dt, wind: 12, gust: 20, wdir: 270, qpf: 0.05, pop: 80, snow: 0, code: 61 }]);
  assert.ok(addBest(wx, skill, "lincoln-financial-field", NOW));
  const gw = gameWeather(wx, t0 + 30 * H);
  assert.ok(Math.abs(gw.win[1].temp - 50) < 0.3, "game temp " + gw.win[1].temp);
  assert.ok("best" in gw.byModel);
});
await check("daily forecast file covers every stadium with the blend", () => {
  assert.deepEqual(Object.keys(fc.stadiums).sort(), ["lincoln-financial-field", "lumen-field"]);
  const s = fc.stadiums["lumen-field"];
  assert.ok(s.blend && s.days.length >= 5);
  assert.ok(Math.abs(s.days[1].hi - 50) <= 1, "hi " + s.days[1].hi);
});
await check("finished lock files are cleaned up", async () => {
  const left = await readdir(path.join(dataDir, "stadiums", "locks"));
  assert.ok(left.length <= 5, left.join(","));
});
console.log(`\nAll ${n} stadium checks passed.`);
