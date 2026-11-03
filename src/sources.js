// Shared weather-source adapters and helpers.
// Used by the web page (src/app.js) and by the daily accuracy job (scripts/daily.mjs).
// Every adapter returns temperatures in °F and wind in mph:
//   { current, hourly: [{t, temp, pop, cat, night, text, wind}], daily: {"YYYY-MM-DD": {hi, lo, pop, cat, text}}, note, place? }

export const PRESETS = {
  vallejo: { id: "vallejo", name: "Vallejo, CA", lat: 38.1041, lon: -122.2566, tz: "America/Los_Angeles", country: "US" },
  napa:    { id: "napa",    name: "Napa, CA",    lat: 38.2975, lon: -122.2869, tz: "America/Los_Angeles", country: "US" },
};

// Sources still to be added once API keys are in hand.
export const PENDING_SOURCES = ["OpenWeatherMap", "WeatherAPI.com", "Tomorrow.io", "Visual Crossing", "AccuWeather", "Weatherbit", "Pirate Weather"];

// ---------- Request options (the Node job sets a User-Agent; browsers can't) ----------
let requestInit = {};
export function setRequestInit(init) { requestInit = init || {}; }

export async function getJSON(url, { signal, tries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...requestInit, signal });
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
    hourly: "temperature_2m,precipitation_probability,weather_code,wind_speed_10m,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    temperature_unit: "fahrenheit", wind_speed_unit: "mph",
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
    return { t: t * 1000, temp: h.temperature_2m[i], pop: h.precipitation_probability[i], cat, text, night: h.is_day[i] === 0, wind: h.wind_speed_10m[i] };
  });
  const daily = {};
  j.daily.time.forEach((t, i) => {
    const [cat, text] = wmo(j.daily.weather_code[i]);
    daily[dayKey(t * 1000 + 12 * 3600e3, tz)] = { hi: j.daily.temperature_2m_max[i], lo: j.daily.temperature_2m_min[i], pop: j.daily.precipitation_probability_max[i], cat, text };
  });
  return { current, hourly, daily, note: "Blend of global & regional models" };
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
  const [fc, fh, st] = await Promise.all([
    getJSON(p.forecast, { signal, tries: 3 }),
    getJSON(p.forecastHourly, { signal, tries: 3 }),
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
          cat: catFromText(ob.textDescription), text: ob.textDescription || "—",
          night: hourly[0]?.night ?? false, observedAt: ts, kind: "observed",
          station: st.features[0].properties?.name,
        };
      }
    }
  } catch {}
  if (!current && hourly.length) {
    const h0 = hourly.find(h => h.t <= Date.now() && Date.now() < h.t + 3600e3) || hourly[0];
    current = { temp: h0.temp, feels: null, humidity: h0.humidity, wind: h0.wind, windDir: h0.windDir, cat: h0.cat, text: h0.text, night: h0.night, observedAt: Date.parse(fh.properties.updateTime || fh.properties.generatedAt) || Date.now(), kind: "forecast" };
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
    return {
      t: Date.parse(e.time), temp: cToF(d.air_temperature), wind: isNum(d.wind_speed) ? d.wind_speed * 2.23694 : null,
      windDir: d.wind_from_direction, humidity: d.relative_humidity, pop: isNum(pop) ? pop : null,
      cat: s.cat, night: s.night, text: s.text, hourly: !!e.data.next_1_hours,
    };
  });
  const hourly = pts.filter(p => p.hourly);
  const now = Date.now();
  const c = [...pts].reverse().find(p => p.t <= now) || pts[0];
  const current = { temp: c.temp, feels: null, humidity: c.humidity, wind: c.wind, windDir: c.windDir, cat: c.cat, text: c.text, night: c.night, observedAt: Date.parse(j.properties.meta.updated_at), kind: "model" };
  const daily = dailyFromPoints(pts, tz);
  const today = dayKey(now, tz);
  if (daily[today]) daily[today].partial = true;
  for (const v of Object.values(daily)) v.text = catLabel(v.cat, false);
  return { current, hourly, daily, note: "ECMWF-based model" };
}

export const SOURCES = [
  { id: "nws",       name: "National Weather Service", short: "NWS",        site: "https://www.weather.gov", color: "var(--s1)", fetch: fetchNWS },
  { id: "openmeteo", name: "Open-Meteo",               short: "Open-Meteo", site: "https://open-meteo.com",  color: "var(--s2)", fetch: fetchOpenMeteo },
  { id: "metno",     name: "MET Norway (Yr)",          short: "Yr",         site: "https://www.yr.no",       color: "var(--s3)", fetch: fetchMetNo },
];
