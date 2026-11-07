// Daily forecast tracking for every outdoor US NFL stadium (the Stadiums tab). Runs hourly
// (stadiums.yml); each step only does work when it's due.
//
// LOCK (once a day, after 6am local at each stadium): every model's hourly forecast for the
//   whole local day (all 24 hours), today and 1, 2 and 3 days ahead, plus the current "best blend".
//                                                     → data/stadiums/locks/<date>.json
// VERIFY (after 2am local the next day): hourly observations from the nearest official
//   station (NWS). Two scores per forecast:
//   - game hours (9am–midnight), scored the same way as NFL games → sets the best blend;
//   - full day: high, low, rain total and rain call → sets the blend used for rain in the
//     48 hours before kickoff (wet-field flag).
//                                                     → data/stadiums/scores.json (rolling)
// SKILL: per stadium, lead and element (temperature, wind, rain), which models have been best
//   over the last 14 days → weights for the best blend, plus tables for the tab.
//                                                     → data/stadiums/skill.json
// FORECAST (every 3 hours): the best-blend daily forecast for each stadium → data/stadiums/forecast.json
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { setRequestInit, isNum, dayKey, localHour, localHourStart } from "../src/sources.js";
import { TRACKED, stadiumKey } from "../src/stadiums.js";
import { fetchStadiumWeather, NFL_MODELS } from "../src/nflwx.js";
import { LEAD_DAYS, RECENT_DAYS, BEST, weightsFrom, dayWeightsFrom, addBest } from "../src/stadiumskill.js";
import { observe, scoreModel, pack } from "./nfl-verify.mjs";

const H = 3600e3;
export const DAY_HOURS = Array.from({ length: 24 }, (_, i) => i);   // local midnight … 11pm
export const GAME_FROM = 9;                                         // game hours: 9am … 11pm (the hour ending at midnight)
const LOCK_HOUR = 6, VERIFY_HOUR = 2, KEEP_DAYS = 45, GIVE_UP_DAYS = 4, FORECAST_EVERY = 2.5 * H, FORECAST_DAYS = 6;
const r1 = v => isNum(v) ? Math.round(v * 10) / 10 : null, r2 = v => isNum(v) ? Math.round(v * 100) / 100 : null;
const addDays = (k, n) => new Date(Date.parse(k + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const avg = a => { const v = a.filter(isNum); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
const right = r => r === "hit" || r === "none";

// The game hours (from index g0) of a packed 24-hour forecast.
const sliceP = (p, g0) => Object.fromEntries(Object.entries(p).map(([k, a]) => [k, a.slice(g0)]));
// Full-day score: high, low, rain total and whether it rained at all.
export function scoreDay(p, ob) {
  const fT = p.temp.filter(isNum), oT = ob.temp.filter(isNum);
  if (fT.length < 16 || oT.length < 16) return null;
  const qpf = p.qpf.reduce((s, q) => s + (isNum(q) ? q : 0), 0);
  const wet = p.qpf.some(q => isNum(q) && q >= 0.01) || p.snow.some(x => isNum(x) && x >= 0.1);
  return { hiErr: r1(Math.max(...fT) - Math.max(...oT)), loErr: r1(Math.min(...fT) - Math.min(...oT)), qpf: r2(qpf),
    qpfErr: isNum(ob.precip) ? r2(qpf - ob.precip) : null, rain: wet && ob.rained ? "hit" : wet ? "false" : ob.rained ? "miss" : "none" };
}

async function readJSON(f, d) { try { return JSON.parse(await readFile(f, "utf8")); } catch { return d; } }
async function writeJSON(f, data) { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(data) + "\n"); }

// ---------- Skill tables (weights + leaderboards for the tab) ----------
const sumStat = rs => ({ n: rs.length, score: r1(avg(rs.map(s => s.score))), temp: r1(avg(rs.map(s => s.tempMae))), wind: r1(avg(rs.map(s => s.windMae))),
  rain: rs.length ? Math.round(100 * rs.filter(s => right(s.rain)).length / rs.length) : null, bias: r1(avg(rs.map(s => s.tempBias))) });
const daySum = rs => ({ n: rs.length, hi: r1(avg(rs.map(s => isNum(s.hiErr) ? Math.abs(s.hiErr) : null))), lo: r1(avg(rs.map(s => isNum(s.loErr) ? Math.abs(s.loErr) : null))),
  qpf: r2(avg(rs.map(s => isNum(s.qpfErr) ? Math.abs(s.qpfErr) : null))), rain: Math.round(100 * rs.filter(s => right(s.rain)).length / rs.length) });
export function buildSkill(scores, now) {
  const days = scores.days || [];
  const cutoff = d => d >= addDays(dayKey(now, "UTC"), -RECENT_DAYS - 1);
  const keys = [...new Set(days.map(d => d.st))];
  const weights = { st: {}, all: {} };
  const recent = { st: {}, all: {} };
  for (const L of LEAD_DAYS.map(String)) {
    const rows = days.filter(d => cutoff(d.date));
    weights.all[L] = { ...weightsFrom(rows, L, { bias: false }), ...dayWeightsFrom(rows, L) };
    for (const k of keys) {
      const own = rows.filter(d => d.st === k);
      if (own.length) (weights.st[k] ||= {})[L] = { ...weightsFrom(own, L), ...dayWeightsFrom(own, L) };
    }
    const table = rs => Object.fromEntries([...NFL_MODELS, BEST].map(m => {
      const s = sumStat(rs.map(d => d.leads?.[L]?.[m]).filter(Boolean));
      const ds = rs.map(d => d.day?.leads?.[L]?.[m]).filter(Boolean);
      if (ds.length) s.day = daySum(ds);
      return [m, s];
    }).filter(([, s]) => s.n || s.day));
    recent.all[L] = table(rows);
    for (const k of keys) { const t = table(rows.filter(d => d.st === k)); if (Object.keys(t).length) (recent.st[k] ||= {})[L] = t; }
  }
  // All-time: running sums kept in scores.totals.
  const allTime = { st: {}, all: {} };
  for (const [k, byL] of Object.entries(scores.totals || {})) for (const [L, byM] of Object.entries(byL)) for (const [m, t] of Object.entries(byM)) {
    const cell = { n: t.n, score: r1(t.score / t.n), temp: r1(t.temp / t.n), wind: isNum(t.wind) && t.nw ? r1(t.wind / t.nw) : null, rain: Math.round(100 * t.right / t.n), bias: r1(t.bias / t.n) };
    ((allTime.st[k] ||= {})[L] ||= {})[m] = cell;
    const a = ((allTime.all[L] ||= {})[m] ||= { n: 0, score: 0, temp: 0, wind: 0, nw: 0, right: 0, bias: 0 });
    a.n += t.n; a.score += t.score; a.temp += t.temp; a.wind += t.wind || 0; a.nw += t.nw || 0; a.right += t.right; a.bias += t.bias;
  }
  for (const byM of Object.values(allTime.all)) for (const [m, a] of Object.entries(byM))
    byM[m] = { n: a.n, score: r1(a.score / a.n), temp: r1(a.temp / a.n), wind: a.nw ? r1(a.wind / a.nw) : null, rain: Math.round(100 * a.right / a.n), bias: r1(a.bias / a.n) };
  for (const [k, byL] of Object.entries(scores.dayTotals || {})) for (const [L, byM] of Object.entries(byL)) for (const [m, t] of Object.entries(byM)) {
    const day = { n: t.n, hi: r1(t.hi / t.n), lo: r1(t.lo / t.n), qpf: t.nq ? r2(t.qpf / t.nq) : null, rain: Math.round(100 * t.right / t.n) };
    (((allTime.st[k] ||= {})[L] ||= {})[m] ||= { n: 0 }).day = day;
    const a = (((allTime.dayAll ||= {})[L] ||= {})[m] ||= { n: 0, hi: 0, lo: 0, qpf: 0, nq: 0, right: 0 });
    a.n += t.n; a.hi += t.hi; a.lo += t.lo; a.qpf += t.qpf; a.nq += t.nq; a.right += t.right;
  }
  for (const [L, byM] of Object.entries(allTime.dayAll || {})) for (const [m, a] of Object.entries(byM))
    ((allTime.all[L] ||= {})[m] ||= { n: 0 }).day = { n: a.n, hi: r1(a.hi / a.n), lo: r1(a.lo / a.n), qpf: a.nq ? r2(a.qpf / a.nq) : null, rain: Math.round(100 * a.right / a.n) };
  delete allTime.dayAll;
  // Latest checked day per stadium (for "yesterday at each stadium").
  const latest = {};
  for (const d of days) if (!latest[d.st] || d.date > latest[d.st].date) latest[d.st] = { date: d.date, station: d.station, mi: d.mi, obs: d.obs, lead1: Object.fromEntries(Object.entries(d.leads?.["1"] || {}).map(([m, s]) => [m, s.score])) };
  const checked = days.length, since = days.reduce((a, d) => !a || d.date < a ? d.date : a, null);
  return { updated: now, recentDays: RECENT_DAYS, checked, since: scores.since || since, weights, recent, allTime, latest };
}

// ---------- Daily summary of the best blend (for the tab) ----------
function dailySummary(wx, today) {
  const rows = wx.models[BEST] || wx.models.ecmwf_ifs025 || Object.values(wx.models)[0] || [];
  const by = new Map();
  for (const [t, h] of rows) { if (!h) continue; const k = dayKey(t, wx.tz); if (k < today) continue; (by.get(k) || by.set(k, []).get(k)).push([t, h]); }
  return [...by.entries()].slice(0, FORECAST_DAYS).map(([date, hs]) => {
    const win = hs.filter(([t]) => localHour(t, wx.tz) >= 9);
    const nums = (arr, k) => arr.map(([, h]) => h[k]).filter(isNum);
    const sum = (arr, k) => nums(arr, k).reduce((a, b) => a + b, 0);
    const peak = win.reduce((a, x) => (isNum(x[1].wind) && x[1].wind > (a?.[1].wind ?? -1) ? x : a), null);
    const codes = win.map(([, h]) => h.code).filter(isNum);
    const T = nums(hs, "temp");
    return { date, hi: T.length ? Math.round(Math.max(...T)) : null, lo: T.length ? Math.round(Math.min(...T)) : null,
      wind: peak ? Math.round(peak[1].wind) : null, gust: nums(win, "gust").length ? Math.round(Math.max(...nums(win, "gust"))) : null, wdir: peak?.[1].wdir ?? null,
      qpf: r2(sum(hs, "qpf")), snow: r1(sum(hs, "snow")), pop: nums(hs, "pop").length ? Math.round(Math.max(...nums(hs, "pop"))) : null,
      code: codes.length ? Math.max(...codes) : null, partial: hs.length < 20 };
  });
}

// ---------- Main ----------
export async function run({ dataDir, now = Date.now(), log = console.log, stadiums = TRACKED } = {}) {
  const dir = path.join(dataDir, "stadiums");
  const stateFile = path.join(dir, "state.json"), scoresFile = path.join(dir, "scores.json"), skillFile = path.join(dir, "skill.json");
  const state = await readJSON(stateFile, { tz: {}, locked: {}, forecastAt: 0 });
  const scores = await readJSON(scoresFile, { days: [], totals: {} });
  let skill = await readJSON(skillFile, null);
  let changed = false;

  // LOCK + FORECAST
  const forecastDue = now - (state.forecastAt || 0) >= FORECAST_EVERY;
  const fc = forecastDue ? { updated: now, stadiums: {} } : null;
  const locks = new Map();
  const lockFile = date => path.join(dir, "locks", `${date}.json`);
  for (const st of stadiums) {
    const key = stadiumKey(st), tz = state.tz[key];
    const lockDue = !tz || (state.locked[key] !== dayKey(now, tz) && localHour(now, tz) >= LOCK_HOUR);
    if (!lockDue && !forecastDue) continue;
    let wx;
    try { wx = await fetchStadiumWeather(st.lat, st.lon); } catch (e) { log(`forecast failed ${st.name}: ${e.message}`); continue; }
    if (!wx?.tz || !Object.keys(wx.models).length) continue;
    state.tz[key] = wx.tz;
    const today = dayKey(now, wx.tz);
    const W = addBest(wx, skill, key, now);
    if (state.locked[key] !== today && localHour(now, wx.tz) >= LOCK_HOUR) {
      for (const d of LEAD_DAYS) {
        const date = addDays(today, d);
        const slots = DAY_HOURS.map(h => localHourStart(date, h, wx.tz));
        if (!locks.has(date)) locks.set(date, await readJSON(lockFile(date), { date, st: {} }));
        const rec = locks.get(date);
        const s = (rec.st[key] ||= { tz: wx.tz, slots, leads: {} });
        if (s.leads[d]) continue;
        const models = {};
        for (const [m, rows] of Object.entries(wx.models)) {
          const mp = new Map(rows), hs = slots.map(t => mp.get(t));
          if (hs.filter(Boolean).length >= 16) models[m] = pack(hs);
        }
        s.leads[d] = { at: now, models };
      }
      state.locked[key] = today;
      log(`locked ${st.name} (${Object.keys(wx.models).length} forecasts incl. ${W ? "best blend" : "no blend yet"})`);
      changed = true;
    }
    if (fc) fc.stadiums[key] = { name: st.name, tz: wx.tz, blend: !!wx.models[BEST], from: W?.from || null, lead: W?.lead || null, days: dailySummary(wx, today) };
  }
  for (const [date, rec] of locks) await writeJSON(lockFile(date), rec);
  if (fc) { state.forecastAt = now; await writeJSON(path.join(dir, "forecast.json"), fc); changed = true; }

  // VERIFY
  let files = [];
  try { files = (await readdir(path.join(dir, "locks"))).filter(f => f.endsWith(".json")).sort(); } catch {}
  let verified = 0;
  for (const f of files) {
    const rec = await readJSON(path.join(dir, "locks", f), null);
    if (!rec) continue;
    let dirty = false;
    for (const [key, s] of Object.entries(rec.st)) {
      if (s.done) continue;
      const next = addDays(rec.date, 1);
      if (now < localHourStart(next, VERIFY_HOUR, s.tz)) continue;
      const st = stadiums.find(x => stadiumKey(x) === key) || TRACKED.find(x => stadiumKey(x) === key);
      if (!st || now > localHourStart(addDays(rec.date, GIVE_UP_DAYS), 0, s.tz)) { s.done = "gave up"; dirty = true; log(`gave up on ${key} ${rec.date}`); continue; }
      // Older locks held only the game hours (15); new ones hold the whole day (24).
      const full = s.slots.length === 24, g0 = full ? GAME_FROM : 0;
      const fail = e => { log(`observations failed ${key}: ${e.message}`); return null; };
      const ob = await observe(st, s.slots.slice(g0), 10).catch(fail);
      if (!ob) { log(`no observations yet for ${key} ${rec.date}`); continue; }
      const obDay = full ? await observe(st, s.slots, 16).catch(fail) : null;
      const leads = {}, dayLeads = {};
      for (const [L, lk] of Object.entries(s.leads)) {
        const out = {}, dout = {};
        for (const [m, full24] of Object.entries(lk.models)) {
          const p = g0 ? sliceP(full24, g0) : full24;
          if (obDay) { const ds = scoreDay(full24, obDay); if (ds) dout[m] = ds; }
          const sc = scoreModel(p, ob);
          if (!sc) continue;
          out[m] = { score: sc.score, tempMae: sc.tempMae, windMae: sc.windMae, rain: sc.rain, tempBias: sc.tempBias, windBias: sc.windBias };
          const t = (((scores.totals[key] ||= {})[L] ||= {})[m] ||= { n: 0, score: 0, temp: 0, wind: 0, nw: 0, right: 0, bias: 0 });
          t.n++; t.score += sc.score; t.temp += sc.tempMae; t.right += +right(sc.rain); t.bias += sc.tempBias || 0;
          if (isNum(sc.windMae)) { t.wind += sc.windMae; t.nw++; }
        }
        leads[L] = out;
        if (Object.keys(dout).length) dayLeads[L] = dout;
        for (const [m, ds] of Object.entries(dout)) {
          const t = (((scores.dayTotals ||= {})[key] ||= {})[L] ||= {})[m] ||= { n: 0, hi: 0, lo: 0, qpf: 0, nq: 0, right: 0 };
          t.n++; t.hi += Math.abs(ds.hiErr); t.lo += Math.abs(ds.loErr); t.right += +right(ds.rain);
          if (isNum(ds.qpfErr)) { t.qpf += Math.abs(ds.qpfErr); t.nq++; }
        }
      }
      const T = (obDay || ob).temp.filter(isNum), Wd = ob.wind.filter(isNum);
      scores.days = scores.days.filter(d => !(d.st === key && d.date === rec.date));
      scores.days.push({ date: rec.date, st: key, station: ob.station, mi: ob.mi,
        obs: { hi: T.length ? r1(Math.max(...T)) : null, lo: T.length ? r1(Math.min(...T)) : null, wind: Wd.length ? r1(Math.max(...Wd)) : null, gust: ob.gustMax, rained: ob.rained, precip: ob.precip },
        leads, ...(obDay ? { day: { obs: { hi: r1(Math.max(...obDay.temp.filter(isNum))), lo: r1(Math.min(...obDay.temp.filter(isNum))), precip: obDay.precip, rained: obDay.rained }, leads: dayLeads } } : {}) });
      s.done = "verified"; dirty = true; verified++;
      log(`verified ${key} ${rec.date} at ${ob.station}`);
    }
    if (Object.values(rec.st).every(s => s.done)) { await unlink(path.join(dir, "locks", f)).catch(() => {}); changed = true; }
    else if (dirty) { await writeJSON(path.join(dir, "locks", f), rec); changed = true; }
  }
  if (verified || !skill) {
    scores.since ||= scores.days.reduce((a, d) => !a || d.date < a ? d.date : a, null);
    const oldest = addDays(dayKey(now, "UTC"), -KEEP_DAYS);
    scores.days = scores.days.filter(d => d.date >= oldest).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.st < b.st ? -1 : 1);
    scores.updated = now;
    await writeJSON(scoresFile, scores);
    skill = buildSkill(scores, now);
    await writeJSON(skillFile, skill);
    changed = true;
  }
  await writeJSON(stateFile, state);
  return { changed, verified };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  setRequestInit({ headers: { "User-Agent": `weather-compare/1.0 (github.com/${process.env.GITHUB_REPOSITORY || "personal"})`, Accept: "application/geo+json, application/json" } });
  const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
  run({ dataDir }).then(r => console.log(r)).catch(e => { console.error(e); process.exit(1); });
}
