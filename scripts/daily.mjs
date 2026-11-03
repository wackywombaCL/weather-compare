// Daily forecast logger + scorer. Runs in GitHub Actions (see .github/workflows/daily.yml).
//
// 1. SET (6am Pacific): save every source's hourly forecast for three 24-hour windows
//    (6am→6am): today (lead 0), tomorrow (lead 1) and the day after (lead 2), for each location.
//    Two extra "sources" are saved too: the plain average of all sources and the smart
//    (accuracy-weighted) average, so we can see whether they beat the individual sources.
// 2. SCORE: once a window has ended, pull the NWS station observations and score each source:
//    high/low miss, hourly miss, rain hit/miss/false alarm, rain start timing, Brier score.
// 3. STATUS + ALERTS: write data/status.json (shown in the app) and, if NTFY_TOPIC is set,
//    send phone notifications for problems and for rainy days.
//
// Usage: node scripts/daily.mjs            (normal; only sets the forecast between 6 and 10am Pacific)
//        FORCE=true node scripts/daily.mjs (set today's forecast now, whatever the time)

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { SOURCES, PRESETS, isRainyHour, setRequestInit, setKeyProvider, getJSON, dayKey, localHour, localHourStart, isNum, mean, mode, cToF } from "../src/sources.js";
import { recentScores, smartWeights, PSEUDO_NAMES, elementSkill, elementWeights, BEST_MIN_DAYS } from "../src/skill.js";

export const TZ = "America/Los_Angeles";
export const SET_HOUR = 6;
export const LEADS = [0, 1, 2];
const LOCATIONS = [PRESETS.vallejo, PRESETS.napa];
// Observation stations to try first; the nearest NWS stations for the point are tried after these.
// Vallejo has no NWS station of its own; Napa County Airport (KAPC) is ~7.5 mi away, much closer
// (and more similar) than Travis AFB (KSUU, ~20 mi inland), which NWS lists first for Vallejo.
const STATION_PREF = { napa: ["KAPC"], vallejo: ["KAPC"] };
const SITE = "https://wackywombacl.github.io/weather-compare/";

const r1 = v => isNum(v) ? Math.round(v * 10) / 10 : null;
const addDays = (k, n) => dayKey(localHourStart(k, 12, TZ) + n * 24 * 3600e3, TZ);
const fmtTime = t => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(t).replace(":00", "").replace(" ", "").toLowerCase();

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}
async function writeJSON(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data) + "\n");
}

export function windowFor(dateKey) {
  return { start: localHourStart(dateKey, SET_HOUR, TZ), end: localHourStart(addDays(dateKey, 1), SET_HOUR, TZ) };
}

// Compact hourly storage: arrays indexed by hour from `start`.
function pack(hours, start, end) {
  const n = Math.round((end - start) / 3600e3);
  const temp = Array(n).fill(null), pop = Array(n).fill(null), cat = Array(n).fill(null), qpf = Array(n).fill(null), wind = Array(n).fill(null);
  for (const h of hours) {
    const i = Math.round((h.t - start) / 3600e3);
    if (i < 0 || i >= n) continue;
    temp[i] = r1(h.temp); pop[i] = isNum(h.pop) ? Math.round(h.pop) : null; cat[i] = h.cat || null;
    qpf[i] = isNum(h.qpf) ? Math.round(h.qpf * 1000) / 1000 : null;
    wind[i] = isNum(h.wind) ? Math.round(h.wind) : null;
  }
  return { start, temp, pop, cat, ...(qpf.some(isNum) ? { qpf } : {}), ...(wind.some(isNum) ? { wind } : {}) };
}
export function unpack(p) {
  if (!p) return [];
  if (Array.isArray(p.hours)) return p.hours; // old format
  const out = [];
  p.temp.forEach((t, i) => { if (isNum(t)) out.push({ t: p.start + i * 3600e3, temp: t, pop: p.pop[i], cat: p.cat[i], qpf: p.qpf?.[i] ?? null, wind: p.wind?.[i] ?? null }); });
  return out;
}
function summarize(hours) {
  const temps = hours.map(h => h.temp).filter(isNum);
  const pops = hours.map(h => h.pop).filter(isNum);
  const rainHour = hours.find(isRainyHour);
  const q = hours.map(h => h.qpf).filter(isNum);
  return { qpfTotal: q.length ? Math.round(q.reduce((a, b) => a + b, 0) * 100) / 100 : null, hi: temps.length ? r1(Math.max(...temps)) : null, lo: temps.length ? r1(Math.min(...temps)) : null,
           maxPop: pops.length ? Math.max(...pops) : null, rainStart: rainHour ? rainHour.t : null, nh: hours.length };
}

// Plain or weighted average of several sources' hourly forecasts for one window.
function blend(entries, weights) {
  const byT = new Map();
  for (const [id, hours] of entries) {
    const w = weights ? weights[id] ?? 0 : 1;
    if (!w) continue;
    for (const h of hours) (byT.get(h.t) || byT.set(h.t, []).get(h.t)).push({ ...h, w });
  }
  const out = [];
  for (const [t, hs] of [...byT.entries()].sort((a, b) => a[0] - b[0])) {
    const tw = hs.reduce((s, h) => s + (isNum(h.temp) ? h.w : 0), 0);
    if (!tw || hs.length < 2) continue;
    const temp = hs.reduce((s, h) => s + (isNum(h.temp) ? h.temp * h.w : 0), 0) / tw;
    const pw = hs.filter(h => isNum(h.pop));
    const pop = pw.length ? pw.reduce((s, h) => s + h.pop * h.w, 0) / pw.reduce((s, h) => s + h.w, 0) : null;
    const wetShare = hs.reduce((s, h) => s + (isRainyHour(h) ? h.w : 0), 0) / hs.reduce((s, h) => s + h.w, 0);
    const qw = hs.filter(h => isNum(h.qpf));
    const qpf = qw.length ? qw.reduce((s, h) => s + h.qpf * h.w, 0) / qw.reduce((s, h) => s + h.w, 0) : null;
    const ww = hs.filter(h => isNum(h.wind));
    const wind = ww.length ? ww.reduce((s, h) => s + h.wind * h.w, 0) / ww.reduce((s, h) => s + h.w, 0) : null;
    out.push({ t, temp, pop, qpf, wind, cat: wetShare >= 0.5 ? "rain" : mode(hs.map(h => h.cat)) });
  }
  return out;
}

// ---------- 1. SET ----------
export async function setForecast(dateKey, now, log, scores) {
  const leads = {};
  for (const L of LEADS) {
    const w = windowFor(addDays(dateKey, L));
    leads[L] = { date: addDays(dateKey, L), windowStart: w.start, windowEnd: w.end, coverStart: L === 0 ? Math.max(w.start, Math.floor(now / 3600e3) * 3600e3) : w.start };
  }
  const out = { v: 2, date: dateKey, setAt: now, leads, locations: {} };
  const problems = [];
  for (const loc of LOCATIONS) {
    const Lc = (out.locations[loc.id] = { name: loc.name, lat: loc.lat, lon: loc.lon, sources: {} });
    await Promise.all(SOURCES.map(async s => {
      if (s.key && !process.env[s.key.env]) return; // no key saved yet: not tracked
      try {
        const d = await s.fetch(loc);
        const entry = { ok: true, leads: {} };
        for (const L of LEADS) {
          const { coverStart: from, windowEnd: end, date } = leads[L];
          const hours = d.hourly.filter(h => h.t >= from && h.t < end);
          if (hours.length < 6) continue;   // doesn't forecast that far out hour by hour
          entry.leads[L] = { ...summarize(hours), dayPop: d.daily[date]?.pop ?? null, ...pack(hours, from, end) };
        }
        if (!entry.leads[0]) throw new Error("no hourly data for today");
        Lc.sources[s.id] = entry;
      } catch (e) {
        log(`  ${loc.id}/${s.id}: FAILED ${e.message}`);
        Lc.sources[s.id] = { ok: false, error: String(e.message || e) + (e.status ? ` (HTTP ${e.status})` : "") };
        problems.push({ source: s.id, loc: loc.id, error: Lc.sources[s.id].error });
      }
    }));
    // Pseudo-sources: plain average and accuracy-weighted ("smart") average, per lead.
    const okIds = Object.keys(Lc.sources).filter(id => Lc.sources[id].ok);
    for (const pid of ["avg", "smart"]) {
      const entry = { ok: true, leads: {} };
      for (const L of LEADS) {
        const entries = okIds.filter(id => Lc.sources[id].leads[L]).map(id => [id, unpack(Lc.sources[id].leads[L])]);
        let weights = null;
        if (pid === "smart") {
          const rs = recentScores(scores.days, { locs: [loc.id], lead: L, n: 14 });
          weights = smartWeights(rs.scores, okIds) || smartWeights(recentScores(scores.days, { locs: [loc.id], lead: 0, n: 14 }).scores, okIds);
          if (weights) entry.weights = { ...(entry.weights || {}), [L]: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Math.round(v * 100) / 100])) };
        }
        const hours = blend(entries, weights);
        if (hours.length < 6) continue;
        const { coverStart: from, windowEnd: end } = leads[L];
        entry.leads[L] = { ...summarize(hours), ...pack(hours, from, end) };
      }
      if (entry.leads[0]) Lc.sources[pid] = entry;
    }
    const best = buildBest(Lc, okIds, leads, scores, loc.id);
    if (best) Lc.sources.best = best;
    log(`  ${loc.id}: ` + Object.entries(Lc.sources).map(([id, x]) => `${id}=${x.ok ? `${x.leads[0].hi}/${x.leads[0].lo}` : "x"}`).join(" "));
  }
  return { snap: out, problems };
}

// "Best forecast": each element (high, low, hourly temps, rain chance, rain timing, amount, wind)
// blended from the sources that have been most accurate at that element lately.
function wavg(pairs, w) {
  const v = pairs.filter(([id, x]) => isNum(x) && (!w || w[id]));
  if (!v.length) return null;
  const ws = v.map(([id]) => w ? w[id] : 1), tw = ws.reduce((a, b) => a + b, 0);
  return v.reduce((s, [, x], i) => s + x * ws[i], 0) / tw;
}
function buildBest(Lc, okIds, leads, scores, locId) {
  const full = new Set(scores.days.filter(d => d.loc === locId && (d.lead ?? 0) === 0 && !d.partial).map(d => d.date));
  if (full.size < BEST_MIN_DAYS) return null;
  const sk0 = elementSkill(scores.days, { locs: [locId], lead: 0, n: 14 }).skill;
  const entry = { ok: true, leads: {}, from: {} };
  for (const L of LEADS) {
    const skL = elementSkill(scores.days, { locs: [locId], lead: L, n: 14 }).skill;
    const W = el => elementWeights(skL, el, okIds) || elementWeights(sk0, el, okIds);
    const w = { high: W("high"), low: W("low"), temp: W("temp"), rain: W("rain"), timing: W("timing"), amount: W("amount"), wind: W("wind") };
    const per = okIds.filter(id => Lc.sources[id].leads[L]).map(id => [id, Lc.sources[id].leads[L], unpack(Lc.sources[id].leads[L])]);
    if (per.length < 2) continue;
    const byT = new Map();
    for (const [id, , hours] of per) for (const h of hours) (byT.get(h.t) || byT.set(h.t, []).get(h.t)).push([id, h]);
    const hours = [];
    for (const [t, hs] of [...byT.entries()].sort((a, b) => a[0] - b[0])) {
      if (hs.length < 2) continue;
      const rw = w.timing || w.rain;
      const wetShare = wavg(hs.map(([id, h]) => [id, isRainyHour(h) ? 1 : 0]), rw) ?? 0;
      hours.push({
        t, temp: wavg(hs.map(([id, h]) => [id, h.temp]), w.temp), pop: wavg(hs.map(([id, h]) => [id, h.pop]), w.rain),
        qpf: wavg(hs.map(([id, h]) => [id, h.qpf]), w.amount || w.rain), wind: wavg(hs.map(([id, h]) => [id, h.wind]), w.wind),
        cat: wetShare >= 0.5 ? "rain" : mode(hs.map(([, h]) => h.cat)),
      });
    }
    if (hours.length < 6) continue;
    const { coverStart: from, windowEnd: end } = leads[L];
    const hiFix = wavg(per.map(([id, x]) => [id, x.hi]), w.high), loFix = wavg(per.map(([id, x]) => [id, x.lo]), w.low);
    entry.leads[L] = { ...summarize(hours), hiFix: r1(hiFix), loFix: r1(loFix), ...(isNum(hiFix) ? { hi: r1(hiFix) } : {}), ...(isNum(loFix) ? { lo: r1(loFix) } : {}), ...pack(hours, from, end) };
    entry.from[L] = Object.fromEntries(Object.entries(w).map(([el, ws]) => [el, ws ? Object.entries(ws).sort((a, b) => b[1] - a[1])[0][0] : null]));
  }
  return entry.leads[0] ? entry : null;
}

// ---------- 2. SCORE ----------
const rainy = o => (isNum(o.precip) && o.precip > 0) || /rain|drizzle|shower|thunder/i.test(o.text || "") || o.present.some(w => /rain|drizzle|shower|thunder/i.test(w));
const miles = (a, b) => { const R = 3958.8, r = x => x * Math.PI / 180; const dl = r(b[0] - a[0]), dn = r(b[1] - a[1]); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

export async function stationCandidates(loc) {
  const list = [];
  const add = (id, name, lat, lon) => { if (!list.some(x => x.id === id)) list.push({ id, name, mi: isNum(lat) ? Math.round(miles([loc.lat, loc.lon], [lat, lon]) * 10) / 10 : null }); };
  let feats = [];
  try {
    const pt = await getJSON(`https://api.weather.gov/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`);
    feats = (await getJSON(pt.properties.observationStations)).features || [];
  } catch {}
  const info = f => ({ id: f.properties?.stationIdentifier || f.id.split("/").pop(), name: f.properties?.name, lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0] });
  for (const id of STATION_PREF[loc.id] || []) { const f = feats.map(info).find(x => x.id === id); add(id, f?.name, f?.lat, f?.lon); }
  for (const f of feats.slice(0, 6).map(info)) add(f.id, f.name, f.lat, f.lon);
  return list;
}

export async function fetchObservations(loc, win) {
  for (const st of await stationCandidates(loc)) {
    try {
      const q = `start=${encodeURIComponent(new Date(win.start - 30 * 60e3).toISOString())}&end=${encodeURIComponent(new Date(win.end).toISOString())}`;
      const j = await getJSON(`https://api.weather.gov/stations/${st.id}/observations?${q}`, { tries: 3 });
      const obs = (j.features || []).map(f => f.properties).map(p => ({
        t: Date.parse(p.timestamp),
        temp: isNum(p.temperature?.value) && p.temperature?.qualityControl !== "X" ? cToF(p.temperature.value) : null,
        precip: isNum(p.precipitationLastHour?.value) ? p.precipitationLastHour.value : null, // mm
        wind: isNum(p.windSpeed?.value) ? p.windSpeed.value / 1.609 : null,                   // km/h -> mph
        text: p.textDescription || "",
        present: (p.presentWeather || []).map(w => w.weather || w.rawString || ""),
      })).filter(o => isNum(o.t)).sort((a, b) => a.t - b.t);
      const inWin = obs.filter(o => o.t >= win.start && o.t < win.end);
      // Need temperature reports for at least ~2/3 of the window's hours.
      const need = Math.max(6, Math.floor((win.end - win.start) / 3600e3 * 0.65));
      if (inWin.filter(o => isNum(o.temp)).length >= need) return { station: st, obs };
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
  // Observed temperature for each hour: nearest report within 20 minutes of the top of the hour.
  const hours = [], wind = [];
  for (let t = win.start; t < win.end; t += 3600e3) {
    let best = null, bw = null;
    for (const o of obs) {
      if (Math.abs(o.t - t) > 20 * 60e3) continue;
      if (isNum(o.temp) && (!best || Math.abs(o.t - t) < Math.abs(best.t - t))) best = o;
      if (isNum(o.wind) && (!bw || Math.abs(o.t - t) < Math.abs(bw.t - t))) bw = o;
    }
    hours.push(best ? r1(best.temp) : null);
    wind.push(bw ? Math.round(bw.wind) : null);
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
    wind,
  };
}

export function scoreSource(fc, ob, win) {
  if (!fc) return { ok: false };
  const hours = unpack(fc).filter(h => h.t >= win.start && h.t < win.end);
  if (hours.length < 6) return { ok: false };
  const sm = summarize(hours);
  if (isNum(fc.hiFix)) sm.hi = fc.hiFix;   // Best forecast: high/low blended by high/low skill
  if (isNum(fc.loFix)) sm.lo = fc.loFix;
  const diffs = [], wdiffs = [];
  for (const h of hours) {
    const o = ob.hours[Math.round((h.t - win.start) / 3600e3)];
    if (isNum(o) && isNum(h.temp)) diffs.push(h.temp - o);
    const ow = ob.wind?.[Math.round((h.t - win.start) / 3600e3)];
    if (isNum(ow) && isNum(h.wind)) wdiffs.push(h.wind - ow);
  }
  const rain = sm.rainStart && ob.rained ? "hit" : sm.rainStart ? "false" : ob.rained ? "miss" : "none";
  return {
    ok: true,
    hi: sm.hi, lo: sm.lo,
    hiErr: isNum(ob.hi) && isNum(sm.hi) ? r1(sm.hi - ob.hi) : null,
    loErr: isNum(ob.lo) && isNum(sm.lo) ? r1(sm.lo - ob.lo) : null,
    mae: diffs.length ? r1(mean(diffs.map(Math.abs))) : null,
    bias: diffs.length ? r1(mean(diffs)) : null,
    nh: diffs.length,
    maxPop: sm.maxPop,
    brier: isNum(sm.maxPop) ? Math.round(((sm.maxPop / 100 - (ob.rained ? 1 : 0)) ** 2) * 1000) / 1000 : null,
    rainStart: sm.rainStart,
    rain,
    timing: rain === "hit" ? r1((sm.rainStart - ob.rainStart) / 3600e3) : null, // + = forecast too late, - = too early
    qpf: sm.qpfTotal,                                                       // forecast rain total (in)
    windMae: wdiffs.length >= 6 ? r1(mean(wdiffs.map(Math.abs))) : null,    // hourly wind miss (mph)
    qpfErr: isNum(sm.qpfTotal) && isNum(ob.precipIn) ? Math.round((sm.qpfTotal - ob.precipIn) * 100) / 100 : null,
  };
}

// Normalize a saved forecast (old single-window format or v2) into { leads, locations[loc].sources[id].leads[L] }.
function normalize(snap) {
  if (snap.v === 2) return snap;
  const leads = { 0: { date: snap.date, windowStart: snap.windowStart, windowEnd: snap.windowEnd, coverStart: snap.coverStart ?? snap.windowStart } };
  const locations = {};
  for (const [lid, L] of Object.entries(snap.locations || {})) {
    locations[lid] = { ...L, sources: {} };
    for (const [id, x] of Object.entries(L.sources || {})) locations[lid].sources[id] = x.ok ? { ok: true, leads: { 0: x } } : x;
  }
  return { ...snap, leads, locations };
}

// ---------- 3. Alerts ----------
async function notify({ title, body, tags }, log) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: "POST", body, headers: { Title: title, Tags: tags, Click: SITE } });
    log(`  notification "${title}": ${r.ok ? "sent" : "HTTP " + r.status}`);
  } catch (e) { log(`  notification failed: ${e.message}`); }
}

function rainOutlook(snap, locId, now) {
  const L = snap.locations[locId], lead = snap.leads[0];
  if (!L) return null;
  // Same rule as the app: show when the sources' average daily rain chance is over 40%.
  const real = Object.entries(L.sources).filter(([id, x]) => x.ok && !PSEUDO_NAMES[id] && x.leads[0]);
  const avgPop = mean(real.map(([, x]) => x.leads[0].dayPop ?? x.leads[0].maxPop));
  if (!isNum(avgPop) || avgPop <= 40) return null;
  const end = localHourStart(addDays(lead.date, 1), 0, TZ);
  const starts = real.map(([, x]) => unpack(x.leads[0]).filter(h => h.t < end).find(isRainyHour)?.t).filter(isNum);
  if (!starts.length) return null;
  const t = Math.round(mean(starts) / 1800e3) * 1800e3;
  return { avgPop: Math.round(avgPop), t, now: t <= now, n: starts.length, of: real.length };
}

// ---------- Main ----------
export async function run({ dataDir, now = Date.now(), force = false, log = console.log } = {}) {
  const today = dayKey(now, TZ);
  const hr = localHour(now, TZ);
  log(`Run at ${new Date(now).toISOString()} (${today} ${hr}:xx Pacific)`);
  const scoresFile = path.join(dataDir, "scores.json");
  const statusFile = path.join(dataDir, "status.json");
  const scores = await readJSON(scoresFile, { version: 2, sources: {}, days: [] });
  const status = await readJSON(statusFile, { sources: {}, alerted: {} });
  status.alerted ||= {};
  status.lastRun = now;
  const problems = [];

  // 1. SET today's forecast
  const snapFile = path.join(dataDir, "forecasts", `${today}.json`);
  const have = await readJSON(snapFile, null);
  let setNow = false;
  if (have) log(`Forecast for ${today} already set.`);
  else if (force || (hr >= SET_HOUR && hr < SET_HOUR + 4)) {
    log(`Setting forecast for ${today}…`);
    const { snap, problems: p } = await setForecast(today, now, log, scores);
    await writeJSON(snapFile, snap);
    setNow = true;
    status.lastSet = { date: today, at: now };
    for (const s of SOURCES) {
      const results = LOCATIONS.map(l => snap.locations[l.id].sources[s.id]).filter(Boolean);
      if (!results.length) { status.sources[s.id] = { ...(status.sources[s.id] || {}), tracked: false }; continue; }
      const bad = results.find(x => !x.ok);
      status.sources[s.id] = { ...(status.sources[s.id] || {}), tracked: true, ok: !bad, error: bad?.error || null, lastOk: bad ? status.sources[s.id]?.lastOk ?? null : today };
    }
    problems.push(...p.map(x => `${SOURCES.find(s => s.id === x.source)?.name || x.source} (${x.loc}): ${x.error}`));
    // Rain alert for today
    const lines = LOCATIONS.map(l => { const r = rainOutlook(snap, l.id, now); return r ? `${l.name.replace(", CA", "")}: ${r.now ? "rain already starting" : "starting around " + fmtTime(r.t)} (${r.n} of ${r.of} sources, avg ${r.avgPop}% chance)` : null; }).filter(Boolean);
    if (lines.length) await notify({ title: "Rain likely today", body: lines.join("\n"), tags: "umbrella" }, log);
  } else log(`Not setting a forecast: it's ${hr}:xx Pacific (window is ${SET_HOUR}–${SET_HOUR + 4}am).`);

  // 2. SCORE every saved window that has ended
  let files = [];
  try { files = (await readdir(path.join(dataDir, "forecasts"))).filter(f => f.endsWith(".json")).sort(); } catch {}
  let changed = false;
  const obsCache = new Map();
  for (const f of files) {
    const raw = await readJSON(path.join(dataDir, "forecasts", f), null);
    if (!raw) continue;
    const snap = normalize(raw);
    for (const [Ls, lead] of Object.entries(snap.leads)) {
      const L = +Ls;
      const win = { start: lead.coverStart ?? lead.windowStart, end: lead.windowEnd };
      const partial = win.start - lead.windowStart >= 2 * 3600e3;
      if (now < win.end + 5 * 60e3) continue;           // window not over yet (the 5:53am report is out by ~6:05)
      if (now - win.end > 6 * 24 * 3600e3) continue;    // too old: NWS keeps about a week of observations
      for (const loc of LOCATIONS) {
        const Lc = snap.locations[loc.id];
        if (!Lc) continue;
        if (scores.days.some(d => d.date === lead.date && d.loc === loc.id && (d.lead ?? 0) === L)) continue;
        log(`Scoring ${lead.date} ${loc.id} (lead ${L}, set ${snap.date})…`);
        const ck = `${loc.id}|${win.start}|${win.end}`;
        if (!obsCache.has(ck)) obsCache.set(ck, await fetchObservations(loc, win));
        const got = obsCache.get(ck);
        if (!got) {
          log(`  no usable observations yet`);
          const key = `noobs|${lead.date}|${loc.id}`;
          if (now - win.end > 3 * 3600e3 && !status.alerted[key]) { problems.push(`No usable station observations for ${loc.name} on ${lead.date}`); status.alerted[key] = now; }
          continue;
        }
        const ob = summarizeObs(got.obs, win);
        const src = {};
        for (const [id, fc] of Object.entries(Lc.sources)) if (fc.ok && fc.leads?.[L]) src[id] = scoreSource(fc.leads[L], ob, win);
        scores.days.push({ date: lead.date, setDate: snap.date, lead: L, loc: loc.id, station: got.station.id, stationName: got.station.name || null, stationMi: got.station.mi,
          partial, windowStart: win.start, windowEnd: win.end, setAt: snap.setAt, obs: ob, src });
        log(`  ${got.station.id}: obs ${ob.hi}/${ob.lo}, rain ${ob.rained ? "yes" : "no"} | ` +
          Object.entries(src).map(([id, x]) => `${id} hi${x.hiErr ?? "-"} lo${x.loErr ?? "-"} mae${x.mae ?? "-"} ${x.rain ?? ""}`).join(" | "));
        status.lastScored = { date: lead.date, at: now };
        status.stations = { ...(status.stations || {}), [loc.id]: got.station };
        changed = true;
      }
    }
  }
  for (const s of SOURCES) scores.sources[s.id] = { name: s.name, short: s.short, group: s.group || null };
  for (const [id, name] of Object.entries(PSEUDO_NAMES)) scores.sources[id] = { name, short: { avg: "Average", smart: "Smart avg", best: "Best" }[id], group: "blend" };
  scores.version = 2;
  if (changed || setNow) {
    scores.days.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.lead ?? 0) - (b.lead ?? 0) || (a.loc < b.loc ? -1 : 1));
    scores.updated = now;
    await writeJSON(scoresFile, scores);
  }

  // 3. STATUS + problem alerts
  status.problems = problems;
  for (const k of Object.keys(status.alerted)) if (now - status.alerted[k] > 14 * 24 * 3600e3) delete status.alerted[k];
  await writeJSON(statusFile, status);
  if (problems.length) await notify({ title: "Weather tracking problem", body: problems.join("\n"), tags: "warning" }, log);
  return scores;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const repo = process.env.GITHUB_REPOSITORY || "personal";
  setKeyProvider(id => { const s = SOURCES.find(x => x.id === id); return s?.key ? process.env[s.key.env] : null; });
  // NWS and MET Norway both ask automated clients to identify themselves.
  setRequestInit({ headers: { "User-Agent": `weather-compare/1.0 (github.com/${repo})`, Accept: "application/geo+json, application/json" } });
  const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
  run({ dataDir, force: process.env.FORCE === "true" }).catch(e => { console.error(e); process.exit(1); });
}
