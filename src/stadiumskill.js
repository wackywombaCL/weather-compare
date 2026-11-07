// "Best blend" for NFL stadiums, shared by the daily stadium job (scripts/stadiums.mjs), the NFL
// game lock-ins (scripts/nfl-verify.mjs), the NFL alerts and the NFL / Stadiums tabs.
//
// Every day each outdoor stadium's forecast (9am–midnight local) is locked from each model at
// 0–3 days ahead and checked against the nearest official station the next day. From the last
// 14 checked days, separately for temperature, wind and rain, each model gets a weight: the
// most accurate counts most, the others fade out the further behind they are. Temperatures are
// also corrected for each model's recent warm/cold bias at that stadium.
import { isNum, dayKey } from "./sources.js";

export const LEAD_DAYS = [0, 1, 2, 3];
export const RECENT_DAYS = 14;     // days of results that set the weights
export const MIN_DAYS = 3;         // a stadium needs this many checked days to use its own weights
export const BIAS_MIN_DAYS = 5;    // ...and this many to correct temperature bias
export const BEST = "best";        // id of the blend in forecast files and scores
// How fast weight drops off behind the leader (per °F, per mph, per share of rain calls).
const FADE = { temp: 1.0, wind: 1.5, rain: 0.15 };
const r3 = v => Math.round(v * 1000) / 1000, r1 = v => Math.round(v * 10) / 10;
const avg = a => { const v = a.filter(isNum); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
const right = r => r === "hit" || r === "none";

// rows: [{ date, st, leads: { "0": { model: { tempMae, windMae, rain, tempBias } } } }] (newest last).
// Returns { n, temp: {m: w}, wind: {m: w}, rain: {m: w}, bias: {m: °F}, lead: {temp, wind, rain} }.
export function weightsFrom(rows, lead, { bias = true } = {}) {
  const per = {};
  for (const r of rows) for (const [m, s] of Object.entries(r.leads?.[lead] || {})) {
    if (m === BEST || !s) continue;
    (per[m] ||= []).push(s);
  }
  const n = Math.max(0, ...Object.values(per).map(a => a.length));
  const out = { n, temp: {}, wind: {}, rain: {}, bias: {}, lead: {} };
  if (!n) return out;
  const stat = {
    temp: m => avg(per[m].map(s => s.tempMae)),
    wind: m => avg(per[m].map(s => s.windMae)),
    rain: m => avg(per[m].map(s => s.rain ? +right(s.rain) : null)),
  };
  for (const el of ["temp", "wind", "rain"]) {
    const vals = Object.keys(per).filter(m => per[m].length >= Math.min(MIN_DAYS, n)).map(m => [m, stat[el](m)]).filter(([, v]) => isNum(v));
    if (!vals.length) continue;
    const better = el === "rain" ? (a, b) => b - a : (a, b) => a - b;
    vals.sort((a, b) => better(a[1], b[1]));
    const best = vals[0][1];
    const raw = vals.map(([m, v]) => [m, Math.exp(-Math.abs(v - best) / FADE[el])]).filter(([, w]) => w >= 0.05);
    const tot = raw.reduce((s, [, w]) => s + w, 0);
    out[el] = Object.fromEntries(raw.map(([m, w]) => [m, r3(w / tot)]));
    out.lead[el] = vals[0][0];
  }
  if (bias) for (const m of Object.keys(per)) {
    const b = per[m].map(s => s.tempBias).filter(isNum);
    if (b.length >= BIAS_MIN_DAYS) out.bias[m] = r1(Math.max(-5, Math.min(5, avg(b))));
  }
  return out;
}

// Weights for one stadium at one lead (days ahead). Falls back to all stadiums pooled together
// (no bias correction) until the stadium has a few checked days of its own.
export function weightsFor(skill, key, lead) {
  const L = String(Math.max(0, Math.min(3, lead)));
  const own = skill?.weights?.st?.[key]?.[L];
  if (own?.n >= MIN_DAYS) return { ...own, from: "stadium" };
  const all = skill?.weights?.all?.[L];
  if (all?.n >= MIN_DAYS) return { ...all, bias: {}, from: "all" };
  return null;
}

// Weighted average of one value across models; falls back to an equal average.
function wavg(hours, w, k, adj = () => 0) {
  let s = 0, t = 0;
  for (const [m, h] of hours) if (isNum(h?.[k]) && w?.[m]) { s += w[m] * (h[k] - adj(m)); t += w[m]; }
  if (t > 0) return s / t;
  const v = hours.map(([m, h]) => isNum(h?.[k]) ? h[k] - adj(m) : null).filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
const top = w => Object.entries(w || {}).sort((a, b) => b[1] - a[1])[0]?.[0];

// One blended hour from each model's hour at the same time.
export function blendHour(byModel, W) {
  const hours = Object.entries(byModel).filter(([m, h]) => m !== BEST && h);
  if (!hours.length) return null;
  const get = m => byModel[m];
  const b = m => W.bias?.[m] || 0;
  const temp = wavg(hours, W.temp, "temp", b);
  const feelsGap = wavg(hours.map(([m, h]) => [m, { g: isNum(h.feels) && isNum(h.temp) ? h.feels - h.temp : null }]), W.temp, "g");
  const qpf = wavg(hours, W.rain, "qpf"), snow = wavg(hours, W.rain, "snow"), pop = wavg(hours, W.rain, "pop");
  const rainLead = [top(W.rain), ...hours.map(([m]) => m)].find(m => get(m)), windLead = [top(W.wind), ...hours.map(([m]) => m)].find(m => isNum(get(m)?.wdir));
  let code = get(rainLead)?.code ?? null;
  if (code >= 51 && (qpf ?? 0) < 0.01 && (snow ?? 0) < 0.05 && (pop ?? 0) < 40) code = 3;   // leader shows rain but the blend is dry
  return {
    temp, feels: isNum(temp) && isNum(feelsGap) ? temp + feelsGap : null, qpf, snow, pop, code,
    wind: wavg(hours, W.wind, "wind"), gust: wavg(hours, W.wind, "gust"), wdir: windLead ? get(windLead).wdir : null,
    rh: wavg(hours, W.temp, "rh"), vis: wavg(hours, W.rain, "vis"),
  };
}

// Adds a "best" model to a stadium forecast (from fetchStadiumWeather). Each hour uses the
// weights for how many days ahead it is. Returns the weights used for tomorrow (for labels), or null.
export function addBest(wx, skill, key, now = Date.now()) {
  if (!wx?.models || !skill) return null;
  const maps = Object.entries(wx.models).filter(([m]) => m !== BEST).map(([m, rows]) => [m, new Map(rows)]);
  if (maps.length < 2) return null;
  const today = dayKey(now, wx.tz);
  const daysAhead = t => Math.round((Date.parse(dayKey(t, wx.tz)) - Date.parse(today)) / 864e5);
  const cache = {};
  const Wfor = d => (cache[d] ??= weightsFor(skill, key, d));
  if (!Wfor(1) && !Wfor(0)) return null;
  const times = [...new Set(maps.flatMap(([, mp]) => [...mp.keys()]))].sort((a, b) => a - b);
  wx.models[BEST] = times.map(t => {
    const W = Wfor(daysAhead(t)) || Wfor(1) || Wfor(0);
    return [t, blendHour(Object.fromEntries(maps.map(([m, mp]) => [m, mp.get(t)])), W)];
  }).filter(([, h]) => h);
  return Wfor(1) || Wfor(0);
}
