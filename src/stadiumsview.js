// Stadiums tab: daily forecast tracking at every outdoor US NFL stadium. Shows the best-blend
// forecast for the next days, which models have been most accurate (overall and per stadium),
// and what the blend is built from. Data: data/stadiums/skill.json and forecast.json, written by
// scripts/stadiums.mjs.
import { $, esc, store, T, R } from "./common.js";
import { icon, wmoInfo, isNum } from "./sources.js";
import { rating } from "./skill.js";
import { TRACKED, stadiumKey, findStadium } from "./stadiums.js";
import { weightsFor } from "./stadiumskill.js";
import { compass } from "./nflwx.js";

const RAW = "https://raw.githubusercontent.com/wackywombaCL/weather-compare/main/data/";
export const SHORT = { best: "Best blend", best_match: "OM blend", ecmwf_ifs025: "Euro", gfs_seamless: "GFS", icon_seamless: "ICON", gem_seamless: "GEM" };
const LEADS = { "0": "Same day", "1": "1 day ahead", "2": "2 days", "3": "3 days" };
const short = n => n.replace(/ (Stadium|Field)$/, "").replace(/ at Mile High$/, "");

// Repo data file: fresh copy from GitHub (updated by the jobs), else the copy on the site.
export async function loadData(rel) {
  const bust = "?t=" + Math.floor(Date.now() / 300000);
  for (const url of [RAW + rel + bust, new URL("../data/" + rel, import.meta.url).href + bust]) {
    try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return await r.json(); } catch {}
  }
  return null;
}
const badge = v => { const g = rating(v); return g ? `<span class="badge b-${g.key}" title="${g.label}"><i></i>${Math.round(v)}</span>` : `<span class="sub2">—</span>`; };
const pct = v => isNum(v) ? v + "%" : "—";
const deg = v => isNum(v) ? v.toFixed(1) + "°" : "—";
const signed = v => !isNum(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(1) + "°";

// "Euro leads temperature, GFS wind, ICON rain"
export function blendNote(W) {
  if (!W?.lead) return "";
  const by = new Map();
  for (const [k, t] of [["temp", "temperature"], ["wind", "wind"], ["rain", "rain"]]) if (W.lead[k]) (by.get(W.lead[k]) || by.set(W.lead[k], []).get(W.lead[k])).push(t);
  if (by.size === 1) return `${SHORT[[...by.keys()][0]]} leads everything`;
  return [...by].map(([m, ts]) => `${SHORT[m] || m} for ${ts.join(" and ")}`).join(", ");
}

let data = null;
export async function showStadiums(force = false) {
  const el = $("stadiumsBody");
  if (!data || force) {
    el.innerHTML = `<p class="empty">Loading stadium forecasts…</p>`;
    data = Promise.all([loadData("stadiums/skill.json"), loadData("stadiums/forecast.json"), loadData("nfl.json")]);
  }
  const [skill, fc, sched] = await data;
  render(el, skill, fc, sched);
}

function render(el, skill, fc, sched) {
  const lead = store.get("wc.stLead", "1"), period = store.get("wc.stPeriod", "recent");
  const src = period === "all" ? skill?.allTime : skill?.recent;
  // Games this week at tracked stadiums: date (local) → matchup
  const games = {};
  for (const g of sched?.games || []) {
    const st = findStadium(g.venue?.name);
    if (!st) continue;
    const k = stadiumKey(st), tz = fc?.stadiums?.[k]?.tz || "America/New_York";
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.parse(g.date));
    (games[k] ||= {})[d] = g.short;
  }
  // ---- Forecast grid ----
  const rows = TRACKED.map(st => ({ st, k: stadiumKey(st) })).filter(x => fc?.stadiums?.[x.k]);
  const dates = [...new Set(rows.flatMap(x => fc.stadiums[x.k].days.map(d => d.date)))].sort().slice(0, 6);
  const dayLbl = k => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "numeric" }).format(Date.parse(k + "T12:00:00Z"));
  const cell = (x, d) => {
    const day = fc.stadiums[x.k].days.find(v => v.date === d);
    if (!day) return `<td class="na">—</td>`;
    const [cat, txt] = wmoInfo(day.code);
    const windy = day.wind >= 15 || day.gust >= 25, wet = day.qpf >= 0.05 || day.snow >= 0.1, cold = day.lo <= 32;
    const g = games[x.k]?.[d];
    return `<td class="${g ? "gameday" : ""}" title="${esc(txt)}${g ? " · " + esc(g) : ""}">
      ${g ? `<div class="gd">🏈 ${esc(g)}</div>` : ""}
      <div class="ni">${icon(cat, false)}</div>
      <div class="nt">${T(day.hi)} <span class="sub2${cold ? " hot" : ""}">${T(day.lo)}</span></div>
      <div class="nw${windy ? " hot" : ""}">💨 ${isNum(day.wind) ? day.wind : "—"}${isNum(day.gust) && day.gust - day.wind >= 5 ? `<span class="nd"> g${day.gust}</span>` : ""}<span class="nd"> ${compass(day.wdir)}</span></div>
      <div class="np${wet ? " hot" : ""}">${day.snow >= 0.1 ? `❄️ ${day.snow.toFixed(1)}"` : `💧${isNum(day.pop) ? day.pop + "%" : "—"}`}<span class="nd">${day.snow < 0.1 && day.qpf >= 0.01 ? " " + R(day.qpf, false) + '"' : ""}</span></div>
    </td>`;
  };
  const forecastHTML = rows.length ? `
    <div class="panel scroll tablebox"><table class="stgrid"><thead><tr><th style="text-align:left">Stadium</th>${dates.map(d => `<th>${esc(dayLbl(d))}</th>`).join("")}</tr></thead><tbody>
      ${rows.map(x => { const W = weightsFor(skill, x.k, 1); return `<tr><th><b>${esc(short(x.st.name))}</b><div class="sub2">${W ? `Blend: ${esc(blendNote(W))}` : "Equal blend (building history)"}</div></th>${dates.map(d => cell(x, d)).join("")}</tr>`; }).join("")}
    </tbody></table></div>
    <p class="sub2" style="margin:6px 0 0">High and low for the whole day; wind, gusts and rain chance are the 9am–midnight local peak; rain is the day's total. Highlighted: wind 15+ mph or gusts 25+, 0.05"+ of rain, any snow, lows at freezing or below. 🏈 = game day. Updated ${fc?.updated ? esc(new Date(fc.updated).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })) : "—"}.</p>`
    : `<div class="panel"><p class="sub2" style="margin:0">The first stadium forecasts are being made now; check back in an hour.</p></div>`;

  // ---- Leaderboard ----
  const board = src?.all?.[lead] || {};
  const ranked = Object.entries(board).filter(([m]) => SHORT[m]).sort((a, b) => b[1].score - a[1].score);
  const boardHTML = ranked.length ? `<div class="panel scroll"><table class="acc stack"><thead><tr><th style="text-align:left">Model</th><th>Score</th><th>Days</th><th>Temp miss</th><th>Temp bias</th><th>Wind miss</th><th>Rain call right</th></tr></thead><tbody>
      ${ranked.map(([m, s], i) => `<tr class="${i === 0 ? "rank1" : ""}${m === "best" ? " avgrow" : ""}"><th>${esc(SHORT[m])}</th><td data-label="Score">${badge(s.score)}</td><td data-label="Days">${s.n}</td><td data-label="Temp miss">${deg(s.temp)}</td><td data-label="Temp bias" title="Positive = forecast too warm">${signed(s.bias)}</td><td data-label="Wind miss">${isNum(s.wind) ? s.wind.toFixed(1) + " mph" : "—"}</td><td data-label="Rain call right">${pct(s.rain)}</td></tr>`).join("")}
    </tbody></table></div>`
    : `<div class="panel"><p class="sub2" style="margin:0">No checked days yet. Forecasts are locked every morning and checked after 2am the next night, so the first results show up tomorrow. The best blend starts using each stadium's own record after 3 checked days (before that it uses all stadiums together), and corrects temperature bias after 5.</p></div>`;

  // ---- Per stadium ----
  const models = Object.keys(SHORT).filter(m => Object.values(src?.st || {}).some(byL => byL[lead]?.[m]));
  const stRows = TRACKED.map(st => ({ st, k: stadiumKey(st), t: src?.st?.[stadiumKey(st)]?.[lead] })).filter(x => x.t);
  const stHTML = stRows.length ? `<div class="panel scroll tablebox"><table class="acc nflgrid"><thead><tr><th style="text-align:left">Stadium</th><th title="Days checked">#</th>${models.map(m => `<th>${esc(SHORT[m].replace("Best blend", "Best"))}</th>`).join("")}<th style="text-align:left">Leaders</th></tr></thead><tbody>
      ${stRows.map(x => {
        const cells = models.filter(m => m !== "best").map(m => x.t[m]?.score).filter(isNum), top = Math.max(...cells);
        const W = weightsFor(skill, x.k, lead), n = Math.max(...Object.values(x.t).map(s => s.n));
        const lat = skill?.latest?.[x.k];
        return `<tr><th title="${esc(x.st.name)}">${esc(short(x.st.name))}${lat ? `<div class="sub2" title="Latest checked day at ${esc(lat.station)}">${esc(lat.station)}: ${T(lat.obs?.hi)}/${T(lat.obs?.lo)}${lat.obs?.rained ? " 🌧" : ""}</div>` : ""}</th><td>${n}</td>${models.map(m => `<td class="${x.t[m]?.score === top && m !== "best" ? "best" : ""}">${badge(x.t[m]?.score)}</td>`).join("")}<td class="l sub2">${W?.from === "stadium" ? esc(blendNote(W)) : "—"}</td></tr>`;
      }).join("")}
    </tbody></table></div>` : "";

  el.innerHTML = `
    <div class="nflhead"><h2>Outdoor NFL stadiums · best-blend forecast</h2>
      <span class="sub2">${skill?.checked ? `${skill.checked} stadium-days checked${skill.since ? " since " + esc(skill.since) : ""}` : "Tracking started"} · ${TRACKED.length} stadiums</span></div>
    ${forecastHTML}
    <h2 style="margin-top:20px">Which models have been best</h2>
    <div class="acc-controls">
      <div class="seg" id="stLead" role="group" aria-label="Forecast range">${Object.entries(LEADS).map(([k, t]) => `<button data-v="${k}" aria-pressed="${k === lead}">${t}</button>`).join("")}</div>
      <div class="seg" id="stPeriod" role="group" aria-label="Period"><button data-v="recent" aria-pressed="${period === "recent"}">Last ${skill?.recentDays || 14} days</button><button data-v="all" aria-pressed="${period === "all"}">All time</button></div>
    </div>
    <h3 style="font-size:14px;margin:6px 0">All stadiums together</h3>
    ${boardHTML}
    ${stHTML ? `<h3 style="font-size:14px;margin:14px 0 6px">By stadium</h3>${stHTML}` : ""}
    <details class="how"><summary>How this works</summary><ul>
      <li><b>Every day</b>, after 6am local time at each stadium, every model's hourly forecast for 9am–midnight is locked in for today and 1, 2 and 3 days ahead. After 2am the next night it's checked against the nearest official weather station (NWS): temperature and wind each hour, and whether it rained. Score 0–100: 45% temperature, 35% wind, 20% rain call (the same as the NFL game scores).</li>
      <li><b>Best blend:</b> for each stadium and each range, temperature, wind and rain are each built from the models that have been most accurate at that stadium over the last 14 checked days. The leader counts most; the others fade out the further behind they are, and models far behind get no say. Temperatures are also corrected for each model's recent warm or cold bias at that stadium (after 5 checked days, up to ±5°).</li>
      <li><b>Until a stadium has 3 checked days</b>, the blend uses how the models did across all stadiums; before any results, it's a plain average.</li>
      <li><b>The NFL tab</b> uses this blend for each game's forecast and flags, and the NFL accuracy table scores it as its own row ("Best blend").</li>
      <li><b>Models:</b> Euro (ECMWF), GFS (NOAA; in the US it includes the high-resolution HRRR), ICON (Germany), GEM (Canada) and Open-Meteo's own blend, all via Open-Meteo.</li>
      <li>International and Mexico City games aren't tracked (no NWS observations there); domes and retractable roofs are skipped.</li>
    </ul></details>`;
  el.querySelectorAll("#stLead button").forEach(b => b.addEventListener("click", () => { store.set("wc.stLead", b.dataset.v); render(el, skill, fc, sched); }));
  el.querySelectorAll("#stPeriod button").forEach(b => b.addEventListener("click", () => { store.set("wc.stPeriod", b.dataset.v); render(el, skill, fc, sched); }));
}
