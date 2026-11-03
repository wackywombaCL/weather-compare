// End-to-end test of the daily job (scripts/daily.mjs) against simulated weather services.
//
// Six simulated mornings (Oct 29 – Nov 3, 2026, crossing the Nov 1 daylight-saving change). The
// fake "truth" has rain on two afternoons; each fake source has planted errors:
//   NWS: 1° too cold, rain starts 1 hour early.   Models (via Open-Meteo): 1.5° too warm, rain 2 hours late.
//   Yr: 0.3° too warm, misses the first rain, false alarm on the dry day after, on time for the second rain.
// The test checks the scoring recovers exactly those numbers. Run: node tests/simulate.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, TZ } from "../scripts/daily.mjs";
import { localHourStart, dayKey } from "../src/sources.js";
const H = 3600e3;
const D0 = "2026-10-29";
const dk = i => dayKey(localHourStart(D0, 12, TZ) + i * 24 * H, TZ);
const at = (i, h) => localHourStart(dk(i), h, TZ);
// truth: diurnal cycle, peak ~3pm
const truth = t => { const h = (t - at(0, 0)) / H; return 57 + 11 * Math.sin((h - 9) / 24 * 2 * Math.PI) + 2 * Math.sin(h / 50); };
const RAIN = [[at(1, 15), at(1, 20)], [at(3, 9), at(3, 13)]];
const isRain = (t, shift = 0) => RAIN.some(([a, b]) => t >= a + shift && t < b + shift);
const SRC = {
  nws: { bias: -1, shift: -1 * H }, om: { bias: 1.5, shift: 2 * H },
  met: { bias: 0.3, shift: 0, missFirst: true, falseDay: 2 },
};
const metRain = t => (isRain(t) && !(t >= RAIN[0][0] && t < RAIN[0][1])) || (t >= at(2, 12) && t < at(2, 14));
let SIMNOW;
Date.now = () => SIMNOW;
const iso = t => new Date(t).toISOString();
globalThis.fetch = async (url) => {
  const u = new URL(url), now = SIMNOW, j = d => new Response(JSON.stringify(d), { status: 200 });
  const fl = Math.floor(now / H) * H;
  if (u.host === "api.weather.gov") {
    const P = u.pathname;
    if (P.startsWith("/points/")) return j({ properties: { forecast: "https://api.weather.gov/g/fc", forecastHourly: "https://api.weather.gov/g/fh", observationStations: "https://api.weather.gov/g/st", timeZone: TZ, relativeLocation: { properties: { city: "Vallejo", state: "CA" } } } });
    if (P === "/g/fh") return j({ properties: { updateTime: iso(now), periods: Array.from({ length: 156 }, (_, i) => { const t = fl + i * H; const r = isRain(t, SRC.nws.shift); return { startTime: iso(t), isDaytime: true, temperature: Math.round(truth(t) + SRC.nws.bias), temperatureUnit: "F", probabilityOfPrecipitation: { value: r ? 80 : 10 }, windSpeed: "5 mph", windDirection: "W", shortForecast: r ? "Rain" : "Partly Sunny" }; }) } });
    if (P === "/g/fc") return j({ properties: { periods: [] } });
    if (P === "/g/st") return j({ features: [{ id: "https://api.weather.gov/stations/KAPC", properties: { stationIdentifier: "KAPC", name: "Napa County Airport" } }, { id: "https://api.weather.gov/stations/KSUU", properties: { stationIdentifier: "KSUU", name: "Travis AFB" } }] });
    if (P.endsWith("/observations/latest")) return j({ properties: { timestamp: iso(now - 600e3), temperature: { value: (truth(now) - 32) * 5 / 9 }, textDescription: "Clear" } });
    if (P.endsWith("/observations")) {
      const s = Date.parse(u.searchParams.get("start")), e = Math.min(Date.parse(u.searchParams.get("end")), now);
      const feats = [];
      for (let t = Math.floor(s / H) * H + 53 * 60e3; t < e; t += H) {
        const r = isRain(t) || isRain(t - 53 * 60e3 + H - 1);
        const rr = isRain(t);
        feats.push({ properties: { timestamp: iso(t), temperature: { value: (truth(t) + (Math.sin(t / 7e6) * 0.8) - 32) * 5 / 9, qualityControl: "V" }, precipitationLastHour: { value: rr ? 1.2 : 0 }, windSpeed: { value: 12 + 6 * Math.sin(t / 2e7) }, relativeHumidity: { value: 72 + 8 * Math.sin(t / 3e7) }, textDescription: rr ? "Light Rain" : "Clear", presentWeather: rr ? [{ weather: "rain" }] : [] } });
      }
      return j({ features: feats.reverse() });
    }
  }
  if (u.host === "api.open-meteo.com") {
    const m0 = localHourStart(dayKey(now, TZ), 0, TZ);
    const hours = Array.from({ length: 168 }, (_, i) => m0 + i * H);
    return j({ timezone: TZ, current: { time: now / 1000, temperature_2m: truth(now), relative_humidity_2m: 70, apparent_temperature: truth(now), is_day: 1, weather_code: 1, wind_speed_10m: 5, wind_direction_10m: 200 },
      hourly: { time: hours.map(t => t / 1000), temperature_2m: hours.map(t => truth(t) + SRC.om.bias), precipitation_probability: hours.map(t => isRain(t, SRC.om.shift) ? 70 : 5), weather_code: hours.map(t => isRain(t, SRC.om.shift) ? 63 : 2), precipitation: hours.map(t => isRain(t, SRC.om.shift) ? 0.05 : 0), wind_speed_10m: hours.map(() => 5), is_day: hours.map(() => 1) },
      daily: { time: [0, 1, 2, 3, 4, 5, 6].map(i => (m0 + i * 24 * H) / 1000), weather_code: Array(7).fill(2), temperature_2m_max: Array(7).fill(68), temperature_2m_min: Array(7).fill(47), precipitation_probability_max: Array(7).fill(10) } });
  }
  if (u.host === "api.met.no") {
    const ts = Array.from({ length: 60 }, (_, i) => { const t = fl + i * H; return { time: iso(t).replace(".000", ""), data: { instant: { details: { air_temperature: (truth(t) + SRC.met.bias - 32) * 5 / 9, wind_speed: 2, relative_humidity: 70 } }, next_1_hours: { summary: { symbol_code: metRain(t) ? "rain" : "partlycloudy_day" }, details: { precipitation_amount: 0 } } } }; });
    return j({ properties: { meta: { updated_at: iso(now) }, timeseries: ts } });
  }
  return new Response("nope", { status: 404 });
};
const logs = [];
const dataDir = await mkdtemp(path.join(tmpdir(), "wc-sim-"));
for (let i = 0; i <= 5; i++) {
  for (const hr of [5, 6, 7]) {                 // the scheduled runs around 6am
    SIMNOW = at(i, hr) + 7 * 60e3;
    await run({ dataDir, now: SIMNOW, log: m => logs.push(m) });
  }
}
if (process.env.VERBOSE) console.log(logs.join("\n"));

// ---------- Checks ----------
const scores = JSON.parse(await readFile(path.join(dataDir, "scores.json"), "utf8"));
const get = (date, loc, lead = 0) => scores.days.find(d => d.date === date && d.loc === loc && (d.lead ?? 0) === lead);
let n = 0;
const check = (name, fn) => { fn(); n++; console.log("  ✓ " + name); };

check("every finished day is scored for both cities and all three leads", () => {
  for (let i = 0; i <= 4; i++) for (const loc of ["vallejo", "napa"]) {
    assert.ok(get(dk(i), loc, 0), `lead 0 ${dk(i)} ${loc}`);
    if (i >= 1) assert.ok(get(dk(i), loc, 1), `lead 1 ${dk(i)} ${loc}`);
    if (i >= 2) assert.ok(get(dk(i), loc, 2), `lead 2 ${dk(i)} ${loc}`);
  }
});
check("observed rain start is found (first rain: 3pm)", () => {
  const d = get(dk(1), "napa");
  assert.equal(d.obs.rained, true);
  assert.equal(d.obs.rainStart, at(1, 15));
  assert.ok(d.obs.precipIn > 0);
});
check("rain timing: NWS 1h early, models 2h late, Yr missed it", () => {
  const s = get(dk(1), "napa").src;
  assert.equal(s.nws.rain, "hit"); assert.equal(s.nws.timing, -1);
  assert.equal(s.m_gfs.rain, "hit"); assert.equal(s.m_gfs.timing, 2);
  assert.equal(s.metno.rain, "miss");
});
check("Yr false alarm on the dry day, and on time for the second rain", () => {
  assert.equal(get(dk(2), "napa").src.metno.rain, "false");
  const s = get(dk(3), "napa").src;
  assert.equal(s.metno.rain, "hit"); assert.equal(s.metno.timing, 0);
});
check("temperature errors match the planted biases", () => {
  for (let i = 0; i <= 4; i++) {
    const s = get(dk(i), "napa").src;
    assert.ok(Math.abs(s.nws.hiErr - -1) <= 1.3, `NWS high ${s.nws.hiErr}`);
    assert.ok(Math.abs(s.m_gfs.hiErr - 1.5) <= 1.3, `GFS high ${s.m_gfs.hiErr}`);
    assert.ok(s.metno.mae < s.m_gfs.mae, "Yr hourly temps closest");
  }
});
check("rain totals are scored against the measured rain", () => {
  const s = get(dk(1), "napa").src;
  assert.ok(typeof s.m_gfs.qpf === "number" && typeof s.m_gfs.qpfErr === "number");
});
check("wind and humidity are scored", () => {
  const s = get(dk(4), "napa").src;
  assert.ok(typeof s.nws.windMae === "number", "wind");
  assert.ok(typeof s.metno.humMae === "number", "humidity");
});
check("average, smart average and (after 3 scored days) Best forecast are tracked", () => {
  assert.ok(get(dk(0), "napa").src.avg?.ok && get(dk(0), "napa").src.smart?.ok);
  assert.ok(!get(dk(2), "napa").src.best, "no Best before 3 scored days");
  assert.ok(get(dk(4), "napa").src.best?.ok, "Best scored on day 5");
});
check("Vallejo is scored against Napa County Airport (KAPC)", () => {
  assert.equal(get(dk(2), "vallejo").station, "KAPC");
});
check("forecasts are saved once per day", () => {
  const files = readdirSync(path.join(dataDir, "forecasts")).sort();
  assert.equal(files.length, 6);
});
console.log(`\nAll ${n} checks passed.`);
