// Pieces of the "Best forecast" shared by the app, the phone widget and the 6am tracking job, so
// all three build it the same way:
//   1. each source's temperatures are corrected for its own recent habit of running warm or cold
//      (hour by hour, and for the day's high and low), from the last 14 checked days;
//   2. the corrected sources are blended, weighted toward whichever has been most accurate at
//      each part of the forecast (src/skill.js);
//   3. the next few hours are nudged toward what the stations are reading right now.
import { isNum, isRainyHour, mode, localHour, localHourStart, dayKey } from "./sources.js";
import { elementSkill, elementWeights, PSEUDO } from "./skill.js";

const H = 3600e3;
export const SET_HOUR = 6;          // forecasts are locked at 6am local for 6am → 6am windows
export const BIAS_DAYS = 14;        // days of results behind each correction
export const BIAS_MIN_DAYS = 3;     // a source needs this many checked days before it is corrected
const BIAS_MAX = 8;                 // never correct by more than this many °F
export const NUDGE_HOURS = 3;       // the "right now" nudge fades by ~63% every this many hours
const NUDGE_MAX = 8;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = v => Math.round(v * 10) / 10;

// ---------- 1. Bias table (made by the daily job, saved in data/scores.json as `bias`) ----------
// days: scored days. forecastOf(day, id) → that source's forecast temperatures lined up with
// day.obs.hours (hour 0 = 6am), or null. Returns { loc: { lead: { id: { h: [24], hi, lo, n } } } }:
// how many °F each source has run warm (+) or cold (−) at each hour of the window, and for the
// high and low. Averages are pulled slightly toward zero so a few odd days can't dominate.
export function computeBias(days, forecastOf) {
  const out = {};
  const groups = {};
  for (const d of days) if (!d.partial && d.obs?.hours) (groups[`${d.loc}|${d.lead ?? 0}`] ||= []).push(d);
  for (const [key, all] of Object.entries(groups)) {
    const [loc, lead] = key.split("|");
    const dates = [...new Set(all.map(d => d.date))].sort().slice(-BIAS_DAYS);
    const use = all.filter(d => dates.includes(d.date));
    const ids = new Set(use.flatMap(d => Object.keys(d.src || {})));
    for (const id of ids) {
      if (PSEUDO.has(id)) continue;
      const diffs = Array.from({ length: 24 }, () => []), hi = [], lo = [];
      let n = 0;
      for (const d of use) {
        const s = d.src[id];
        if (!s?.ok) continue;
        const f = forecastOf(d, id);
        if (f) { n++; f.forEach((v, k) => { if (k < 24 && isNum(v) && isNum(d.obs.hours[k])) diffs[k].push(v - d.obs.hours[k]); }); }
        if (isNum(s.hiErr)) hi.push(s.hiErr);
        if (isNum(s.loErr)) lo.push(s.loErr);
      }
      const shrunk = a => a.length >= BIAS_MIN_DAYS ? clamp(a.reduce((x, y) => x + y, 0) / (a.length + 1), -BIAS_MAX, BIAS_MAX) : null;
      let h = diffs.map(shrunk);
      if (h.filter(isNum).length < 18 && !isNum(shrunk(hi))) continue;
      // Light smoothing across neighbouring hours (wrapping around the day).
      const filled = h.map(v => v ?? 0);
      h = filled.map((v, k) => r1((filled[(k + 23) % 24] + 2 * v + filled[(k + 1) % 24]) / 4));
      ((out[loc] ||= {})[lead] ||= {})[id] = { h, hi: isNum(shrunk(hi)) ? r1(shrunk(hi)) : 0, lo: isNum(shrunk(lo)) ? r1(shrunk(lo)) : 0, n: Math.max(n, hi.length) };
    }
  }
  return out;
}

// Which locked window an hour falls in, as seen from `now`: 0 = today's (6am → 6am), 1, 2.
export function leadOf(t, now, tz) {
  const start = localHourStart(dayKey(now - SET_HOUR * H, tz), SET_HOUR, tz);
  return clamp(Math.floor((t - start) / (24 * H)), 0, 2);
}
// Lookups into the bias table for one town. Everything returns 0 when there is nothing to correct.
export function biasFor(bias, locId) {
  const T = bias?.table?.[locId] || bias?.[locId] || null;
  const get = (id, lead) => T?.[Math.min(2, Math.max(0, lead))]?.[id] || null;
  return {
    any: !!T,
    hour: (id, lead, t, tz) => get(id, lead)?.h?.[(localHour(t, tz) - SET_HOUR + 24) % 24] ?? 0,
    hi: (id, lead) => get(id, lead)?.hi ?? 0,
    lo: (id, lead) => get(id, lead)?.lo ?? 0,
  };
}

// ---------- 2. Weights ----------
// W(lead, element) → { id: weight } or null, from the last 14 checked days at that range.
export function weightsBy(days, { locs, ids }) {
  const sk = [0, 1, 2].map(L => days ? elementSkill(days, { locs, lead: L, n: 14 }).skill : null);
  const W = (lead, el) => sk[0] ? (elementWeights(sk[Math.min(2, Math.max(0, lead))], el, ids) || elementWeights(sk[0], el, ids)) : null;
  W.skill = sk;
  return W;
}
export function wmean(pairs, w) {   // pairs: [[id, value]]
  const v = pairs.filter(([, x]) => isNum(x));
  if (!v.length) return null;
  const ws = v.map(([id]) => w ? w[id] ?? 0 : 1), tw = ws.reduce((a, b) => a + b, 0);
  return tw ? v.reduce((s, [, x], i) => s + x * ws[i], 0) / tw : v.reduce((s, [, x]) => s + x, 0) / v.length;
}

// ---------- 3. Hour-by-hour Best forecast ----------
// hourly: { id: Map(t → hour) }. Returns one blended hour per time in `times` (null where no
// source has data): temperature bias-corrected and weighted by hourly-temperature skill, rain
// chance / amount / wind / humidity each weighted by their own skill.
export function bestHours(hourly, times, { W, bias, tz, now = Date.now() }) {
  const ids = Object.keys(hourly);
  return times.map(t => {
    const L = leadOf(t, now, tz);
    const hs = ids.map(id => [id, hourly[id].get(t)]).filter(([, h]) => h && isNum(h.temp));
    if (!hs.length) return null;
    const wt = W(L, "temp"), wr = W(L, "rain");
    const wet = wmean(hs.map(([id, h]) => [id, isRainyHour(h) ? 1 : 0]), W(L, "timing") || wr) ?? 0;
    return {
      t, temp: wmean(hs.map(([id, h]) => [id, h.temp - (bias?.hour(id, L, t, tz) ?? 0)]), wt),
      pop: wmean(hs.map(([id, h]) => [id, h.pop]), wr), qpf: wmean(hs.map(([id, h]) => [id, h.qpf]), W(L, "amount") || wr),
      wind: wmean(hs.map(([id, h]) => [id, h.wind]), W(L, "wind")), humidity: wmean(hs.map(([id, h]) => [id, h.humidity]), W(L, "humidity")),
      cat: wet >= 0.5 ? "rain" : mode(hs.map(([, h]) => h.cat)), night: hs[0][1].night, n: hs.length,
    };
  });
}

// ---------- 4. "Right now" nudge ----------
// rows: blended hours (sorted). obs: { temp, at }. Shifts the hours from the observation onward
// toward what the stations read, fading out over the next few hours. Returns { rows, delta }.
export function nudge(rows, obs) {
  const ok = rows.filter(r => r && isNum(r.temp));
  if (!obs || !isNum(obs.temp) || ok.length < 2) return { rows, delta: null };
  // The blend's value at the moment of the observation (straight line between the two hours).
  const a = [...ok].reverse().find(r => r.t <= obs.at), b = ok.find(r => r.t > obs.at);
  if (!a && !b) return { rows, delta: null };
  if ((a && obs.at - a.t > 2 * H) || (!a && b.t - obs.at > H)) return { rows, delta: null };
  const at = a && b ? a.temp + (b.temp - a.temp) * (obs.at - a.t) / (b.t - a.t) : (a || b).temp;
  const delta = clamp(obs.temp - at, -NUDGE_MAX, NUDGE_MAX);
  const adj = t => delta * Math.exp(-Math.max(0, t - obs.at) / (NUDGE_HOURS * H));
  return { delta: r1(delta), adj, rows: rows.map(r => r && isNum(r.temp) && r.t >= obs.at - H ? { ...r, temp: r.temp + adj(r.t) } : r) };
}
