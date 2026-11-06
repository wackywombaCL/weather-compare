// NFL forecast verification. Runs every 5 minutes inside the lightning job.
//
// LOCK: for each upcoming outdoor game, saves every model's forecast for the 5-hour game window
//       (1 h before kickoff → 1 h after a normal finish) at three lead times: 2 days, 1 day and
//       3 hours before kickoff.            → data/nfl/games/<game id>.json
// VERIFY: about 6 hours after kickoff, pulls the hourly observations from the nearest official
//       weather station (NWS, US stadiums) and scores every locked forecast.
//                                           → data/nfl/scores.json (read by the NFL tab)
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { setRequestInit, getJSON, isNum, cToF, mean } from "../src/sources.js";
import { findStadium } from "../src/stadiums.js";
import { fetchStadiumWeather, gameWeather, H } from "../src/nflwx.js";

export const LEADS = [{ id: "48h", hours: 48 }, { id: "24h", hours: 24 }, { id: "3h", hours: 3 }];
const LOCK_WINDOW = 3 * H;          // lock any time in the 3 hours after the lead time (GitHub runs can be late)
const VERIFY_AFTER = 6 * H;         // after kickoff
const GIVE_UP_AFTER = 4 * 24 * H;   // stop trying to verify after this
const r1 = v => isNum(v) ? Math.round(v * 10) / 10 : null;
const r2 = v => isNum(v) ? Math.round(v * 100) / 100 : null;
const clamp = v => Math.max(0, Math.min(100, v));

async function readJSON(f, d) { try { return JSON.parse(await readFile(f, "utf8")); } catch { return d; } }
async function writeJSON(f, data) { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(data) + "\n"); }

// Compact copy of one model's 5 game hours.
const pack = hs => {
  const k = key => hs.map(h => isNum(h?.[key]) ? (key === "qpf" || key === "snow" ? r2(h[key]) : r1(h[key])) : null);
  return { temp: k("temp"), wind: k("wind"), gust: k("gust"), wdir: k("wdir"), qpf: k("qpf"), snow: k("snow"), pop: k("pop"), code: hs.map(h => h?.code ?? null) };
};

// ---------- Observations ----------
const wetText = s => /rain|drizzle|shower|thunder|snow|sleet/i.test(s || "");
async function observe(st, slots) {
  if (!isNum(st.lat) || st.lat < 18 || st.lat > 50 || st.lon > -60) return null;   // NWS covers US stadiums only
  const pt = await getJSON(`https://api.weather.gov/points/${st.lat.toFixed(4)},${st.lon.toFixed(4)}`);
  const feats = (await getJSON(pt.properties.observationStations)).features || [];
  const start = slots[0] - 30 * 60e3, end = slots[4] + H;
  for (const f of feats.slice(0, 4)) {
    const id = f.properties?.stationIdentifier;
    try {
      const j = await getJSON(`https://api.weather.gov/stations/${id}/observations?start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`, { tries: 2 });
      const obs = (j.features || []).map(x => x.properties).map(p => ({
        t: Date.parse(p.timestamp), temp: isNum(p.temperature?.value) ? cToF(p.temperature.value) : null,
        wind: isNum(p.windSpeed?.value) ? p.windSpeed.value / 1.609 : null, gust: isNum(p.windGust?.value) ? p.windGust.value / 1.609 : null,
        precip: isNum(p.precipitationLastHour?.value) ? p.precipitationLastHour.value / 25.4 : null, text: p.textDescription || "",
      }));
      const near = t => obs.filter(o => Math.abs(o.t - t) <= 20 * 60e3 && isNum(o.temp)).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
      const hours = slots.map(near);
      if (hours.filter(Boolean).length < 4) continue;
      const inWin = obs.filter(o => o.t >= slots[0] && o.t < end);
      // Hourly rain totals are on the routine reports at :45–:59; sum those to avoid double counting.
      const routine = inWin.filter(o => new Date(o.t).getUTCMinutes() >= 45 && isNum(o.precip));
      const gusts = inWin.map(o => o.gust).filter(isNum);
      const [lon, lat] = f.geometry?.coordinates || [];
      return {
        station: id, stationName: f.properties?.name || null,
        mi: isNum(lat) ? r1(3958.8 * 2 * Math.asin(Math.sqrt(Math.sin((lat - st.lat) * Math.PI / 360) ** 2 + Math.cos(st.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin((lon - st.lon) * Math.PI / 360) ** 2))) : null,
        temp: hours.map(h => r1(h?.temp)), wind: hours.map(h => r1(h?.wind)),
        gustMax: gusts.length ? r1(Math.max(...gusts)) : null,
        precip: routine.length ? r2(routine.reduce((s, o) => s + o.precip, 0)) : null,
        rained: inWin.some(o => (isNum(o.precip) && o.precip > 0) || wetText(o.text)),
      };
    } catch {}
  }
  return null;
}

// ---------- Scoring ----------
const fcWet = m => m.qpf.some(q => isNum(q) && q >= 0.01) || m.snow.some(s => isNum(s) && s >= 0.1) || m.code.some(c => c >= 51 && c !== null);
export function scoreModel(m, ob) {
  const d = (a, b) => a.map((x, i) => isNum(x) && isNum(b[i]) ? Math.abs(x - b[i]) : null).filter(isNum);
  const td = d(m.temp, ob.temp), wd = d(m.wind, ob.wind);
  if (td.length < 3) return null;
  const tempMae = mean(td), windMae = wd.length >= 3 ? mean(wd) : null;
  const wet = fcWet(m);
  const rain = wet && ob.rained ? "hit" : wet ? "false" : ob.rained ? "miss" : "none";
  const qpf = m.qpf.reduce((s, q) => s + (isNum(q) ? q : 0), 0);
  const gustMax = Math.max(...m.gust.filter(isNum), -1);
  // Score: 45% temperature, 35% wind, 20% rain call (same spirit as the main app's score).
  const score = 0.45 * clamp(100 - 10 * tempMae) + 0.35 * (isNum(windMae) ? clamp(100 - 8 * windMae) : 70) + 0.2 * (rain === "hit" || rain === "none" ? 100 : 0);
  return {
    score: r1(score), tempMae: r1(tempMae), windMae: r1(windMae), rain,
    qpf: r2(qpf), qpfErr: isNum(ob.precip) ? r2(qpf - ob.precip) : null,
    gustErr: isNum(ob.gustMax) && gustMax >= 0 ? r1(gustMax - ob.gustMax) : null,
  };
}

// ---------- Main ----------
export async function run({ dataDir, now = Date.now(), log = console.log } = {}) {
  const sched = await readJSON(path.join(dataDir, "nfl.json"), null);
  const gamesDir = path.join(dataDir, "nfl", "games");
  let changed = false;
  const wxCache = new Map();
  const wxFor = async st => {
    const k = `${st.lat},${st.lon}`;
    if (!wxCache.has(k)) wxCache.set(k, await fetchStadiumWeather(st.lat, st.lon).catch(e => { log(`forecast failed ${st.name}: ${e.message}`); return null; }));
    return wxCache.get(k);
  };

  // LOCK
  for (const g of sched?.games || []) {
    const st = findStadium(g.venue?.name);
    if (!st || st.roof !== "open") continue;
    const kick = Date.parse(g.date);
    const due = LEADS.filter(L => now >= kick - L.hours * H && now < Math.min(kick, kick - L.hours * H + LOCK_WINDOW));
    if (!due.length) continue;
    const file = path.join(gamesDir, `${g.id}.json`);
    const rec = await readJSON(file, { id: g.id, date: g.date, short: g.short, home: g.home?.abbr, away: g.away?.abbr, week: sched.week,
      stadium: { name: st.name, lat: st.lat, lon: st.lon, surface: st.surface, axis: st.axis ?? null }, leads: {} });
    rec.date = g.date;                                    // kickoff can move (flex scheduling)
    let locked = false;
    for (const L of due.filter(L => !rec.leads[L.id])) {
      const wx = await wxFor(st);
      if (!wx) continue;
      const gw = gameWeather(wx, kick);
      rec.leads[L.id] = { at: now, models: Object.fromEntries(Object.entries(gw.byModel).filter(([, hs]) => hs.some(Boolean)).map(([m, hs]) => [m, pack(hs)])) };
      log(`locked ${g.short} ${L.id} (${Object.keys(rec.leads[L.id].models).length} models)`);
      locked = changed = true;
    }
    if (locked) await writeJSON(file, rec);
  }

  // VERIFY
  let files = [];
  try { files = (await readdir(gamesDir)).filter(f => f.endsWith(".json")); } catch {}
  const scoresFile = path.join(dataDir, "nfl", "scores.json");
  const scores = await readJSON(scoresFile, { games: [] });
  for (const f of files) {
    const rec = await readJSON(path.join(gamesDir, f), null);
    if (!rec || rec.verified || rec.gaveUp || !Object.keys(rec.leads).length) continue;
    const kick = Date.parse(rec.date);
    if (now < kick + VERIFY_AFTER) continue;
    if (now > kick + GIVE_UP_AFTER) { rec.gaveUp = true; await writeJSON(path.join(gamesDir, f), rec); changed = true; continue; }
    const slots = [0, 1, 2, 3, 4].map(i => Math.floor(kick / H) * H - H + i * H);
    const ob = await observe(rec.stadium, slots).catch(e => { log(`observations failed ${rec.short}: ${e.message}`); return null; });
    if (!ob) { log(`no observations yet for ${rec.short}`); continue; }
    const leads = {};
    for (const [lid, L] of Object.entries(rec.leads)) {
      leads[lid] = Object.fromEntries(Object.entries(L.models).map(([m, fc]) => [m, scoreModel(fc, ob)]).filter(([, s]) => s));
    }
    rec.verified = now; rec.obs = ob;
    await writeJSON(path.join(gamesDir, f), rec);
    scores.games = scores.games.filter(x => x.id !== rec.id);
    scores.games.push({ id: rec.id, date: rec.date, week: rec.week, short: rec.short, home: rec.home, away: rec.away, stadium: rec.stadium.name, obs: ob, leads });
    log(`verified ${rec.short} at ${ob.station}: temps ${ob.temp.join("/")}, wind ${ob.wind.join("/")}, rain ${ob.rained ? "yes" : "no"}`);
    changed = true;
  }
  if (changed) {
    scores.games.sort((a, b) => a.date < b.date ? -1 : 1);
    scores.updated = now;
    await writeJSON(scoresFile, scores);
  }
  return changed;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  setRequestInit({ headers: { "User-Agent": `weather-compare/1.0 (github.com/${process.env.GITHUB_REPOSITORY || "personal"})`, Accept: "application/geo+json, application/json" } });
  const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
  run({ dataDir }).catch(e => { console.error(e); process.exit(1); });
}
