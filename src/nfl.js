// NFL tab: this week's outdoor games with a 5-hour stadium forecast (1 h before kickoff, the
// 3-hour game, 1 h extra for overtime), highlighting rain, snow, wind, cold/heat, lightning
// and fog, plus how much rain fell in the 48 hours before (field conditions).
// Schedule: data/nfl.json (from ESPN, refreshed by a GitHub job). Forecasts: Open-Meteo.
import { $, esc, store, T, R } from "./app.js";
import { findStadium } from "./stadiums.js";
import { icon, wmoInfo, getJSON, isNum } from "./sources.js";

const RAW = "https://raw.githubusercontent.com/wackywombaCL/weather-compare/main/data/nfl.json";
const MY_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const H = 3600e3;
// Thresholds for highlighting. "sig" = significant impact, "note" = worth knowing.
const LIMITS = {
  rain:  { note: 0.05, sig: 0.30, rateSig: 0.15 },   // inches over the 5 hours / in any hour
  snow:  { note: 0.1,  sig: 1.0 },                   // inches of snow
  wind:  { note: 15,   sig: 20, gustNote: 25, gustSig: 35 },   // mph
  cold:  { note: 32,   sig: 15 },                    // feels-like °F
  heat:  { note: 90,   sig: 100 },                   // feels-like °F
  fog:   { note: 1600, sig: 400 },                   // visibility, meters (~1 mile / ~¼ mile)
  field: { note: 0.5,  sig: 1.25 },                  // rain (in) in the 48 h before kickoff
};
let loaded = null;

const fmt = (ms, tz, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(ms);
const hourLbl = (ms, tz) => fmt(ms, tz, { hour: "numeric" }).replace(" ", "").toLowerCase();
const kickLbl = (ms, tz) => fmt(ms, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/ (AM|PM)/, (m, x) => x.toLowerCase());
const tzAbbr = (ms, tz) => (fmt(ms, tz, { timeZoneName: "short" }).split(" ").pop());
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const dir = d => isNum(d) ? COMPASS[Math.round(d / 22.5) % 16] : "";
const mph = v => !isNum(v) ? "—" : Math.round(v);

async function loadSchedule() {
  const bust = "?t=" + Math.floor(Date.now() / 300000);
  for (const url of [RAW + bust, "data/nfl.json" + bust]) {
    try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return await r.json(); } catch {}
  }
  return null;
}

async function venueFor(g) {
  const st = findStadium(g.venue?.name);
  if (st) return st;
  // Unknown venue (e.g. a new international site): place it by city, roof from ESPN.
  try {
    const q = encodeURIComponent(g.venue?.city || "");
    const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${q}`, { tries: 1 });
    const r = j.results?.[0];
    if (r) return { name: g.venue.name, lat: r.latitude, lon: r.longitude, roof: g.venue.indoor ? "dome" : "open", surface: g.venue.grass == null ? null : g.venue.grass ? "grass" : "turf" };
  } catch {}
  return { name: g.venue?.name || "Unknown stadium", roof: g.venue?.indoor ? "dome" : "unknown" };
}

async function weatherFor(v) {
  const key = `wc.nflwx.${v.lat.toFixed(2)},${v.lon.toFixed(2)}`;
  const hit = store.get(key, null);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.data;
  const q = new URLSearchParams({
    latitude: v.lat, longitude: v.lon, timezone: "auto", timeformat: "unixtime", past_days: "3", forecast_days: "10",
    temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
    hourly: "temperature_2m,apparent_temperature,precipitation,precipitation_probability,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,visibility",
  });
  const j = await getJSON("https://api.open-meteo.com/v1/forecast?" + q, { tries: 2 });
  const h = j.hourly, hours = new Map();
  h.time.forEach((t, i) => hours.set(t * 1000, {
    temp: h.temperature_2m[i], feels: h.apparent_temperature[i], qpf: h.precipitation[i], pop: h.precipitation_probability[i], snow: h.snowfall[i],
    code: h.weather_code[i], wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], wdir: h.wind_direction_10m[i], rh: h.relative_humidity_2m[i], vis: h.visibility?.[i],
  }));
  const data = { tz: j.timezone, hours: [...hours.entries()] };
  store.set(key, { at: Date.now(), data });
  return data;
}

// What matters for this game, most serious first.
function flagsFor(win, before, surface) {
  const f = [];
  const sum = (arr, k) => arr.reduce((s, h) => s + (isNum(h?.[k]) ? h[k] : 0), 0);
  const max = (arr, k) => Math.max(...arr.map(h => isNum(h?.[k]) ? h[k] : -Infinity));
  const min = (arr, k) => Math.min(...arr.map(h => isNum(h?.[k]) ? h[k] : Infinity));
  const hs = win.filter(Boolean);
  if (!hs.length) return f;
  const snow = sum(hs, "snow"), rain = Math.max(0, sum(hs, "qpf") - snow / 10), rate = max(hs, "qpf");
  const wind = max(hs, "wind"), gust = max(hs, "gust"), cold = min(hs, "feels"), heat = max(hs, "feels"), vis = min(hs, "vis");
  if (hs.some(h => h.code >= 95)) f.push({ lvl: "sig", ic: "⛈️", t: "Thunderstorms: lightning delays possible" });
  if (snow >= LIMITS.snow.sig) f.push({ lvl: "sig", ic: "❄️", t: `Snow: ${snow.toFixed(1)} in during the game` });
  else if (snow >= LIMITS.snow.note) f.push({ lvl: "note", ic: "❄️", t: `Some snow (${snow.toFixed(1)} in)` });
  if (rain >= LIMITS.rain.sig || rate >= LIMITS.rain.rateSig) f.push({ lvl: "sig", ic: "🌧️", t: `Heavy rain: ${rain.toFixed(2)} in during the game` });
  else if (rain >= LIMITS.rain.note) f.push({ lvl: "note", ic: "🌦️", t: `Rain: ${rain.toFixed(2)} in during the game` });
  if (wind >= LIMITS.wind.sig || gust >= LIMITS.wind.gustSig) f.push({ lvl: "sig", ic: "💨", t: `Strong wind: ${Math.round(wind)} mph, gusts ${Math.round(gust)}` });
  else if (wind >= LIMITS.wind.note || gust >= LIMITS.wind.gustNote) f.push({ lvl: "note", ic: "💨", t: `Windy: ${Math.round(wind)} mph, gusts ${Math.round(gust)}` });
  if (cold <= LIMITS.cold.sig) f.push({ lvl: "sig", ic: "🥶", t: `Frigid: feels like ${Math.round(cold)}°` });
  else if (cold <= LIMITS.cold.note) f.push({ lvl: "note", ic: "🥶", t: `Cold: feels like ${Math.round(cold)}°` });
  if (heat >= LIMITS.heat.sig) f.push({ lvl: "sig", ic: "🥵", t: `Extreme heat: feels like ${Math.round(heat)}°` });
  else if (heat >= LIMITS.heat.note) f.push({ lvl: "note", ic: "🥵", t: `Hot: feels like ${Math.round(heat)}°` });
  if (isFinite(vis) && vis <= LIMITS.fog.sig) f.push({ lvl: "sig", ic: "🌫️", t: "Dense fog: visibility under ¼ mile" });
  else if (isFinite(vis) && vis <= LIMITS.fog.note) f.push({ lvl: "note", ic: "🌫️", t: "Fog: visibility under 1 mile" });
  const wet = sum(before.filter(Boolean), "qpf"), snowBefore = sum(before.filter(Boolean), "snow");
  if (snowBefore >= 2) f.push({ lvl: "sig", ic: "🧹", t: `${snowBefore.toFixed(0)} in of snow in the 48 h before: field and footing affected` });
  else if (wet >= LIMITS.field.note) {
    const lvl = wet >= LIMITS.field.sig && surface !== "turf" ? "sig" : "note";
    f.push({ lvl, ic: "🟫", t: `${wet.toFixed(2)} in of rain in the 48 h before kickoff${surface === "grass" ? ": grass field may be soft or muddy" : surface === "turf" ? " (turf drains well)" : ""}` });
  }
  return f.sort((a, b) => (a.lvl === "sig" ? 0 : 1) - (b.lvl === "sig" ? 0 : 1));
}

function gameCard(g, v, wx, flags) {
  const kick = Date.parse(g.date);
  const tz = wx?.tz;
  const h0 = Math.floor(kick / H) * H - H;
  const slots = [0, 1, 2, 3, 4].map(i => h0 + i * H);
  const hours = new Map(wx?.hours || []);
  const lvl = flags.some(x => x.lvl === "sig") ? "sig" : flags.length ? "note" : "ok";
  const live = g.status?.state === "in", final = g.status?.state === "post";
  const score = (live || final) && g.home.score != null ? ` · ${esc(g.away.abbr)} ${esc(g.away.score)}, ${esc(g.home.abbr)} ${esc(g.home.score)}` : "";
  const labels = ["Pregame", "Kickoff", "", "", "Late / OT"];
  const cells = slots.map((t, i) => {
    const h = hours.get(t);
    if (!h) return `<td class="na">—</td>`;
    const [cat, txt] = wmoInfo(h.code);
    const night = +fmt(t, tz, { hour: "numeric", hourCycle: "h23" }) < 7 || +fmt(t, tz, { hour: "numeric", hourCycle: "h23" }) >= 18;
    const strong = h.wind >= LIMITS.wind.note || h.gust >= LIMITS.wind.gustNote;
    const wet = (h.qpf ?? 0) >= 0.01 || (h.snow ?? 0) >= 0.1;
    return `<td>
      <div class="ni" title="${esc(txt)}">${icon(cat, night)}</div>
      <div class="nt">${T(h.temp)}${isNum(h.feels) && Math.abs(h.feels - h.temp) >= 4 ? `<span class="nf"> feels ${T(h.feels)}</span>` : ""}</div>
      <div class="nw${strong ? " hot" : ""}" title="Wind ${mph(h.wind)} mph${isNum(h.gust) ? `, gusts ${mph(h.gust)}` : ""} from the ${dir(h.wdir)}">💨 ${mph(h.wind)}<span class="nd">${isNum(h.gust) && h.gust - h.wind >= 5 ? `g${mph(h.gust)} ` : ""}${dir(h.wdir)}</span></div>
      <div class="np${wet ? " hot" : ""}">${(h.snow ?? 0) >= 0.1 ? `❄️ ${h.snow.toFixed(1)}"` : `💧${isNum(h.pop) ? Math.round(h.pop) + "%" : "—"}`}<span class="nd">${(h.snow ?? 0) < 0.1 && (h.qpf ?? 0) >= 0.01 ? R(h.qpf, false) + '"' : "&nbsp;"}</span></div>
    </td>`;
  }).join("");
  return `<article class="game lvl-${lvl}">
    <header>
      <div class="gm"><b>${esc(g.away.name || g.away.abbr)}</b> at <b>${esc(g.home.name || g.home.abbr)}</b>${live ? ` <span class="live">LIVE</span>` : ""}${final ? ` <span class="fin">Final</span>` : ""}${score}</div>
      <div class="gsub">${esc(kickLbl(kick, MY_TZ))} ${esc(tzAbbr(kick, MY_TZ))}${tz && tz !== MY_TZ ? ` (${esc(kickLbl(kick, tz).split(", ").pop())} ${esc(tzAbbr(kick, tz))} local)` : ""}${g.tv ? " · " + esc(g.tv) : ""}</div>
      <div class="gsub">${esc(v.name)}${g.venue?.city ? ", " + esc(g.venue.city) : ""}${v.surface ? ` · ${v.surface === "grass" ? "grass field" : "artificial turf"}` : ""}</div>
    </header>
    ${flags.length ? `<div class="flags">${flags.map(x => `<span class="flag ${x.lvl}">${x.ic} ${esc(x.t)}</span>`).join("")}</div>` : `<div class="flags"><span class="flag ok">✓ No significant weather expected</span></div>`}
    ${wx ? `<div class="scroll"><table class="gtable"><thead><tr>${slots.map((t, i) => `<th>${labels[i] ? `<div class="slot">${labels[i]}</div>` : `<div class="slot">&nbsp;</div>`}${esc(hourLbl(t, MY_TZ))}</th>`).join("")}</tr></thead><tbody><tr>${cells}</tr></tbody></table></div>`
         : `<p class="empty">Forecast not available yet.</p>`}
    ${final ? `<p class="sub2" style="margin:6px 0 0">Game is over: weather shown is the model's analysis of game time.</p>` : ""}
  </article>`;
}

export async function showNFL(force = false) {
  const el = $("nflBody");
  if (!loaded || force) {
    el.innerHTML = `<p class="empty">Loading this week's games…</p>`;
    loaded = (async () => {
      const sched = await loadSchedule();
      if (!sched?.games?.length) return { sched };
      const games = await Promise.all(sched.games.map(async g => {
        const v = await venueFor(g);
        let wx = null, err = null;
        if (v.roof === "open" && isNum(v.lat)) { try { wx = await weatherFor(v); } catch (e) { err = e.message; } }
        return { g, v, wx, err };
      }));
      return { sched, games };
    })();
  }
  const { sched, games } = await loaded;
  if (!games) { el.innerHTML = `<p class="empty">The schedule isn't available right now. It's refreshed several times a day; try again later.</p>`; return; }
  const outdoor = [], covered = [];
  for (const x of games) {
    if (x.v.roof === "open") {
      const kick = Date.parse(x.g.date), h0 = Math.floor(kick / H) * H - H;
      const hrs = new Map(x.wx?.hours || []);
      const win = [0, 1, 2, 3, 4].map(i => hrs.get(h0 + i * H));
      const before = Array.from({ length: 48 }, (_, i) => hrs.get(h0 - (i + 1) * H));
      outdoor.push({ ...x, flags: x.wx ? flagsFor(win, before, x.v.surface) : [] });
    } else covered.push(x);
  }
  outdoor.sort((a, b) => Date.parse(a.g.date) - Date.parse(b.g.date));
  const watch = outdoor.filter(x => x.flags.length && x.g.status?.state !== "post").sort((a, b) => (b.flags.some(f => f.lvl === "sig") - a.flags.some(f => f.lvl === "sig")) || Date.parse(a.g.date) - Date.parse(b.g.date));
  const roofWord = r => ({ dome: "dome", retractable: "retractable roof", canopy: "covered roof" })[r] || "roof";
  el.innerHTML = `
    <div class="nflhead">
      <h2>${sched.seasonType === 3 ? "Playoffs" : "Week"} ${esc(sched.week ?? "")} · ${games.length} games, ${outdoor.length} outdoors</h2>
      <span class="sub2">Schedule updated ${esc(kickLbl(sched.updated, MY_TZ))}</span>
    </div>
    ${watch.length ? `<div class="panel watch"><h3>⚠️ Weather watch</h3><ul>${watch.map(x => `<li><a href="#g${esc(x.g.id)}">${esc(x.g.short)}</a> · ${esc(kickLbl(Date.parse(x.g.date), MY_TZ))}: ${x.flags.map(f => `<span class="flag ${f.lvl}">${f.ic} ${esc(f.t)}</span>`).join(" ")}</li>`).join("")}</ul></div>`
      : `<div class="panel watch ok">✓ No significant weather expected for this week's outdoor games${outdoor.some(x => !x.wx) ? " (some forecasts aren't available yet)" : ""}.</div>`}
    <div class="games">${outdoor.map(x => `<div id="g${esc(x.g.id)}">${gameCard(x.g, x.v, x.wx, x.flags)}</div>`).join("")}</div>
    ${covered.length ? `<div class="panel covered"><h3>Under a roof: weather won't matter</h3><ul>${covered.sort((a, b) => Date.parse(a.g.date) - Date.parse(b.g.date)).map(x => `<li>${esc(x.g.short)} · ${esc(kickLbl(Date.parse(x.g.date), MY_TZ))} · ${esc(x.v.name)} (${roofWord(x.v.roof)}${x.v.roof === "retractable" ? ", normally closed in bad weather" : ""})</li>`).join("")}</ul></div>` : ""}
    <details class="how"><summary>What gets highlighted</summary><ul>
      <li><b>Forecast window:</b> 5 hours per game: 1 hour before kickoff, the 3-hour game, and 1 extra hour for overtime. Times are in your time zone. Forecasts come from Open-Meteo (US: NOAA's high-resolution models).</li>
      <li><b>Red (significant):</b> heavy rain (0.30"+ during the game, or 0.15"+ in an hour), 1"+ of snow, sustained wind 20+ mph or gusts 35+, feels-like 15° or colder / 100°+, thunderstorms (lightning delays), dense fog, or 1.25"+ of rain on a grass field in the 48 hours before.</li>
      <li><b>Yellow (worth knowing):</b> any measurable rain or snow, wind 15+ mph or gusts 25+, feels-like 32° or colder / 90°+, fog under a mile, or 0.5"+ of rain in the 48 hours before kickoff.</li>
      <li><b>Domes, covered and retractable-roof stadiums</b> are listed at the bottom without forecasts.</li>
    </ul></details>`;
}
