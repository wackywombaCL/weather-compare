// Daily forecast logger + scorer. Runs in GitHub Actions (see .github/workflows/daily.yml).
//
// 1. SET: at 6am Pacific, save every source's hourly forecast for the next 24 hours
//    (6am today -> 6am tomorrow) for each tracked location.
// 2. SCORE: once a saved window has ended, pull the NWS station observations for that window
//    and score each source: high/low error, hourly temperature error, rain yes/no, rain start time.
//
// Usage: node scripts/daily.mjs            (normal; only sets the forecast between 6 and 10am Pacific)
//        FORCE=true node scripts/daily.mjs (set today's forecast now, whatever the time)

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { SOURCES, PRESETS, WET, setRequestInit, getJSON, dayKey, localHour, localHourStart, isNum, mean, cToF } from "../src/sources.js";

export const TZ = "America/Los_Angeles";
export const SET_HOUR = 6;
const LOCATIONS = [PRESETS.vallejo, PRESETS.napa];
// Observation stations to try first; the nearest NWS stations for the point are tried after these.
const STATION_PREF = { napa: ["KAPC"], vallejo: [] };
const RAIN_POP = 50; // an hour counts as "rain forecast" at >= this % chance, or when its conditions are rain/snow/storms

const r1 = v => isNum(v) ? Math.round(v * 10) / 10 : null;
const nextDayKey = k => dayKey(localHourStart(k, 12, TZ) + 24 * 3600e3, TZ);

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}
async function writeJSON(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data) + "\n");
}

export function windowFor(dateKey) {
  return { start: localHourStart(dateKey, SET_HOUR, TZ), end: localHourStart(nextDayKey(dateKey), SET_HOUR, TZ) };
}

// ---------- 1. SET ----------
export async function setForecast(dateKey, now, log) {
  const win = windowFor(dateKey);
  const from = Math.max(win.start, Math.floor(now / 3600e3) * 3600e3);
  const out = { date: dateKey, setAt: now, windowStart: win.start, windowEnd: win.end, coverStart: from, locations: {} };
  for (const loc of LOCATIONS) {
    const L = (out.locations[loc.id] = { name: loc.name, lat: loc.lat, lon: loc.lon, sources: {} });
    await Promise.all(SOURCES.map(async s => {
      try {
        const d = await s.fetch(loc);
        const hours = d.hourly.filter(h => h.t >= from && h.t < win.end)
          .map(h => ({ t: h.t, temp: r1(h.temp), pop: isNum(h.pop) ? Math.round(h.pop) : null, cat: h.cat }));
        if (!hours.length) throw new Error("no hourly data in window");
        const temps = hours.map(h => h.temp).filter(isNum);
        const pops = hours.map(h => h.pop).filter(isNum);
        const rainHour = hours.find(h => WET.has(h.cat) || (isNum(h.pop) && h.pop >= RAIN_POP));
        L.sources[s.id] = {
          ok: true,
          hi: r1(Math.max(...temps)), lo: r1(Math.min(...temps)),
          maxPop: pops.length ? Math.max(...pops) : null,
          rainStart: rainHour ? rainHour.t : null,
          official: d.daily[dateKey] ? { hi: r1(d.daily[dateKey].hi), lo: r1(d.daily[dateKey].lo), pop: d.daily[dateKey].pop ?? null } : null,
          hours,
        };
      } catch (e) {
        log(`  ${loc.id}/${s.id}: FAILED ${e.message}`);
        L.sources[s.id] = { ok: false, error: String(e.message || e) };
      }
    }));
    log(`  ${loc.id}: ` + SOURCES.map(s => `${s.id}=${L.sources[s.id].ok ? `${L.sources[s.id].hi}/${L.sources[s.id].lo}` : "x"}`).join(" "));
  }
  return out;
}

// ---------- 2. SCORE ----------
const rainy = o => (isNum(o.precip) && o.precip > 0) || /rain|drizzle|shower|thunder/i.test(o.text || "") || o.present.some(w => /rain|drizzle|shower|thunder/i.test(w));

async function stationCandidates(loc) {
  const list = [...(STATION_PREF[loc.id] || [])];
  try {
    const pt = await getJSON(`https://api.weather.gov/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`);
    const st = await getJSON(pt.properties.observationStations);
    for (const f of st.features.slice(0, 5)) {
      const id = f.properties?.stationIdentifier || f.id.split("/").pop();
      if (!list.includes(id)) list.push(id);
    }
  } catch {}
  return list;
}

export async function fetchObservations(loc, win) {
  for (const id of await stationCandidates(loc)) {
    try {
      const q = `start=${encodeURIComponent(new Date(win.start - 30 * 60e3).toISOString())}&end=${encodeURIComponent(new Date(win.end).toISOString())}`;
      const j = await getJSON(`https://api.weather.gov/stations/${id}/observations?${q}`, { tries: 3 });
      const obs = (j.features || []).map(f => f.properties).map(p => ({
        t: Date.parse(p.timestamp),
        temp: isNum(p.temperature?.value) && p.temperature?.qualityControl !== "X" ? cToF(p.temperature.value) : null,
        precip: isNum(p.precipitationLastHour?.value) ? p.precipitationLastHour.value : null, // mm
        text: p.textDescription || "",
        present: (p.presentWeather || []).map(w => w.weather || w.rawString || ""),
      })).filter(o => isNum(o.t)).sort((a, b) => a.t - b.t);
      const inWin = obs.filter(o => o.t >= win.start && o.t < win.end);
      // Need temperature reports for at least ~2/3 of the window's hours.
      const need = Math.max(6, Math.floor((win.end - win.start) / 3600e3 * 0.65));
      if (inWin.filter(o => isNum(o.temp)).length >= need) return { station: id, obs };
    } catch {}
  }
  return null;
}

export function summarizeObs(obs, win) {
  const inWin = obs.filter(o => o.t >= win.start && o.t < win.end);
  const temps = inWin.map(o => o.temp).filter(isNum);
  const rainOb = inWin.find(rainy);
  // Routine hourly reports (around :51-:59) carry the 1-hour precipitation total; summing only those avoids double counting.
  const routine = inWin.filter(o => new Date(o.t).getUTCMinutes() >= 45 && isNum(o.precip));
  const precipMM = routine.length ? routine.reduce((s, o) => s + o.precip, 0) : null;
  // Observed temperature for each forecast hour: nearest report within 20 minutes of the top of the hour.
  const hours = [];
  for (let t = win.start; t < win.end; t += 3600e3) {
    let best = null;
    for (const o of obs) if (isNum(o.temp) && Math.abs(o.t - t) <= 20 * 60e3 && (!best || Math.abs(o.t - t) < Math.abs(best.t - t))) best = o;
    hours.push(best ? r1(best.temp) : null);
  }
  return {
    hi: temps.length ? r1(Math.max(...temps)) : null,
    lo: temps.length ? r1(Math.min(...temps)) : null,
    rained: !!rainOb,
    // A report with a 1-hour rain total means it started sometime in the past hour: use the
    // midpoint, rounded to the hour, so it lines up with hourly forecast slots.
    rainStart: !rainOb ? null : isNum(rainOb.precip) && rainOb.precip > 0
      ? Math.max(win.start, Math.round((rainOb.t - 30 * 60e3) / 3600e3) * 3600e3)
      : rainOb.t,
    precipIn: isNum(precipMM) ? Math.round(precipMM / 25.4 * 100) / 100 : null,
    n: temps.length,
    hours,
  };
}

export function scoreSource(fc, ob, win) {
  if (!fc?.ok) return { ok: false };
  const diffs = [];
  for (const h of fc.hours) {
    const i = Math.round((h.t - win.start) / 3600e3);
    const o = ob.hours[i];
    if (isNum(o) && isNum(h.temp)) diffs.push(h.temp - o);
  }
  let rain;
  if (fc.rainStart && ob.rained) rain = "hit";
  else if (fc.rainStart) rain = "false";
  else if (ob.rained) rain = "miss";
  else rain = "none";
  return {
    ok: true,
    hi: fc.hi, lo: fc.lo,
    hiErr: isNum(ob.hi) ? r1(fc.hi - ob.hi) : null,
    loErr: isNum(ob.lo) ? r1(fc.lo - ob.lo) : null,
    mae: diffs.length ? r1(mean(diffs.map(Math.abs))) : null,
    bias: diffs.length ? r1(mean(diffs)) : null,
    nh: diffs.length,
    maxPop: fc.maxPop,
    brier: isNum(fc.maxPop) ? Math.round(((fc.maxPop / 100 - (ob.rained ? 1 : 0)) ** 2) * 1000) / 1000 : null,
    rainStart: fc.rainStart,
    rain,
    timing: rain === "hit" ? r1((fc.rainStart - ob.rainStart) / 3600e3) : null, // + = forecast too late, - = too early
  };
}

// ---------- Main ----------
export async function run({ dataDir, now = Date.now(), force = false, log = console.log } = {}) {
  const today = dayKey(now, TZ);
  const hr = localHour(now, TZ);
  log(`Run at ${new Date(now).toISOString()} (${today} ${hr}:xx Pacific)`);

  // 1. SET today's forecast
  const snapFile = path.join(dataDir, "forecasts", `${today}.json`);
  const have = await readJSON(snapFile, null);
  if (have) log(`Forecast for ${today} already set.`);
  else if (force || (hr >= SET_HOUR && hr < SET_HOUR + 4)) {
    log(`Setting forecast for ${today}…`);
    await writeJSON(snapFile, await setForecast(today, now, log));
  } else log(`Not setting a forecast: it's ${hr}:xx Pacific (window is ${SET_HOUR}–${SET_HOUR + 4}am).`);

  // 2. SCORE any set forecast whose 24-hour window has ended
  const scoresFile = path.join(dataDir, "scores.json");
  const scores = await readJSON(scoresFile, { version: 1, sources: {}, days: [] });
  let files = [];
  try { files = (await readdir(path.join(dataDir, "forecasts"))).filter(f => f.endsWith(".json")).sort(); } catch {}
  let changed = false;
  for (const f of files) {
    const date = f.replace(".json", "");
    const snap = await readJSON(path.join(dataDir, "forecasts", f), null);
    if (!snap) continue;
    // If the forecast was set late (e.g. a manual run in the evening), only score the hours it covered.
    const win = { start: snap.coverStart ?? snap.windowStart, end: snap.windowEnd };
    const partial = win.start - snap.windowStart >= 2 * 3600e3;
    if (now < win.end + 20 * 60e3) continue;            // window not over yet
    if (now - win.end > 6 * 24 * 3600e3) continue;      // too old: NWS keeps about a week of observations
    for (const loc of LOCATIONS) {
      if (!snap.locations[loc.id]) continue;
      if (scores.days.some(d => d.date === date && d.loc === loc.id)) continue;
      log(`Scoring ${date} ${loc.id}…`);
      const got = await fetchObservations(loc, win);
      if (!got) { log(`  no usable observations yet`); continue; }
      const ob = summarizeObs(got.obs, win);
      const src = {};
      for (const s of SOURCES) src[s.id] = scoreSource(snap.locations[loc.id].sources[s.id], ob, win);
      scores.days.push({ date, loc: loc.id, station: got.station, partial, windowStart: win.start, windowEnd: win.end, setAt: snap.setAt, obs: ob, src });
      log(`  ${got.station}: obs ${ob.hi}/${ob.lo}, rain ${ob.rained ? "yes" : "no"} | ` +
        SOURCES.map(s => `${s.id} hi${src[s.id].hiErr ?? "-"} lo${src[s.id].loErr ?? "-"} mae${src[s.id].mae ?? "-"} ${src[s.id].rain ?? ""}`).join(" | "));
      changed = true;
    }
  }
  for (const s of SOURCES) scores.sources[s.id] = { name: s.name, short: s.short };
  if (changed || !have) {
    scores.days.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.loc < b.loc ? -1 : 1);
    scores.updated = now;
    await writeJSON(scoresFile, scores);
  }
  return scores;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const repo = process.env.GITHUB_REPOSITORY || "personal";
  // NWS and MET Norway both ask automated clients to identify themselves.
  setRequestInit({ headers: { "User-Agent": `weather-compare/1.0 (github.com/${repo})`, Accept: "application/geo+json, application/json" } });
  const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
  run({ dataDir, force: process.env.FORCE === "true" }).catch(e => { console.error(e); process.exit(1); });
}
