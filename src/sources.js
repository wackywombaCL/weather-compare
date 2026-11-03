// Shared weather-source adapters and helpers.
// Used by the web page (src/app.js) and by the daily accuracy job (scripts/daily.mjs).
// Every adapter returns temperatures in °F and wind in mph:
//   { current, hourly: [{t, temp, pop, cat, night, text, wind}], daily: {"YYYY-MM-DD": {hi, lo, pop, cat, text}}, note, place? }

export const PRESETS = {
  vallejo: { id: "vallejo", name: "Vallejo, CA", lat: 38.1041, lon: -122.2566, tz: "America/Los_Angeles", country: "US" },
  napa:    { id: "napa",    name: "Napa, CA",    lat: 38.2975, lon: -122.2869, tz: "America/Los_Angeles", country: "US" },
};

// Sources still to be added once API keys are in hand.
export const PENDING_SOURCES = [];

// ---------- Request options (the Node job sets a User-Agent; browsers can't) ----------
let requestInit = {};
export function setRequestInit(init) { requestInit = init || {}; }

// ---------- API keys ----------
// The page reads keys saved on the device (Settings); the daily job reads GitHub secrets.
let keyProvider = () => null;
export function setKeyProvider(fn) { keyProvider = fn; }
// Key proxy (Cloudflare Worker, see worker/index.js): used for a keyed source when this device
// has no key of its own for it but has the access code.
let proxy = null;
export function setProxy(p) { proxy = p?.url && p?.code ? { url: p.url.replace(/\/$/, ""), code: p.code } : null; }
export const proxyActive = () => !!proxy;
// Fetch a keyed source: directly with this device's key, or through the proxy.
async function keyedJSON(id, direct, route, params, opts = {}) {
  const k = (keyProvider(id) || "").trim();
  if (k) return getJSON(direct(encodeURIComponent(k)), opts);
  if (proxy) {
    try {
      return await getJSON(`${proxy.url}/v1/${route}?` + new URLSearchParams(params), { ...opts, headers: { "X-Access-Code": proxy.code } });
    } catch (e) {
      if (e.status === 401) throw Object.assign(new Error("Access code was rejected. Check it in ⚙️ Settings."), { friendly: true });
      if (e.status === 501) throw Object.assign(new Error("No key for this source on the server yet"), { friendly: true });
      throw e;
    }
  }
  throw Object.assign(new Error("Needs an API key"), { friendly: true, nokey: true });
}
const ll = loc => ({ lat: (+loc.lat).toFixed(4), lon: (+loc.lon).toFixed(4) });

export async function getJSON(url, { signal, tries = 2, headers } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...requestInit, signal, ...(headers ? { headers: { ...(requestInit.headers || {}), ...headers } } : {}) });
      if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.name === "AbortError" || (e.status && e.status < 500)) break;
      await new Promise(res => setTimeout(res, 800));
    }
  }
  throw lastErr;
}

// ---------- Conditions ----------
export const CAT = {
  clear:   { d: "☀️", n: "🌙", label: "Clear" },
  partly:  { d: "⛅", n: "☁️", label: "Partly cloudy" },
  cloudy:  { d: "☁️", n: "☁️", label: "Cloudy" },
  fog:     { d: "🌫️", n: "🌫️", label: "Fog" },
  haze:    { d: "🌫️", n: "🌫️", label: "Haze / smoke" },
  drizzle: { d: "🌦️", n: "🌧️", label: "Light rain" },
  rain:    { d: "🌧️", n: "🌧️", label: "Rain" },
  sleet:   { d: "🌨️", n: "🌨️", label: "Sleet / ice" },
  snow:    { d: "❄️", n: "❄️", label: "Snow" },
  thunder: { d: "⛈️", n: "⛈️", label: "Thunderstorms" },
};
export const WET = new Set(["drizzle", "rain", "sleet", "snow", "thunder"]);
// "Rain starts" = the first hour showing rain/snow/storms, or a rain chance of at least this much.
// Used by both the page and the accuracy scoring, so they always agree.
export const RAIN_POP = 50;
export const isRainyHour = h => WET.has(h.cat) || (typeof h.pop === "number" && h.pop >= RAIN_POP);
export const icon = (cat, night) => (CAT[cat] || CAT.cloudy)[night ? "n" : "d"];
export const catLabel = (cat, night) => cat === "clear" && !night ? "Sunny" : (CAT[cat] || CAT.cloudy).label;

export function catFromText(s) {
  s = (s || "").toLowerCase();
  if (/thunder|t-storm|tstorm/.test(s)) return "thunder";
  if (/snow|flurr|blizzard/.test(s)) return "snow";
  if (/sleet|freezing|ice|hail/.test(s)) return "sleet";
  if (/drizzle|sprinkle/.test(s)) return "drizzle";
  if (/rain|shower/.test(s)) return "rain";
  if (/fog|mist/.test(s)) return "fog";
  if (/smoke|haze|dust|ash/.test(s)) return "haze";
  if (/partly|mostly sunny|mostly clear|few clouds|scattered clouds/.test(s)) return "partly";
  if (/cloud|overcast/.test(s)) return "cloudy";
  if (/sunny|clear|fair/.test(s)) return "clear";
  return "partly";
}
const WMO = {
  0: ["clear", "Clear sky"], 1: ["partly", "Mainly clear"], 2: ["partly", "Partly cloudy"], 3: ["cloudy", "Overcast"],
  45: ["fog", "Fog"], 48: ["fog", "Freezing fog"],
  51: ["drizzle", "Light drizzle"], 53: ["drizzle", "Drizzle"], 55: ["drizzle", "Heavy drizzle"],
  56: ["sleet", "Freezing drizzle"], 57: ["sleet", "Freezing drizzle"],
  61: ["drizzle", "Light rain"], 63: ["rain", "Rain"], 65: ["rain", "Heavy rain"],
  66: ["sleet", "Freezing rain"], 67: ["sleet", "Freezing rain"],
  71: ["snow", "Light snow"], 73: ["snow", "Snow"], 75: ["snow", "Heavy snow"], 77: ["snow", "Snow grains"],
  80: ["rain", "Rain showers"], 81: ["rain", "Rain showers"], 82: ["rain", "Heavy showers"],
  85: ["snow", "Snow showers"], 86: ["snow", "Snow showers"],
  95: ["thunder", "Thunderstorm"], 96: ["thunder", "Thunderstorm, hail"], 99: ["thunder", "Thunderstorm, hail"],
};
const wmo = code => WMO[code] || ["cloudy", "—"];
export const wmoInfo = code => wmo(code);
function metSymbol(sym) {
  const base = (sym || "").replace(/_(day|night|polartwilight)$/, "");
  const night = /_night$/.test(sym || "");
  let cat;
  if (/thunder/.test(base)) cat = "thunder";
  else if (/snow/.test(base)) cat = "snow";
  else if (/sleet/.test(base)) cat = "sleet";
  else if (/^light(rain|rainshowers)$/.test(base)) cat = "drizzle";
  else if (/rain/.test(base)) cat = "rain";
  else if (base === "fog") cat = "fog";
  else if (base === "clearsky") cat = "clear";
  else if (base === "fair" || base === "partlycloudy") cat = "partly";
  else cat = "cloudy";
  const names = { clearsky: night ? "Clear" : "Sunny", fair: "Fair", partlycloudy: "Partly cloudy", cloudy: "Cloudy", fog: "Fog" };
  const text = names[base] || base.replace(/and/g, " and ").replace(/showers/, " showers").replace(/^(light|heavy)/, "$1 ").replace(/\s+/g, " ").trim().replace(/^./, c => c.toUpperCase());
  return { cat, night, text };
}

// ---------- Utils ----------
export const cToF = c => c == null ? null : c * 9 / 5 + 32;
export const isNum = v => typeof v === "number" && isFinite(v);
export const mean = a => { const v = a.filter(isNum); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
export const mode = a => { const m = {}; let best = null; for (const x of a) if (x) { m[x] = (m[x] || 0) + 1; if (!best || m[x] > m[best]) best = x; } return best; };
export function dayKey(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}
export function localHour(ms, tz) {
  return +new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(ms);
}
// The UTC ms of a given local wall-clock hour on a local date (e.g. 6:00am on 2026-11-03 in Los Angeles).
export function localHourStart(dateKey, hour, tz) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  for (let off = -16; off <= 16; off++) {
    const t = guess + off * 3600e3;
    if (dayKey(t, tz) === dateKey && localHour(t, tz) === hour) return t;
  }
  return null;
}

// Daily rain totals (inches) from hourly amounts, for sources that don't give one per day.
export function addDailyQpf(daily, hourly, tz, { overwrite = false } = {}) {
  const sums = {};
  for (const h of hourly) if (isNum(h.qpf)) sums[dayKey(h.t, tz)] = (sums[dayKey(h.t, tz)] || 0) + h.qpf;
  for (const [k, v] of Object.entries(sums)) if (daily[k] && (overwrite || !isNum(daily[k].qpf))) daily[k].qpf = Math.round(v * 100) / 100;
  return daily;
}
const MM = mm => isNum(mm) ? mm / 25.4 : null;

function dailyFromPoints(points, tz) {
  const byDay = {};
  for (const p of points) (byDay[dayKey(p.t, tz)] ||= []).push(p);
  const out = {};
  for (const [k, pts] of Object.entries(byDay)) {
    const temps = pts.map(p => p.temp).filter(isNum);
    const dayPts = pts.filter(p => { const h = localHour(p.t, tz); return h >= 8 && h <= 18; });
    const pops = pts.map(p => p.pop).filter(isNum);
    out[k] = {
      hi: temps.length ? Math.max(...temps) : null,
      lo: temps.length ? Math.min(...temps) : null,
      pop: pops.length ? Math.max(...pops) : null,
      cat: mode((dayPts.length ? dayPts : pts).map(p => p.cat)),
      partial: false,
    };
  }
  return out;
}

// ---------- Adapters ----------
async function fetchOpenMeteo(loc, signal) {
  const q = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_direction_10m",
    hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
    timezone: loc.tz || "auto", timeformat: "unixtime", forecast_days: "7",
  });
  const j = await getJSON("https://api.open-meteo.com/v1/forecast?" + q, { signal });
  const tz = loc.tz || j.timezone;
  const c = j.current;
  const [ccat, ctext] = wmo(c.weather_code);
  const current = {
    temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m,
    wind: c.wind_speed_10m, windDir: c.wind_direction_10m, cat: ccat, text: ctext, night: c.is_day === 0,
    observedAt: c.time * 1000, kind: "model",
  };
  const h = j.hourly;
  const hourly = h.time.map((t, i) => {
    const [cat, text] = wmo(h.weather_code[i]);
    return { t: t * 1000, temp: h.temperature_2m[i], pop: h.precipitation_probability[i], qpf: h.precipitation?.[i] ?? null, humidity: h.relative_humidity_2m?.[i] ?? null, cat, text, night: h.is_day[i] === 0, wind: h.wind_speed_10m[i] };
  });
  const daily = {};
  j.daily.time.forEach((t, i) => {
    const [cat, text] = wmo(j.daily.weather_code[i]);
    daily[dayKey(t * 1000 + 12 * 3600e3, tz)] = { hi: j.daily.temperature_2m_max[i], lo: j.daily.temperature_2m_min[i], pop: j.daily.precipitation_probability_max[i], qpf: j.daily.precipitation_sum?.[i] ?? null, cat, text };
  });
  return { current, hourly, daily, note: "Blend of global & regional models" };
}

// ---------- Individual forecast models (via Open-Meteo, one request for all four) ----------
export const MODELS = [
  { id: "m_ecmwf", model: "ecmwf_ifs025", name: "ECMWF (European model)", short: "Euro" },
  { id: "m_gfs",   model: "gfs_seamless", name: "GFS (American model)",   short: "GFS" },
  { id: "m_icon",  model: "icon_seamless", name: "ICON (German model)",   short: "ICON" },
  { id: "m_gem",   model: "gem_seamless", name: "GEM (Canadian model)",   short: "GEM" },
];
const modelFetches = new Map();
function fetchModelsOnce(loc, signal) {
  const key = `${(+loc.lat).toFixed(3)},${(+loc.lon).toFixed(3)}`;
  const hit = modelFetches.get(key);
  if (hit && Date.now() - hit.at < 60e3) return hit.p;
  const q = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon, models: MODELS.map(m => m.model).join(","),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_direction_10m",
    hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
    timezone: loc.tz || "auto", timeformat: "unixtime", forecast_days: "7",
  });
  const p = getJSON("https://api.open-meteo.com/v1/forecast?" + q, { signal });
  modelFetches.set(key, { at: Date.now(), p });
  p.catch(() => modelFetches.delete(key));
  return p;
}
// Fill short gaps (some models are 3-hourly further out): temperature interpolated, the rest carried forward.
function fillGaps(hours) {
  for (let i = 0; i < hours.length; i++) {
    if (isNum(hours[i].temp)) continue;
    let a = i - 1, b = i + 1;
    while (b < hours.length && !isNum(hours[b].temp)) b++;
    if (a >= 0 && b < hours.length && b - a <= 6) {
      for (let k = a + 1; k < b; k++) hours[k] = { ...hours[a], t: hours[k].t, temp: hours[a].temp + (hours[b].temp - hours[a].temp) * (k - a) / (b - a), pop: hours[k].pop ?? hours[a].pop };
    }
    i = b - 1;
  }
  return hours.filter(h => isNum(h.temp));
}
function makeModelFetch(m) {
  return async (loc, signal) => {
    const j = await fetchModelsOnce(loc, signal);
    const tz = loc.tz || j.timezone;
    const pick = (block, name) => block?.[`${name}_${m.model}`] ?? block?.[name];
    const c = j.current || {};
    const cCode = pick(c, "weather_code");
    const [ccat, ctext] = wmo(cCode);
    const current = {
      temp: pick(c, "temperature_2m"), feels: pick(c, "apparent_temperature"), humidity: pick(c, "relative_humidity_2m"),
      wind: pick(c, "wind_speed_10m"), windDir: pick(c, "wind_direction_10m"), cat: ccat, text: ctext, night: pick(c, "is_day") === 0,
      observedAt: (c.time || Date.now() / 1000) * 1000, kind: "model",
    };
    const h = j.hourly || {};
    const T = pick(h, "temperature_2m") || [], PP = pick(h, "precipitation_probability") || [], WC = pick(h, "weather_code") || [], WS = pick(h, "wind_speed_10m") || [], QP = pick(h, "precipitation") || [], RH = pick(h, "relative_humidity_2m") || [], DAY = pick(h, "is_day") || h.is_day || [];
    let lastCode = null;
    const hourly = fillGaps((h.time || []).map((t, i) => {
      if (WC[i] != null) lastCode = WC[i];
      const [cat, text] = wmo(WC[i] ?? lastCode);
      return { t: t * 1000, temp: T[i], pop: PP[i] ?? null, qpf: QP[i] ?? null, humidity: RH[i] ?? null, cat, text, night: DAY[i] === 0, wind: WS[i] };
    }));
    if (!hourly.length) throw new Error("model returned no data");
    // With several models in one request, the "current" block is shared, so use each model's own current hour.
    const h0 = [...hourly].reverse().find(x => x.t <= Date.now()) || hourly[0];
    Object.assign(current, { temp: h0.temp, cat: h0.cat, text: h0.text, night: h0.night, wind: h0.wind, observedAt: Date.now() });
    if (!isNum(pick(c, "temperature_2m")) || !(`temperature_2m_${m.model}` in c)) { current.feels = null; current.humidity = null; current.windDir = null; }
    const d = j.daily || {};
    const daily = {};
    (d.time || []).forEach((t, i) => {
      const hi = pick(d, "temperature_2m_max")?.[i], lo = pick(d, "temperature_2m_min")?.[i];
      if (!isNum(hi) && !isNum(lo)) return;
      const [cat, text] = wmo(pick(d, "weather_code")?.[i]);
      daily[dayKey(t * 1000 + 12 * 3600e3, tz)] = { hi, lo, pop: pick(d, "precipitation_probability_max")?.[i] ?? null, qpf: pick(d, "precipitation_sum")?.[i] ?? null, cat, text };
    });
    return { current, hourly, daily, note: `${m.name.split(" (")[0]} model run, via Open-Meteo` };
  };
}

async function fetchNWS(loc, signal) {
  if (loc.country && loc.country !== "US") throw Object.assign(new Error("US locations only"), { friendly: true });
  let pt;
  try {
    pt = await getJSON(`https://api.weather.gov/points/${(+loc.lat).toFixed(4)},${(+loc.lon).toFixed(4)}`, { signal });
  } catch (e) {
    if (e.status === 404) throw Object.assign(new Error("US locations only"), { friendly: true });
    throw e;
  }
  const p = pt.properties;
  const [fc, fh, grid, st] = await Promise.all([
    getJSON(p.forecast, { signal, tries: 3 }),
    getJSON(p.forecastHourly, { signal, tries: 3 }),
    p.forecastGridData ? getJSON(p.forecastGridData, { signal, tries: 2 }).catch(() => null) : null,
    getJSON(p.observationStations, { signal }).catch(() => null),
  ]);
  const tz = loc.tz || p.timeZone;
  const toF = (v, unit) => unit === "C" ? cToF(v) : v;
  const windNum = s => { const n = String(s || "").match(/\d+/g); return n ? Math.max(...n.map(Number)) : null; };

  const hourly = fh.properties.periods.map(x => ({
    t: Date.parse(x.startTime), temp: toF(x.temperature, x.temperatureUnit),
    pop: x.probabilityOfPrecipitation?.value ?? 0, cat: catFromText(x.shortForecast), text: x.shortForecast,
    night: !x.isDaytime, wind: windNum(x.windSpeed), windDir: x.windDirection, humidity: x.relativeHumidity?.value,
  }));
  // Rain amounts: grid data gives totals per block ("2026-11-03T12:00:00+00:00/PT6H"), spread evenly over its hours.
  const qpfByHour = new Map();
  for (const v of grid?.properties?.quantitativePrecipitation?.values || []) {
    const [startS, dur] = String(v.validTime).split("/");
    const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(dur || "");
    const hrs = Math.max(1, (+(m?.[1] || 0)) * 24 + (+(m?.[2] || 0)));
    const start = Date.parse(startS);
    if (!isNum(start) || !isNum(v.value)) continue;
    for (let k = 0; k < hrs; k++) qpfByHour.set(start + k * 3600e3, MM(v.value) / hrs);
  }
  if (qpfByHour.size) for (const h of hourly) h.qpf = qpfByHour.get(h.t) ?? null;

  const daily = {};
  for (const x of fc.properties.periods) {
    const k = dayKey(Date.parse(x.startTime), tz);
    const d = (daily[k] ||= { hi: null, lo: null, pop: null, cat: null, text: null });
    const temp = toF(x.temperature, x.temperatureUnit);
    const pop = x.probabilityOfPrecipitation?.value ?? 0;
    d.pop = Math.max(d.pop ?? 0, pop);
    if (x.isDaytime) { d.hi = temp; d.cat = catFromText(x.shortForecast); d.text = x.shortForecast; }
    else { d.lo = temp; if (!d.cat) { d.cat = catFromText(x.shortForecast); d.text = x.shortForecast; d.nightOnly = true; } }
  }

  addDailyQpf(daily, hourly, tz);

  // Current: latest station observation if fresh, otherwise the current hour of the forecast.
  let current = null;
  try {
    const sid = st?.features?.[0]?.id;
    if (sid) {
      const ob = (await getJSON(sid + "/observations/latest", { signal, tries: 1 })).properties;
      const ts = Date.parse(ob.timestamp);
      if (isNum(ob.temperature?.value) && Date.now() - ts < 3 * 3600e3) {
        const kmh = ob.windSpeed?.value;
        const feelsC = ob.heatIndex?.value ?? ob.windChill?.value ?? ob.temperature.value;
        current = {
          temp: cToF(ob.temperature.value), feels: cToF(feelsC), humidity: ob.relativeHumidity?.value,
          wind: isNum(kmh) ? kmh / 1.609 : null, windDir: ob.windDirection?.value,
          // Some reports have no description: borrow the current hour's forecast wording then.
          ...(ob.textDescription ? { cat: catFromText(ob.textDescription), text: ob.textDescription }
            : (() => { const hh = hourly.find(h => h.t <= Date.now() && Date.now() < h.t + 3600e3) || hourly[0]; return { cat: hh?.cat || "partly", text: hh?.text || "—" }; })()),
          night: hourly[0]?.night ?? false, observedAt: ts, kind: "observed",
          station: st.features[0].properties?.name,
        };
      }
    }
  } catch {}
  if (!current && hourly.length) {
    const h0 = hourly.find(h => h.t <= Date.now() && Date.now() < h.t + 3600e3) || hourly[0];
    current = { temp: h0.temp, feels: null, humidity: h0.humidity, wind: h0.wind, windDir: h0.windDir, cat: h0.cat, text: h0.text, night: h0.night, observedAt: Math.min(Date.now(), Math.max(h0.t, Date.parse(fh.properties.updateTime || fh.properties.generatedAt) || 0)), kind: "forecast" };
  }
  const city = p.relativeLocation?.properties;
  return { current, hourly, daily, place: city ? `${city.city}, ${city.state}` : null, stationsUrl: p.observationStations,
           note: current?.kind === "observed" ? `Observed at ${current.station || "nearest station"}` : "Forecast for this hour" };
}

async function fetchMetNo(loc, signal) {
  const j = await getJSON(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${(+loc.lat).toFixed(4)}&lon=${(+loc.lon).toFixed(4)}`, { signal });
  const tz = loc.tz;
  const pts = j.properties.timeseries.map(e => {
    const d = e.data.instant.details;
    const nx = e.data.next_1_hours || e.data.next_6_hours || e.data.next_12_hours;
    const s = metSymbol(nx?.summary?.symbol_code);
    const pop = nx?.details?.probability_of_precipitation;
    const amt = MM(nx?.details?.precipitation_amount);
    return {
      t: Date.parse(e.time), temp: cToF(d.air_temperature), wind: isNum(d.wind_speed) ? d.wind_speed * 2.23694 : null,
      windDir: d.wind_from_direction, humidity: d.relative_humidity, pop: isNum(pop) ? pop : null,
      cat: s.cat, night: s.night, text: s.text, hourly: !!e.data.next_1_hours,
      qpf: amt, // next 1 hour, or the next 6/12-hour block further out
    };
  });
  const hourly = pts.filter(p => p.hourly);
  const now = Date.now();
  const c = [...pts].reverse().find(p => p.t <= now) || pts[0];
  const current = { temp: c.temp, feels: null, humidity: c.humidity, wind: c.wind, windDir: c.windDir, cat: c.cat, text: c.text, night: c.night, observedAt: Date.parse(j.properties.meta.updated_at), kind: "model" };
  const daily = dailyFromPoints(pts, tz);
  addDailyQpf(daily, pts, tz, { overwrite: true });   // each point's amount covers the period after it
  const today = dayKey(now, tz);
  if (daily[today]) daily[today].partial = true;
  for (const v of Object.values(daily)) v.text = catLabel(v.cat, false);
  return { current, hourly, daily, note: "ECMWF-based model" };
}

// Pirate Weather and Visual Crossing both use Dark Sky-style icon names.
function darkSkyIcon(ic = "", sm = "") {
  let cat;
  if (/thunder/.test(ic)) cat = "thunder";
  else if (ic === "hail" || ic === "sleet") cat = "sleet";
  else if (/snow/.test(ic)) cat = "snow";
  else if (ic === "rain" || /showers/.test(ic)) cat = /drizzle|light rain|possible/i.test(sm) ? "drizzle" : "rain";
  else if (ic === "fog") cat = "fog";
  else if (ic === "cloudy") cat = "cloudy";
  else if (/^partly-cloudy/.test(ic)) cat = "partly";
  else if (/^clear/.test(ic)) cat = "clear";
  else cat = catFromText(sm);
  return { cat, night: /night/.test(ic), text: sm || catLabel(cat) };
}

async function fetchVisualCrossing(loc, signal) {
  const tz = loc.tz;
  const from = dayKey(Date.now(), tz), to = dayKey(Date.now() + 4 * 24 * 3600e3, tz);
  const j = await keyedJSON("visualcrossing", k => `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${(+loc.lat).toFixed(4)},${(+loc.lon).toFixed(4)}/${from}/${to}?unitGroup=us&include=days,hours,current&contentType=json&key=${k}`,
    "visualcrossing", { ...ll(loc), from, to }, { signal, tries: 1 });
  const c = j.currentConditions || {}, cc = darkSkyIcon(c.icon, c.conditions);
  const current = {
    temp: c.temp, feels: c.feelslike, humidity: c.humidity, wind: c.windspeed, windDir: c.winddir,
    cat: cc.cat, text: cc.text, night: cc.night, observedAt: (c.datetimeEpoch || Date.now() / 1000) * 1000, kind: "model",
  };
  const hourly = [], daily = {};
  for (const d of j.days || []) {
    const dv = darkSkyIcon(d.icon, d.conditions);
    daily[d.datetime] = { hi: d.tempmax, lo: d.tempmin, pop: d.precipprob ?? null, qpf: d.precip ?? null, cat: dv.cat, text: dv.text };
    for (const h of d.hours || []) {
      const v = darkSkyIcon(h.icon, h.conditions);
      hourly.push({ t: h.datetimeEpoch * 1000, temp: h.temp, pop: h.precipprob ?? null, qpf: h.precip ?? null, humidity: h.humidity ?? null, cat: v.cat, text: v.text, night: v.night, wind: h.windspeed });
    }
  }
  return { current, hourly, daily, cost: j.queryCost, note: "Visual Crossing's model blend" };
}

// OpenWeatherMap condition ids -> category
function owmCat(id) {
  if (id >= 200 && id < 300) return "thunder";
  if (id >= 300 && id < 400) return "drizzle";
  if (id === 500 || id === 520) return "drizzle";
  if (id === 511) return "sleet";
  if (id >= 500 && id < 600) return "rain";
  if (id >= 611 && id <= 616) return "sleet";
  if (id >= 600 && id < 700) return "snow";
  if (id === 701 || id === 741) return "fog";
  if (id >= 700 && id < 800) return "haze";
  if (id === 800) return "clear";
  if (id === 801 || id === 802) return "partly";
  return "cloudy";
}
async function fetchOWM(loc, signal) {
  const q = k => `lat=${(+loc.lat).toFixed(4)}&lon=${(+loc.lon).toFixed(4)}&units=imperial&appid=${k}`;
  // Free plan: current weather + 5-day forecast in 3-hour steps (two requests).
  const [cw, fc] = await Promise.all([
    keyedJSON("owm", k => `https://api.openweathermap.org/data/2.5/weather?${q(k)}`, "owm/weather", ll(loc), { signal }),
    keyedJSON("owm", k => `https://api.openweathermap.org/data/2.5/forecast?${q(k)}`, "owm/forecast", ll(loc), { signal }),
  ]);
  const tz = loc.tz;
  const w0 = cw.weather?.[0] || {};
  const cap = t => t ? t.charAt(0).toUpperCase() + t.slice(1) : "—";
  const current = {
    temp: cw.main?.temp, feels: cw.main?.feels_like, humidity: cw.main?.humidity, wind: cw.wind?.speed, windDir: cw.wind?.deg,
    cat: owmCat(w0.id), text: cap(w0.description), night: /n$/.test(w0.icon || ""), observedAt: (cw.dt || Date.now() / 1000) * 1000, kind: "model",
  };
  const pts = (fc.list || []).map(x => {
    const w = x.weather?.[0] || {};
    const blk = (x.rain?.["3h"] ?? 0) + (x.snow?.["3h"] ?? 0);
    return { t: x.dt * 1000, temp: x.main?.temp, pop: isNum(x.pop) ? Math.round(x.pop * 100) : null, qpf: MM(blk), humidity: x.main?.humidity ?? null, cat: owmCat(w.id), text: cap(w.description), night: x.sys?.pod === "n", wind: x.wind?.speed };
  }).sort((a, b) => a.t - b.t);
  // The forecast starts at the next 3-hour step; start from current conditions so "now" isn't blank.
  const h0 = Math.floor(Date.now() / 3600e3) * 3600e3;
  if (pts.length && pts[0].t > h0 && isNum(current.temp)) pts.unshift({ t: h0, temp: current.temp, pop: pts[0].pop, cat: current.cat, text: current.text, night: current.night, wind: current.wind });
  // Fill in each hour: temperature interpolated between 3-hour points; conditions and rain chance
  // carried from the 3-hour block the hour falls in.
  const hourly = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const steps = b ? Math.round((b.t - a.t) / 3600e3) : 1;
    for (let k = 0; k < steps; k++) {
      const t = a.t + k * 3600e3;
      const temp = b && isNum(a.temp) && isNum(b.temp) ? a.temp + (b.temp - a.temp) * k / steps : a.temp;
      const h = localHour(t, tz);
      hourly.push({ ...a, t, temp, qpf: isNum(a.qpf) ? a.qpf / Math.max(1, b ? steps : 3) : null, night: k === 0 ? a.night : (h < 7 || h >= 18), interp: k > 0 });
    }
  }
  const daily = dailyFromPoints(hourly, tz);
  addDailyQpf(daily, hourly, tz, { overwrite: true });
  const today = dayKey(Date.now(), tz);
  if (daily[today]) daily[today].partial = true;
  for (const v of Object.values(daily)) v.text = catLabel(v.cat, false);
  return { current, hourly, daily, note: "Forecast in 3-hour steps (hours between are filled in)" };
}

async function fetchPirate(loc, signal) {
  const j = await keyedJSON("pirate", k => `https://api.pirateweather.net/forecast/${k}/${(+loc.lat).toFixed(4)},${(+loc.lon).toFixed(4)}?units=us&extend=hourly&exclude=minutely,alerts`, "pirate", ll(loc), { signal });
  const tz = loc.tz || j.timezone;
  const conv = x => darkSkyIcon(x.icon, x.summary);
  const c = j.currently, cc = conv(c);
  const current = {
    temp: c.temperature, feels: c.apparentTemperature, humidity: isNum(c.humidity) ? c.humidity * 100 : null,
    wind: c.windSpeed, windDir: c.windBearing, cat: cc.cat, text: cc.text, night: cc.night,
    observedAt: c.time * 1000, kind: "model",
  };
  const hourly = (j.hourly?.data || []).map(h => {
    const v = conv(h);
    return { t: h.time * 1000, temp: h.temperature, pop: isNum(h.precipProbability) ? h.precipProbability * 100 : null, qpf: isNum(h.precipIntensity) ? h.precipIntensity : null, humidity: isNum(h.humidity) ? h.humidity * 100 : null, cat: v.cat, text: v.text, night: v.night, wind: h.windSpeed };
  });
  const daily = {};
  for (const d of j.daily?.data || []) {
    const v = conv(d);
    daily[dayKey(d.time * 1000 + 12 * 3600e3, tz)] = {
      hi: d.temperatureMax ?? d.temperatureHigh, lo: d.temperatureMin ?? d.temperatureLow,
      pop: isNum(d.precipProbability) ? d.precipProbability * 100 : null, qpf: isNum(d.precipAccumulation) ? d.precipAccumulation : null, cat: v.cat, text: v.text,
    };
  }
  addDailyQpf(daily, hourly, tz, { overwrite: true });   // hourly rates (in/hr) summed: liquid total
  return { current, hourly, daily, note: "NOAA models (HRRR, NBM, GFS)" };
}

// Tomorrow.io weather codes -> category, label
const TIO = {
  1000: ["clear", "Clear"], 1100: ["partly", "Mostly clear"], 1101: ["partly", "Partly cloudy"], 1102: ["cloudy", "Mostly cloudy"], 1001: ["cloudy", "Cloudy"],
  2000: ["fog", "Fog"], 2100: ["fog", "Light fog"],
  4000: ["drizzle", "Drizzle"], 4200: ["drizzle", "Light rain"], 4001: ["rain", "Rain"], 4201: ["rain", "Heavy rain"],
  5000: ["snow", "Snow"], 5001: ["snow", "Flurries"], 5100: ["snow", "Light snow"], 5101: ["snow", "Heavy snow"],
  6000: ["sleet", "Freezing drizzle"], 6001: ["sleet", "Freezing rain"], 6200: ["sleet", "Light freezing rain"], 6201: ["sleet", "Heavy freezing rain"],
  7000: ["sleet", "Ice pellets"], 7101: ["sleet", "Heavy ice pellets"], 7102: ["sleet", "Light ice pellets"],
  8000: ["thunder", "Thunderstorm"],
};
async function fetchTomorrow(loc, signal) {
  // One request (free plan: 25/hour, 500/day): hourly for the next 5 days plus daily summaries.
  const j = await keyedJSON("tomorrow", k => `https://api.tomorrow.io/v4/weather/forecast?location=${(+loc.lat).toFixed(4)},${(+loc.lon).toFixed(4)}&units=imperial&timesteps=1h,1d&apikey=${k}`, "tomorrow", ll(loc), { signal, tries: 1 });
  const tz = loc.tz;
  const days = j.timelines?.daily || [];
  // Night = outside sunrise..sunset of that local day (Tomorrow's hourly codes have no day/night flag).
  const sun = {};
  for (const d of days) if (d.values?.sunriseTime && d.values?.sunsetTime) sun[dayKey(Date.parse(d.time), tz)] = [Date.parse(d.values.sunriseTime), Date.parse(d.values.sunsetTime)];
  const isNight = t => { const s = sun[dayKey(t, tz)]; if (s) return t < s[0] || t >= s[1]; const h = localHour(t, tz); return h < 7 || h >= 18; };
  const hourly = (j.timelines?.hourly || []).map(h => {
    const v = h.values || {}, t = Date.parse(h.time);
    const [cat, text] = TIO[v.weatherCode] || ["cloudy", "—"];
    const qpf = v.rainAccumulation ?? v.rainIntensity;   // inches (imperial units)
    return { t, temp: v.temperature, pop: v.precipitationProbability ?? null, qpf: isNum(qpf) ? qpf : null, cat, text, night: isNight(t), wind: v.windSpeed, windDir: v.windDirection, humidity: v.humidity, feels: v.temperatureApparent };
  });
  if (!hourly.length) throw new Error("no hourly data");
  const now = Date.now();
  const h0 = [...hourly].reverse().find(h => h.t <= now) || hourly[0];
  const current = { temp: h0.temp, feels: h0.feels, humidity: h0.humidity, wind: h0.wind, windDir: h0.windDir, cat: h0.cat, text: h0.text, night: h0.night, observedAt: now, kind: "model" };
  const daily = {};
  for (const d of days) {
    const v = d.values || {};
    const [cat, text] = TIO[v.weatherCodeMax ?? v.weatherCodeMin] || ["cloudy", "—"];
    daily[dayKey(Date.parse(d.time) + 3 * 3600e3, tz)] = { hi: v.temperatureMax, lo: v.temperatureMin, pop: v.precipitationProbabilityMax ?? v.precipitationProbabilityAvg ?? null, qpf: v.rainAccumulationSum ?? null, cat, text };
  }
  addDailyQpf(daily, hourly, tz, { overwrite: true });   // calendar-day totals from the hourly amounts
  return { current, hourly, daily, note: "Tomorrow.io's own model blend" };
}

async function fetchWeatherAPI(loc, signal) {
  const j = await keyedJSON("weatherapi", k => `https://api.weatherapi.com/v1/forecast.json?key=${k}&q=${(+loc.lat).toFixed(4)},${(+loc.lon).toFixed(4)}&days=5&aqi=no&alerts=no`, "weatherapi", ll(loc), { signal });
  const c = j.current;
  const pop = x => { const v = [x.chance_of_rain, x.chance_of_snow, x.daily_chance_of_rain, x.daily_chance_of_snow].map(Number).filter(isNum); return v.length ? Math.max(...v) : null; };
  const current = {
    temp: c.temp_f, feels: c.feelslike_f, humidity: c.humidity, wind: c.wind_mph, windDir: c.wind_degree,
    cat: catFromText(c.condition?.text), text: c.condition?.text || "—", night: c.is_day === 0,
    observedAt: (c.last_updated_epoch || Date.now() / 1000) * 1000, kind: "model",
  };
  const hourly = [], daily = {};
  for (const fd of j.forecast?.forecastday || []) {
    const d = fd.day || {};
    daily[fd.date] = { hi: d.maxtemp_f, lo: d.mintemp_f, pop: pop(d), qpf: d.totalprecip_in ?? null, cat: catFromText(d.condition?.text), text: d.condition?.text };
    for (const h of fd.hour || []) hourly.push({ t: h.time_epoch * 1000, temp: h.temp_f, pop: pop(h), qpf: h.precip_in ?? null, humidity: h.humidity ?? null, cat: catFromText(h.condition?.text), text: h.condition?.text, night: h.is_day === 0, wind: h.wind_mph });
  }
  return { current, hourly, daily, note: "Free plan: 3-day forecast" };
}

export const SOURCES = [
  { id: "nws",       name: "National Weather Service", short: "NWS",        site: "https://www.weather.gov", fetch: fetchNWS },
  // Open-Meteo's own blend ("openmeteo") was retired: for the US it returned the same numbers as GFS.
  { id: "metno",     name: "MET Norway (Yr)",          short: "Yr",         site: "https://www.yr.no",       color: "var(--s3)", fetch: fetchMetNo },
  { id: "pirate",    name: "Pirate Weather",           short: "Pirate",     site: "https://pirateweather.net", fetch: fetchPirate,
    key: { env: "PIRATE_KEY", signup: "https://pirate-weather.apiable.io" } },
  { id: "tomorrow",  name: "Tomorrow.io",              short: "Tomorrow",   site: "https://www.tomorrow.io", fetch: fetchTomorrow,
    key: { env: "TOMORROW_KEY", signup: "https://app.tomorrow.io/development/keys" } },
  { id: "weatherapi", name: "WeatherAPI.com",          short: "WeatherAPI", site: "https://www.weatherapi.com", fetch: fetchWeatherAPI,
    key: { env: "WEATHERAPI_KEY", signup: "https://www.weatherapi.com/my/" } },
  { id: "visualcrossing", name: "Visual Crossing",     short: "VisualX",    site: "https://www.visualcrossing.com", fetch: fetchVisualCrossing,
    key: { env: "VISUALCROSSING_KEY", signup: "https://www.visualcrossing.com/account" } },
  { id: "owm",       name: "OpenWeatherMap",           short: "OpenWeather", site: "https://openweathermap.org", fetch: fetchOWM,
    key: { env: "OWM_KEY", signup: "https://home.openweathermap.org/api_keys" } },
  ...MODELS.map(m => ({ id: m.id, name: m.name, short: m.short, site: "https://open-meteo.com/en/docs/model-updates", group: "model", fetch: makeModelFetch(m) })),
];
