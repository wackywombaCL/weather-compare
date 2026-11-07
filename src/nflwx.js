// Game-weather logic shared by the NFL tab (src/nfl.js) and the NFL phone alerts
// (scripts/nfl-alerts.mjs): stadium forecasts from several models, what gets flagged, how
// closely the models agree, and how the wind lines up with the field.
import { getJSON, isNum } from "./sources.js";

export const H = 3600e3;
export const NFL_MODELS = ["best_match", "ecmwf_ifs025", "gfs_seamless", "icon_seamless", "gem_seamless"];
export const MODEL_NAMES = { best: "Best blend", best_match: "Open-Meteo blend", ecmwf_ifs025: "Euro", gfs_seamless: "GFS", icon_seamless: "ICON", gem_seamless: "GEM" };
// Thresholds. "sig" = significant impact (red; triggers phone alerts), "note" = worth knowing (yellow).
export const LIMITS = {
  rain:  { note: 0.05, sig: 0.30, rateSig: 0.15 },   // inches over the 5 hours / in any one hour
  snow:  { note: 0.1,  sig: 1.0 },                   // inches of snow
  wind:  { note: 15,   sig: 20, gustNote: 25, gustSig: 35 },   // mph
  cold:  { note: 32,   sig: 15 },                    // feels-like °F
  heat:  { note: 90,   sig: 100 },                   // feels-like °F
  fog:   { note: 1600, sig: 400 },                   // visibility, metres (~1 mile / ~1/4 mile)
  field: { note: 0.5,  sig: 1.25 },                  // rain (in) in the 48 h before kickoff
};
const VARS = "temperature_2m,apparent_temperature,precipitation,precipitation_probability,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,visibility";

// One request for all models. Returns plain arrays (safe to cache as JSON):
// { tz, models: { model: [[t, {temp, feels, qpf, pop, snow, code, wind, gust, wdir, rh, vis}], ...] } }
export async function fetchStadiumWeather(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: "auto", timeformat: "unixtime", past_days: "3", forecast_days: "10",
    temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
    hourly: VARS, models: NFL_MODELS.join(","),
  });
  const j = await getJSON("https://api.open-meteo.com/v1/forecast?" + q, { tries: 2 });
  const h = j.hourly || {};
  const pick = (name, m) => h[`${name}_${m}`] ?? (m === "best_match" ? h[name] : undefined);
  const models = {};
  for (const m of NFL_MODELS) {
    const T = pick("temperature_2m", m);
    if (!T || !T.some(isNum)) continue;
    const col = n => pick(n, m) || [];
    const [F, Q, P, S, C, W, G, D, RH, V] = ["apparent_temperature", "precipitation", "precipitation_probability", "snowfall", "weather_code", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "relative_humidity_2m", "visibility"].map(col);
    models[m] = (h.time || []).map((t, i) => [t * 1000, { temp: T[i], feels: F[i], qpf: Q[i], pop: P[i], snow: S[i], code: C[i], wind: W[i], gust: G[i], wdir: D[i], rh: RH[i], vis: V[i] }]);
  }
  return { tz: j.timezone, models };
}

// The 5 forecast hours for a game: 1 h before kickoff, the 3-hour game, 1 h for overtime.
export const gameSlots = kick => { const h0 = Math.floor(kick / H) * H - H; return [0, 1, 2, 3, 4].map(i => h0 + i * H); };
export function gameWeather(wx, kick) {
  const slots = gameSlots(kick);
  // Main line: the stadium's best blend (from daily tracking) when there is one.
  const main = new Map(wx.models.best || wx.models.best_match || Object.values(wx.models)[0] || []);
  const win = slots.map(t => main.get(t));
  const before = Array.from({ length: 48 }, (_, i) => main.get(slots[0] - (i + 1) * H));
  const byModel = Object.fromEntries(Object.entries(wx.models).map(([m, rows]) => { const mp = new Map(rows); return [m, slots.map(t => mp.get(t))]; }));
  return { slots, win, before, byModel };
}

// ---------- Wind vs. the field ----------
const WORDS8 = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = d => isNum(d) ? COMPASS16[Math.round(((d % 360) + 360) % 360 / 22.5) % 16] : "";
const word8 = d => WORDS8[Math.round(((d % 360) + 360) % 360 / 45) % 8];
// axis: compass bearing (0–180) of the line between the end zones. windFrom: direction the wind comes from.
export function windVsField(axis, windFrom) {
  if (!isNum(axis) || !isNum(windFrom)) return null;
  const toward = (windFrom + 180) % 360;
  const off = Math.abs(((toward - axis) % 180 + 180 + 90) % 180 - 90);   // 0 = straight down the field, 90 = across
  if (off >= 60) return { kind: "cross", text: "crosswind" };
  const ends = [axis, (axis + 180) % 360];
  const gap = e => Math.abs(((toward - e + 540) % 360) - 180);   // angle between the wind's heading and an end zone
  const end = gap(ends[0]) <= gap(ends[1]) ? ends[0] : ends[1];
  if (off <= 30) return { kind: "along", text: `blowing toward the ${word8(end)} end zone` };
  return { kind: "quarter", text: `quartering wind toward the ${word8(end)} end` };
}
export const fieldRuns = axis => { if (!isNum(axis)) return null; const a = axis > 112.5 ? axis - 180 : axis; return `${word8(a)}–${word8(a + 180)}`; };

// ---------- Flags ----------
export function flagsFor(win, before, stadium = {}) {
  const f = [];
  const hs = win.filter(Boolean);
  if (!hs.length) return f;
  const sum = (arr, k) => arr.reduce((s, h) => s + (isNum(h?.[k]) ? h[k] : 0), 0);
  const max = (arr, k) => Math.max(...arr.map(h => isNum(h?.[k]) ? h[k] : -Infinity));
  const min = (arr, k) => Math.min(...arr.map(h => isNum(h?.[k]) ? h[k] : Infinity));
  const snow = sum(hs, "snow"), rain = Math.max(0, sum(hs, "qpf") - snow / 10), rate = max(hs, "qpf");
  const wind = max(hs, "wind"), gust = max(hs, "gust"), cold = min(hs, "feels"), heat = max(hs, "feels"), vis = min(hs, "vis");
  if (hs.some(h => h.code >= 95)) f.push({ lvl: "sig", ic: "⛈️", t: "Thunderstorms: lightning delays possible" });
  if (snow >= LIMITS.snow.sig) f.push({ lvl: "sig", ic: "❄️", t: `Snow: ${snow.toFixed(1)} in during the game` });
  else if (snow >= LIMITS.snow.note) f.push({ lvl: "note", ic: "❄️", t: `Some snow (${snow.toFixed(1)} in)` });
  if (rain >= LIMITS.rain.sig || rate >= LIMITS.rain.rateSig) f.push({ lvl: "sig", ic: "🌧️", t: `Heavy rain: ${rain.toFixed(2)} in during the game` });
  else if (rain >= LIMITS.rain.note) f.push({ lvl: "note", ic: "🌦️", t: `Rain: ${rain.toFixed(2)} in during the game` });
  const windy = wind >= LIMITS.wind.note || gust >= LIMITS.wind.gustNote;
  if (windy) {
    const peak = hs.reduce((a, h) => (isNum(h.wind) && h.wind > (a?.wind ?? -1) ? h : a), null);
    const rel = windVsField(stadium.axis, peak?.wdir);
    const sig = wind >= LIMITS.wind.sig || gust >= LIMITS.wind.gustSig;
    f.push({ lvl: sig ? "sig" : "note", ic: "💨", t: `${sig ? "Strong wind" : "Windy"}: ${Math.round(wind)} mph, gusts ${Math.round(gust)} from the ${compass(peak?.wdir)}${rel ? ` (${rel.text})` : ""}` });
  }
  if (cold <= LIMITS.cold.sig) f.push({ lvl: "sig", ic: "🥶", t: `Frigid: feels like ${Math.round(cold)}°` });
  else if (cold <= LIMITS.cold.note) f.push({ lvl: "note", ic: "🥶", t: `Cold: feels like ${Math.round(cold)}°` });
  if (heat >= LIMITS.heat.sig) f.push({ lvl: "sig", ic: "🥵", t: `Extreme heat: feels like ${Math.round(heat)}°` });
  else if (heat >= LIMITS.heat.note) f.push({ lvl: "note", ic: "🥵", t: `Hot: feels like ${Math.round(heat)}°` });
  if (isFinite(vis) && vis <= LIMITS.fog.sig) f.push({ lvl: "sig", ic: "🌫️", t: "Dense fog: visibility under ¼ mile" });
  else if (isFinite(vis) && vis <= LIMITS.fog.note) f.push({ lvl: "note", ic: "🌫️", t: "Fog: visibility under 1 mile" });
  const b = before.filter(Boolean), wet = sum(b, "qpf"), snowBefore = sum(b, "snow");
  if (snowBefore >= 2) f.push({ lvl: "sig", ic: "🧹", t: `${snowBefore.toFixed(0)} in of snow in the 48 h before: field and footing affected` });
  else if (wet >= LIMITS.field.note) {
    const lvl = wet >= LIMITS.field.sig && stadium.surface !== "turf" ? "sig" : "note";
    f.push({ lvl, ic: "🟫", t: `${wet.toFixed(2)} in of rain in the 48 h before kickoff${stadium.surface === "grass" ? ": grass field may be soft or muddy" : stadium.surface === "turf" ? " (turf drains well)" : ""}` });
  }
  return f.sort((a, b) => (a.lvl === "sig" ? 0 : 1) - (b.lvl === "sig" ? 0 : 1));
}

// ---------- How closely the models agree ----------
export function modelAgreement(byModel) {
  const per = Object.entries(byModel).filter(([m]) => m !== "best").map(([m, hs]) => {
    const v = hs.filter(Boolean);
    if (!v.length) return null;
    const nums = k => v.map(h => h[k]).filter(isNum);
    return { m, wind: Math.max(...nums("wind"), 0), temp: nums("temp").reduce((a, b) => a + b, 0) / Math.max(1, nums("temp").length),
      rain: nums("qpf").reduce((a, b) => a + b, 0), snow: nums("snow").reduce((a, b) => a + b, 0), storm: v.some(h => h.code >= 95) };
  }).filter(Boolean);
  if (per.length < 3) return null;
  const rng = k => [Math.min(...per.map(p => p[k])), Math.max(...per.map(p => p[k]))];
  const [w0, w1] = rng("wind"), [t0, t1] = rng("temp");
  const wetN = per.filter(p => p.rain >= LIMITS.rain.note || p.snow >= LIMITS.snow.note).length, n = per.length;
  const grade = (spread, hi, med) => spread <= hi ? 2 : spread <= med ? 1 : 0;
  const scores = [grade(w1 - w0, 5, 10), grade(t1 - t0, 4, 8), wetN === 0 || wetN === n ? 2 : Math.abs(wetN - n / 2) >= n / 2 - 1 ? 1 : 0];
  const lvl = Math.min(...scores);
  return {
    level: ["Low", "Medium", "High"][lvl], n,
    notes: [`wind ${Math.round(w0)}–${Math.round(w1)} mph`, `temps ${Math.round(t0)}–${Math.round(t1)}°`, `rain or snow in ${wetN} of ${n} models`],
  };
}
