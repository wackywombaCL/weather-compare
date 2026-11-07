// NFL tab: this week's outdoor games with a 5-hour stadium forecast (1 h before kickoff, the
// 3-hour game, 1 h extra for overtime), highlighting rain, snow, wind, cold/heat, lightning
// and fog, plus how much rain fell in the 48 hours before (field conditions).
// Schedule: data/nfl.json (from ESPN, refreshed by a GitHub job). Forecasts: Open-Meteo.
import { $, esc, store, T, R } from "./common.js";
import { findStadium, stadiumKey } from "./stadiums.js";
import { addBest } from "./stadiumskill.js";
import { loadData, blendNote } from "./stadiumsview.js";
import { icon, wmoInfo, getJSON, isNum } from "./sources.js";
import { rating } from "./skill.js";
import { LIMITS, fetchStadiumWeather, gameWeather, flagsFor, modelAgreement, windVsField, fieldRuns, compass, MODEL_NAMES } from "./nflwx.js";

const RAW = "https://raw.githubusercontent.com/wackywombaCL/weather-compare/main/data/nfl.json";
const MY_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const H = 3600e3;
let loaded = null;
// A game is finished once ESPN says so, or 4½ hours after kickoff (the schedule refreshes every 2 hours).
const isDone = g => g.status?.state === "post" || Date.now() > Date.parse(g.date) + 4.5 * H;
const scoreLine = g => g.home?.score != null && g.away?.score != null ? `${esc(g.away.abbr)} ${esc(g.away.score)}, ${esc(g.home.abbr)} ${esc(g.home.score)}` : "";

// ---------- Forecast accuracy (locked-in forecasts checked against stadium-area observations) ----------
const RAW_SCORES = "https://raw.githubusercontent.com/wackywombaCL/weather-compare/main/data/nfl/scores.json";
const SHORT = { best: "Best blend", best_match: "OM blend", ecmwf_ifs025: "Euro", gfs_seamless: "GFS", icon_seamless: "ICON", gem_seamless: "GEM" };
const LEAD_LBL = { "48h": "2 days before", "24h": "1 day before", "3h": "3 hours before" };
async function loadScores() {
  const bust = "?t=" + Math.floor(Date.now() / 300000);
  for (const url of [RAW_SCORES + bust, new URL("../data/nfl/scores.json", import.meta.url).href + bust]) {
    try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return await r.json(); } catch {}
  }
  return null;
}
const avg = a => { const v = a.filter(isNum); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
const scoreBadge = v => { const g = rating(v); return g ? `<span class="badge b-${g.key}" title="${g.label}"><i></i>${Math.round(v)}</span>` : `<span class="sub2">—</span>`; };
function renderAccuracy(el, data) {
  const games = data?.games || [];
  const lead = store.get("wc.nflLead", "24h");
  const intro = `Each outdoor game's forecast from 5 models is locked in 2 days, 1 day and 3 hours before kickoff, then checked against the nearest official weather station after the game (temperature and wind each hour, and whether it rained). Score 0–100: 45% temperature, 35% wind, 20% rain call.`;
  if (!games.length) { el.innerHTML = `<h2>How the forecasts did</h2><div class="panel"><p class="sub2" style="margin:0">${intro} Results appear here the evening after each game; the first ones are from this week's games.</p></div>`; return; }
  const models = Object.keys(SHORT).filter(m => games.some(g => g.leads?.[lead]?.[m]));
  const pick = (g, m) => g.leads?.[lead]?.[m];
  // Overall
  const overall = models.map(m => {
    const rs = games.map(g => pick(g, m)).filter(Boolean);
    return { m, n: rs.length, score: avg(rs.map(r => r.score)), temp: avg(rs.map(r => r.tempMae)), wind: avg(rs.map(r => r.windMae)), rain: rs.length ? rs.filter(r => r.rain === "hit" || r.rain === "none").length / rs.length : null };
  }).filter(x => x.n).sort((a, b) => b.score - a.score);
  // By stadium
  const stadiums = [...new Set(games.filter(g => g.leads?.[lead]).map(g => g.stadium))];
  const byStadium = stadiums.map(st => {
    const gs = games.filter(g => g.stadium === st && g.leads?.[lead]);
    const cells = Object.fromEntries(models.map(m => [m, avg(gs.map(g => pick(g, m)?.score))]));
    const best = Math.max(...Object.values(cells).filter(isNum));
    return { st, n: gs.length, cells, best };
  }).sort((a, b) => b.n - a.n || a.st.localeCompare(b.st));
  const recent = games.filter(g => g.leads?.[lead]).slice(-8).reverse();
  el.innerHTML = `
    <h2>How the forecasts did</h2>
    <p class="sub2" style="margin:0 0 8px">${intro}</p>
    <div class="acc-controls"><div class="seg" id="nflLead" role="group" aria-label="Forecast locked">${Object.entries(LEAD_LBL).map(([k, t]) => `<button data-lead="${k}" aria-pressed="${k === lead}">${t}</button>`).join("")}</div>
      <span class="sub2">${games.length} game${games.length > 1 ? "s" : ""} checked</span></div>
    <div class="panel scroll"><table class="acc stack"><thead><tr><th style="text-align:left">Model</th><th>Score</th><th>Games</th><th>Temp miss</th><th>Wind miss</th><th>Rain call right</th></tr></thead><tbody>
      ${overall.map((x, i) => `<tr class="${i === 0 ? "rank1" : ""}"><th>${esc(SHORT[x.m])}</th><td data-label="Score">${scoreBadge(x.score)}</td><td data-label="Games">${x.n}</td><td data-label="Temp miss">${isNum(x.temp) ? x.temp.toFixed(1) + "°" : "—"}</td><td data-label="Wind miss">${isNum(x.wind) ? x.wind.toFixed(1) + " mph" : "—"}</td><td data-label="Rain call right">${isNum(x.rain) ? Math.round(x.rain * 100) + "%" : "—"}</td></tr>`).join("")}
    </tbody></table></div>
    <h3 style="font-size:14px;margin:14px 0 6px">By stadium</h3>
    <div class="panel scroll"><table class="acc nflgrid"><thead><tr><th style="text-align:left">Stadium</th><th title="Games">#</th>${models.map(m => `<th>${esc(SHORT[m])}</th>`).join("")}</tr></thead><tbody>
      ${byStadium.map(r => `<tr><th title="${esc(r.st)}">${esc(r.st.replace(/ (Stadium|Field)$/, "").replace(/ at Mile High$/, ""))}</th><td>${r.n}</td>${models.map(m => `<td class="${r.cells[m] === r.best ? "best" : ""}">${scoreBadge(r.cells[m])}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>
    <h3 style="font-size:14px;margin:14px 0 6px">Recent games</h3>
    <div class="panel"><ul class="recap">${recent.map(g => {
      const o = g.obs, rs = Object.entries(g.leads[lead] || {}).sort((a, b) => b[1].score - a[1].score);
      const t = o.temp.filter(isNum), w = o.wind.filter(isNum);
      return `<li><b>${esc(g.short)}</b> · ${esc(fmt(Date.parse(g.date), MY_TZ, { weekday: "short", month: "short", day: "numeric" }))} · ${esc(g.stadium)}<div class="sub2">Actual at ${esc(o.station)}${isNum(o.mi) ? ` (${o.mi} mi)` : ""}: ${t.length ? `${Math.round(Math.min(...t))}–${Math.round(Math.max(...t))}°` : "—"}, wind ${w.length ? `${Math.round(Math.min(...w))}–${Math.round(Math.max(...w))} mph` : "—"}${isNum(o.gustMax) ? `, gusts ${Math.round(o.gustMax)}` : ""}, ${o.rained ? `rain${isNum(o.precip) ? ` ${o.precip.toFixed(2)} in` : ""}` : "dry"}</div>
        <div class="sub2">Best: ${rs.slice(0, 2).map(([m, r]) => `${esc(SHORT[m])} ${Math.round(r.score)}`).join(", ")}${rs.length > 2 ? ` · Worst: ${esc(SHORT[rs.at(-1)[0]])} ${Math.round(rs.at(-1)[1].score)}` : ""}</div></li>`;
    }).join("")}</ul></div>`;
  el.querySelectorAll("#nflLead button").forEach(b => b.addEventListener("click", () => { store.set("wc.nflLead", b.dataset.lead); renderAccuracy(el, data); }));
}

// Small helmet drawn in the team's colors (ESPN's primary + alternate). Away faces right, home faces left.
const hex = c => /^[0-9a-f]{6}$/i.test(c || "") ? "#" + c : null;
function helmet(team, faceLeft = false) {
  const main = hex(team?.color) || "#7a7974";
  let alt = hex(team?.alt) || "#ffffff";
  if (alt.toLowerCase() === main.toLowerCase()) alt = "#ffffff";
  return `<svg class="helmet" viewBox="0 0 26 20" aria-hidden="true"${faceLeft ? ' style="transform:scaleX(-1)"' : ""}>
    <path d="M2.5 12.2C2.5 5.6 7.3 1.8 12.6 1.8c5.4 0 8.9 3.3 8.9 7.6v2.4h-4.4l-2 3.4H6.3c-2.3 0-3.8-1.2-3.8-3z" fill="${main}" stroke="rgba(0,0,0,.35)" stroke-width=".8"/>
    <path d="M6.6 3.9c3-1.6 7.6-1.9 11.4.3" fill="none" stroke="${alt}" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="10.4" cy="10.3" r="1.4" fill="rgba(0,0,0,.45)"/>
    <path d="M17.1 11.8h6.4M18.3 8.9h5.2M22.6 8.9v6.3M17.6 15.2h5.8" fill="none" stroke="#9a9890" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`;
}
const withHelmet = (team, faceLeft, txt) => `<span class="tm">${helmet(team, faceLeft)}${txt}</span>`;

const fmt = (ms, tz, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(ms);
const hourLbl = (ms, tz) => fmt(ms, tz, { hour: "numeric" }).replace(" ", "").toLowerCase();
const kickLbl = (ms, tz) => fmt(ms, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/ (AM|PM)/, (m, x) => x.toLowerCase());
const tzAbbr = (ms, tz) => (fmt(ms, tz, { timeZoneName: "short" }).split(" ").pop());
const dir = compass;
const mph = v => !isNum(v) ? "—" : Math.round(v);

async function loadSchedule() {
  const bust = "?t=" + Math.floor(Date.now() / 300000);
  for (const url of [RAW + bust, new URL("../data/nfl.json", import.meta.url).href + bust]) {
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
  const key = `wc.nflwx2.${v.lat.toFixed(2)},${v.lon.toFixed(2)}`;
  const hit = store.get(key, null);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.data;
  const data = await fetchStadiumWeather(v.lat, v.lon);
  store.set(key, { at: Date.now(), data });
  return data;
}

function gameCard(g, v, wx, flags, gw, agree, W) {
  const kick = Date.parse(g.date);
  const tz = wx?.tz;
  const slots = gw?.slots || [];
  const lvl = flags.some(x => x.lvl === "sig") ? "sig" : flags.length ? "note" : "ok";
  const final = isDone(g), live = !final && (g.status?.state === "in" || Date.now() >= kick);
  const score = (live || final) && g.home.score != null ? ` · ${esc(g.away.abbr)} ${esc(g.away.score)}, ${esc(g.home.abbr)} ${esc(g.home.score)}` : "";
  const labels = ["Pregame", "Kickoff", "", "", "Late / OT"];
  const cells = slots.map((t, i) => {
    const h = gw.win[i];
    if (!h) return `<td class="na">—</td>`;
    const [cat, txt] = wmoInfo(h.code);
    const night = +fmt(t, tz, { hour: "numeric", hourCycle: "h23" }) < 7 || +fmt(t, tz, { hour: "numeric", hourCycle: "h23" }) >= 18;
    const strong = h.wind >= LIMITS.wind.note || h.gust >= LIMITS.wind.gustNote;
    const wet = (h.qpf ?? 0) >= 0.01 || (h.snow ?? 0) >= 0.1;
    return `<td>
      <div class="ni" title="${esc(txt)}">${icon(cat, night)}</div>
      <div class="nt">${T(h.temp)}${isNum(h.feels) && Math.abs(h.feels - h.temp) >= 4 ? `<span class="nf"> feels ${T(h.feels)}</span>` : ""}</div>
      <div class="nw${strong ? " hot" : ""}" title="Wind ${mph(h.wind)} mph${isNum(h.gust) ? `, gusts ${mph(h.gust)}` : ""} from the ${dir(h.wdir)}${windVsField(v.axis, h.wdir) ? ": " + windVsField(v.axis, h.wdir).text : ""}">💨 ${mph(h.wind)}<span class="nd">${isNum(h.gust) && h.gust - h.wind >= 5 ? `g${mph(h.gust)} ` : ""}${dir(h.wdir)}${(() => { const r = windVsField(v.axis, h.wdir); return r ? ` <span class="rel">${r.kind === "cross" ? "↔ cross" : r.kind === "along" ? "↕ along" : "⤢ angled"}</span>` : ""; })()}</span></div>
      <div class="np${wet ? " hot" : ""}">${(h.snow ?? 0) >= 0.1 ? `❄️ ${h.snow.toFixed(1)}"` : `💧${isNum(h.pop) ? Math.round(h.pop) + "%" : "—"}`}<span class="nd">${(h.snow ?? 0) < 0.1 && (h.qpf ?? 0) >= 0.01 ? R(h.qpf, false) + '"' : "&nbsp;"}</span></div>
    </td>`;
  }).join("");
  return `<article class="game lvl-${lvl}">
    <header>
      <div class="gm">${withHelmet(g.away, false, `<b>${esc(g.away.name || g.away.abbr)}</b>`)} at ${withHelmet(g.home, true, `<b>${esc(g.home.name || g.home.abbr)}</b>`)}${live ? ` <span class="live">LIVE</span>` : ""}${final ? ` <span class="fin">${g.status?.state === "post" ? "Final" : "Completed"}</span>` : ""}${score}</div>
      <div class="gsub">${esc(kickLbl(kick, MY_TZ))} ${esc(tzAbbr(kick, MY_TZ))}${tz && tz !== MY_TZ ? ` (${esc(kickLbl(kick, tz).split(", ").pop())} ${esc(tzAbbr(kick, tz))} local)` : ""}${g.tv ? " · " + esc(g.tv) : ""}</div>
      <div class="gsub">${esc(v.name)}${g.venue?.city ? ", " + esc(g.venue.city) : ""}${v.surface ? ` · ${v.surface === "grass" ? "grass field" : "artificial turf"}` : ""}${fieldRuns(v.axis) ? ` · field runs ${fieldRuns(v.axis)}` : ""}</div>
      ${wx ? `<div class="gsub">Forecast: ${W ? `<b>best blend</b> · ${esc(blendNote(W))} <span class="sub2">(last ${W.n} checked days ${W.from === "stadium" ? "here" : "at all stadiums"}; <a href="${location.pathname.includes("/nfl/") ? "../#stadiums" : "#stadiums"}">details</a>)</span>` : `Open-Meteo blend <span class="sub2">(the best blend starts once the daily stadium tracking has a few days of results)</span>`}</div>` : ""}
      ${agree ? `<div class="gsub agree">Models agree: <span class="conf conf-${agree.level.toLowerCase()}" title="${esc(agree.n)} models (${esc(Object.values(MODEL_NAMES).join(", "))})">${agree.level}</span> <span class="sub2">${esc(agree.notes.join(" · "))}</span></div>` : ""}
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
      const [sched, skill] = await Promise.all([loadSchedule(), loadData("stadiums/skill.json")]);
      if (!sched?.games?.length) return { sched };
      const games = await Promise.all(sched.games.map(async g => {
        const v = await venueFor(g);
        let wx = null, err = null;
        let W = null;
        if (v.roof === "open" && isNum(v.lat)) { try { wx = await weatherFor(v); W = addBest(wx, skill, stadiumKey(v)); } catch (e) { err = e.message; } }
        return { g, v, wx, err, W };
      }));
      return { sched, games };
    })();
  }
  const { sched, games } = await loaded;
  if (!games) { el.innerHTML = `<p class="empty">The schedule isn't available right now. It's refreshed several times a day; try again later.</p>`; return; }
  const outdoor = [], covered = [];
  for (const x of games) {
    if (x.v.roof === "open") {
      const gw = x.wx ? gameWeather(x.wx, Date.parse(x.g.date)) : null;
      outdoor.push({ ...x, gw, flags: gw ? flagsFor(gw.win, gw.before, x.v) : [], agree: gw ? modelAgreement(gw.byModel) : null });
    } else covered.push(x);
  }
  const byKick = (a, b) => Date.parse(a.g.date) - Date.parse(b.g.date);
  outdoor.sort(byKick); covered.sort(byKick);
  // Finished games drop to their own section at the bottom until the week rolls over (Tue 12:30am PT).
  const upcoming = outdoor.filter(x => !isDone(x.g)), doneOut = outdoor.filter(x => isDone(x.g));
  const coveredUp = covered.filter(x => !isDone(x.g)), doneCov = covered.filter(x => isDone(x.g));
  const doneAll = [...doneOut, ...doneCov].sort(byKick);
  const watch = upcoming.filter(x => x.flags.length).sort((a, b) => (b.flags.some(f => f.lvl === "sig") - a.flags.some(f => f.lvl === "sig")) || Date.parse(a.g.date) - Date.parse(b.g.date));
  const roofWord = r => ({ dome: "dome", retractable: "retractable roof", canopy: "covered roof" })[r] || "roof";
  el.innerHTML = `
    <div class="nflhead">
      <h2>${sched.seasonType === 3 ? "Playoffs" : "Week"} ${esc(sched.week ?? "")} · ${games.length} games, ${outdoor.length} outdoors</h2>
      <span class="sub2">Schedule updated ${esc(kickLbl(sched.updated, MY_TZ))}${location.pathname.includes("/nfl/") ? "" : ` · <a href="nfl/">Open as its own app ↗</a>`}</span>
    </div>
    ${watch.length ? `<div class="panel watch"><h3>⚠️ Weather watch</h3><ul>${watch.map(x => `<li><a href="#g${esc(x.g.id)}">${helmet(x.g.away)}${helmet(x.g.home, true)} ${esc(x.g.short)}</a> · ${esc(kickLbl(Date.parse(x.g.date), MY_TZ))}: ${x.flags.map(f => `<span class="flag ${f.lvl}">${f.ic} ${esc(f.t)}</span>`).join(" ")}</li>`).join("")}</ul></div>`
      : upcoming.length ? `<div class="panel watch ok">✓ No significant weather expected for the rest of this week's outdoor games${upcoming.some(x => !x.wx) ? " (some forecasts aren't available yet)" : ""}.</div>`
      : `<div class="panel watch ok">This week's games are done. Next week's games and forecasts load at 12:30am Pacific on Tuesday.</div>`}
    <div class="games">${upcoming.map(x => `<div id="g${esc(x.g.id)}">${gameCard(x.g, x.v, x.wx, x.flags, x.gw, x.agree, x.W)}</div>`).join("")}</div>
    ${coveredUp.length ? `<div class="panel covered"><h3>Under a roof: weather won't matter</h3><ul>${coveredUp.map(x => `<li>${helmet(x.g.away)}${helmet(x.g.home, true)} ${esc(x.g.short)} · ${esc(kickLbl(Date.parse(x.g.date), MY_TZ))} · ${esc(x.v.name)} (${roofWord(x.v.roof)}${x.v.roof === "retractable" ? ", normally closed in bad weather" : ""})</li>`).join("")}</ul></div>` : ""}
    ${doneAll.length ? `<section class="donewk">
      <h2>Completed this week <span class="sub2">· until next week's games load (Tue 12:30am PT)</span></h2>
      ${doneOut.length ? `<div class="games">${doneOut.map(x => `<div id="g${esc(x.g.id)}">${gameCard(x.g, x.v, x.wx, x.flags, x.gw, x.agree, x.W)}</div>`).join("")}</div>` : ""}
      ${doneCov.length ? `<div class="panel covered"><ul>${doneCov.map(x => `<li>${helmet(x.g.away)}${helmet(x.g.home, true)} ${esc(x.g.short)} · ${esc(kickLbl(Date.parse(x.g.date), MY_TZ))} · ${esc(x.v.name)} (${roofWord(x.v.roof)})${scoreLine(x.g) ? ` · <b>${scoreLine(x.g)}</b>` : ""}</li>`).join("")}</ul></div>` : ""}
    </section>` : ""}
    <section id="nflAcc" style="margin-top:22px"></section>
    <details class="how"><summary>What gets highlighted</summary><ul>
      <li><b>Forecast window:</b> 5 hours per game: 1 hour before kickoff, the 3-hour game, and 1 extra hour for overtime. Times are in your time zone. Forecasts come from Open-Meteo (US: NOAA's high-resolution models).</li>
      <li><b>Red (significant):</b> heavy rain (0.30"+ during the game, or 0.15"+ in an hour), 1"+ of snow, sustained wind 20+ mph or gusts 35+, feels-like 15° or colder / 100°+, thunderstorms (lightning delays), dense fog, or 1.25"+ of rain on a grass field in the 48 hours before.</li>
      <li><b>Yellow (worth knowing):</b> any measurable rain or snow, wind 15+ mph or gusts 25+, feels-like 32° or colder / 90°+, fog under a mile, or 0.5"+ of rain in the 48 hours before kickoff.</li>
      <li><b>Wind vs. the field:</b> each field's direction was measured from its outline in OpenStreetMap. "↕ along" means the wind blows roughly end zone to end zone (helps one direction, hurts the other); "↔ cross" means across the field (hardest on kicks); "⤢ angled" is in between.</li>
      <li><b>Best blend:</b> every outdoor stadium's forecast is tracked every day (not just on game days) and checked against the nearest official station. Each game's forecast is built from the models that have been most accurate at that stadium lately, separately for temperature, wind and rain, with temperature bias corrected. See the Stadiums tab.</li>
      <li><b>Models agree:</b> compares 5 forecast models (Open-Meteo blend, Euro, GFS, ICON, GEM) over the game window. High = within 5 mph on wind and 4° on temperature, and all agree on whether it rains or snows. Low = big disagreements: treat the forecast with caution.</li>
      <li><b>Phone alerts</b> (ntfy) go out only for significant (red) weather: Saturday 8pm, Sunday 9am and 12:45pm Pacific for the remaining games, and 1 hour before Thursday and Saturday games.</li>
      <li><b>Domes, covered and retractable-roof stadiums</b> are listed at the bottom without forecasts.</li>
    </ul></details>`;
  loadScores().then(d => { const a = $("nflAcc"); if (a) renderAccuracy(a, d); });
}
