// Test of the NFL forecast lock-in and verification (scripts/nfl-verify.mjs) with fake services.
// One outdoor game in Philadelphia. The "truth" is 50°F with 12 mph wind and rain; the fake models:
//   Euro: exactly right · GFS: 4° too warm, 6 mph too windy, no rain · others: 1–2° off.
// Run: node tests/nfl.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../scripts/nfl-verify.mjs";

const H = 3600e3;
const KICK = Date.parse("2026-11-08T18:00:00Z");
const dataDir = await mkdtemp(path.join(tmpdir(), "wc-nfl-"));
await writeFile(path.join(dataDir, "nfl.json"), JSON.stringify({ week: 9, games: [
  { id: "401", date: "2026-11-08T18:00Z", short: "NYG @ PHI", home: { abbr: "PHI" }, away: { abbr: "NYG" }, venue: { name: "Lincoln Financial Field" }, status: { state: "pre" } },
  { id: "402", date: "2026-11-08T18:00Z", short: "CLE @ NO", home: { abbr: "NO" }, away: { abbr: "CLE" }, venue: { name: "Caesars Superdome" }, status: { state: "pre" } },
] }));
const OFF = { best_match: [1, 1, true], ecmwf_ifs025: [0, 0, true], gfs_seamless: [4, 6, false], icon_seamless: [-2, 2, true], gem_seamless: [2, -1, true] };
let NOW = 0;
Date.now = () => NOW;
globalThis.fetch = async (url) => {
  const u = new URL(url), j = d => new Response(JSON.stringify(d), { status: 200 });
  if (u.host === "api.open-meteo.com") {
    const models = u.searchParams.get("models").split(","), start = Math.floor(NOW / H) * H - 72 * H;
    const time = Array.from({ length: 24 * 13 }, (_, i) => (start + i * H) / 1000), hourly = { time };
    for (const m of models) {
      const [dt, dw, wet] = OFF[m];
      const s = (n, f) => hourly[`${n}_${m}`] = time.map(f);
      s("temperature_2m", () => 50 + dt); s("apparent_temperature", () => 45 + dt); s("wind_speed_10m", () => 12 + dw); s("wind_gusts_10m", () => 22 + dw);
      s("wind_direction_10m", () => 270); s("precipitation", () => wet ? 0.05 : 0); s("precipitation_probability", () => wet ? 80 : 10);
      s("snowfall", () => 0); s("weather_code", () => wet ? 61 : 2); s("relative_humidity_2m", () => 80); s("visibility", () => 20000);
    }
    return j({ timezone: "America/New_York", hourly });
  }
  if (u.host === "api.weather.gov") {
    if (u.pathname.startsWith("/points/")) return j({ properties: { observationStations: "https://api.weather.gov/g/st" } });
    if (u.pathname === "/g/st") return j({ features: [{ properties: { stationIdentifier: "KPHL", name: "Philadelphia International Airport" }, geometry: { coordinates: [-75.231, 39.873] } }] });
    if (u.pathname.endsWith("/observations")) {
      const s = Date.parse(u.searchParams.get("start")), e = Date.parse(u.searchParams.get("end")), f = [];
      for (let t = Math.floor(s / H) * H + 54 * 60e3; t < e; t += H) f.push({ properties: { timestamp: new Date(t).toISOString(), temperature: { value: (50 - 32) * 5 / 9 }, windSpeed: { value: 12 * 1.609 }, windGust: { value: 22 * 1.609 }, precipitationLastHour: { value: 0.05 * 25.4 }, textDescription: "Light Rain" } });
      return j({ features: f.reverse() });
    }
  }
  return new Response("nope", { status: 404 });
};

const logs = [];
for (const at of [KICK - 47.5 * H, KICK - 23.8 * H, KICK - 2.9 * H, KICK - 2 * H, KICK + 7 * H, KICK + 7.5 * H]) { NOW = at; await run({ dataDir, now: NOW, log: m => logs.push(m) }); }
if (process.env.VERBOSE) console.log(logs.join("\n"));

let n = 0;
const check = (name, fn) => { fn(); n++; console.log("  ✓ " + name); };
const rec = JSON.parse(await readFile(path.join(dataDir, "nfl", "games", "401.json"), "utf8"));
const scores = JSON.parse(await readFile(path.join(dataDir, "nfl", "scores.json"), "utf8"));
check("forecasts locked at 2 days, 1 day and 3 hours before kickoff (once each), all 5 models", () => {
  assert.deepEqual(Object.keys(rec.leads).sort(), ["24h", "3h", "48h"]);
  for (const L of Object.values(rec.leads)) assert.equal(Object.keys(L.models).length, 5);
  assert.equal(logs.filter(l => l.startsWith("locked")).length, 3);
});
check("dome games are not tracked", () => { assert.equal(existsSync(path.join(dataDir, "nfl", "games", "402.json")), false); });
check("verified once against the nearest station", () => {
  assert.equal(scores.games.length, 1);
  assert.equal(scores.games[0].obs.station, "KPHL");
  assert.equal(scores.games[0].obs.rained, true);
  assert.equal(logs.filter(l => l.startsWith("verified")).length, 1);
});
check("scores match the planted errors (Euro best, GFS worst)", () => {
  const s = scores.games[0].leads["3h"];
  assert.equal(s.ecmwf_ifs025.tempMae, 0); assert.equal(s.ecmwf_ifs025.windMae, 0); assert.equal(s.ecmwf_ifs025.rain, "hit");
  assert.equal(s.gfs_seamless.tempMae, 4); assert.equal(s.gfs_seamless.windMae, 6); assert.equal(s.gfs_seamless.rain, "miss");
  const ranked = Object.entries(s).sort((a, b) => b[1].score - a[1].score).map(([m]) => m);
  assert.equal(ranked[0], "ecmwf_ifs025"); assert.equal(ranked.at(-1), "gfs_seamless");
});
console.log(`\nAll ${n} NFL checks passed.`);
