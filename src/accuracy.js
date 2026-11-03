// Accuracy tab: reads data/scores.json, data/status.json and the saved 6am forecasts written by the daily job.
import { SOURCES, PRESETS, isNum, mean, dayKey } from "./sources.js";
import { dayScore, rating, PSEUDO } from "./skill.js";
import { state, store, $, esc, T, D, A, R, fmtTime, fmtDayLong, lineChart, cvt, srcName, srcShort, isSelected, toggleSel, selColor, badge, renderAll } from "./app.js";

const TZ = "America/Los_Angeles";
const LOC_IDS = ["vallejo", "napa"];
const LEAD_NAMES = { 0: "Same day", 1: "1 day ahead", 2: "2 days ahead" };
const acc = { scores: null, status: null, today: null, problem: null, loading: null, loaded: false, loc: null, period: "all", lead: 0, snaps: {} };
export const accData = () => acc;

export function initAccuracy() {
  if (acc.loading) return acc.loading;
  const bust = "?t=" + Math.floor(Date.now() / 60000);
  const get = async url => { const r = await fetch(url + bust, { cache: "no-store" }); if (!r.ok) throw new Error(r.status); return r.json(); };
  acc.loading = (async () => {
    try { acc.scores = await get("data/scores.json"); acc.problem = null; }
    catch { acc.scores = null; acc.problem = location.protocol === "file:" ? "file" : "none"; }
    try { acc.status = await get("data/status.json"); } catch { acc.status = null; }
    try { acc.today = await get(`data/forecasts/${dayKey(Date.now(), TZ)}.json`); } catch { acc.today = null; }
    acc.snaps = {};
    acc.loaded = true;
    acc.loading = null;
    renderAccuracy();
  })();
  return acc.loading;
}

async function snapshot(date) {
  if (!(date in acc.snaps)) acc.snaps[date] = fetch(`data/forecasts/${date}.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  return acc.snaps[date];
}
// Hourly forecast for one source, lead and location from a saved forecast (old or v2 format).
function forecastHours(snap, locId, id, lead) {
  const x = snap?.locations?.[locId]?.sources?.[id];
  if (!x?.ok) return null;
  const p = snap.v === 2 ? x.leads?.[lead] : lead === 0 ? x : null;
  if (!p) return null;
  if (Array.isArray(p.hours)) return p.hours;
  return p.temp.map((t, i) => ({ t: p.start + i * 3600e3, temp: t, pop: p.pop[i], cat: p.cat[i] })).filter(h => isNum(h.temp));
}
function todayEntry(snap, locId, id) {
  const x = snap?.locations?.[locId]?.sources?.[id];
  if (!x) return null;
  if (!x.ok) return x;
  return snap.v === 2 ? (x.leads?.[0] ? { ok: true, ...x.leads[0] } : null) : x;
}

// ---------- Helpers ----------
const pct = (num, den) => den ? Math.round(100 * num / den) + "%" : "—";
function aggregate(days, id) {
  const rows = days.map(d => d.src[id]).filter(s => s?.ok);
  const abs = k => mean(rows.map(s => isNum(s[k]) ? Math.abs(s[k]) : null));
  const within = k => { const v = rows.filter(s => isNum(s[k])); return { n: v.length, ok: v.filter(s => Math.abs(s[k]) <= 3).length }; };
  const c = { hit: 0, miss: 0, false: 0, none: 0 };
  rows.forEach(s => c[s.rain]++);
  const hits = rows.filter(s => s.rain === "hit" && isNum(s.timing));
  return {
    n: rows.length, score: mean(rows.map(dayScore)),
    hiMAE: abs("hiErr"), hiBias: mean(rows.map(s => s.hiErr)), hi3: within("hiErr"),
    loMAE: abs("loErr"), loBias: mean(rows.map(s => s.loErr)), lo3: within("loErr"),
    mae: mean(rows.map(s => s.mae)), brier: mean(rows.map(s => s.brier)),
    rain: c, rainRight: rows.length ? (c.hit + c.none) / rows.length : null,
    timing: hits.length ? mean(hits.map(s => Math.abs(s.timing))) : null,
    timingBias: hits.length ? mean(hits.map(s => s.timing)) : null,
  };
}
const scoreBadge = v => { const g = rating(v); return g ? `<span class="badge b-${g.key}" title="${g.label}"><i></i>${Math.round(v)}</span>` : `<span class="miss">—</span>`; };
const timingText = h => !isNum(h) ? "" : Math.abs(h) < 0.5 ? "on time" : `${Math.abs(h).toFixed(Math.abs(h) < 10 ? 1 : 0).replace(/\.0$/, "")}h ${h > 0 ? "late" : "early"}`;
const isPseudo = id => PSEUDO.has(id);
const nameCell = id => `<th class="${isPseudo(id) ? "blend" : ""}">${isSelected(id) ? `<span class="sw" style="background:${selColor(id)}"></span>` : ""}${esc(srcShort(id))}</th>`;
const allIds = days => { const ids = new Set(); days.forEach(d => Object.keys(d.src).forEach(id => ids.add(id))); return [...ids]; };
const metSeason = date => { const m = +date.slice(5, 7); return m === 12 || m <= 2 ? "Winter" : m <= 5 ? "Spring" : m <= 8 ? "Summer" : "Fall"; };
const wetSeason = date => { const m = +date.slice(5, 7); return m >= 11 || m <= 4 ? "Wet" : "Dry"; };
const td = (label, html, cls = "") => `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ""}>${html}</td>`;

function currentLoc() {
  if (!acc.loc) acc.loc = store.get("wc.accLoc", LOC_IDS.includes(state.loc.id) ? state.loc.id : "vallejo");
  return acc.loc;
}
const locsFor = l => l === "both" ? LOC_IDS : [l];
const locName = id => PRESETS[id]?.name.replace(", CA", "") || id;

// ---------- Render ----------
export function renderAccuracy() {
  if (!$("viewAccuracy") || $("viewAccuracy").hidden) return;
  const loc = currentLoc();
  document.querySelectorAll("#accLoc button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.loc === loc)));
  if (!acc.loaded) { $("accToday").innerHTML = $("accRecent").innerHTML = `<p class="empty">Loading…</p>`; return; }
  renderHealth();
  renderToday(loc);
  renderRecent(loc);
  renderLongTerm(loc);
}

function renderHealth() {
  const st = acc.status;
  if (!st) { $("accHealth").innerHTML = acc.problem === "file" ? "" : `<span class="health warn">⚠️ No tracking runs recorded yet.</span>`; return; }
  const parts = [];
  const age = Date.now() - (st.lastRun || 0);
  const stale = age > 26 * 3600e3;
  parts.push(`<span class="health ${stale ? "warn" : "ok"}">${stale ? "⚠️" : "✓"} Last tracking run ${esc(fmtDayLong(st.lastRun, TZ))}, ${esc(fmtTime(st.lastRun, TZ))}${stale ? " (more than a day ago)" : ""}</span>`);
  const tracked = Object.entries(st.sources || {}).filter(([, v]) => v.tracked);
  const bad = tracked.filter(([, v]) => !v.ok);
  if (tracked.length) parts.push(`<span class="health ${bad.length ? "warn" : "ok"}">${bad.length ? "⚠️" : "✓"} ${tracked.length - bad.length} of ${tracked.length} sources saved this morning</span>`);
  for (const [id, v] of bad) parts.push(`<span class="health warn" title="${esc(v.error || "")}">${esc(srcName(id))}: ${esc(v.error || "failed")}${v.lastOk ? ` (last worked ${esc(v.lastOk)})` : ""}</span>`);
  for (const p of st.problems || []) if (!bad.some(([id]) => p.startsWith(srcName(id)))) parts.push(`<span class="health warn">${esc(p)}</span>`);
  $("accHealth").innerHTML = parts.join("");
  const stn = st.stations || {};
  $("accStations").textContent = Object.keys(stn).length ? "Observations: " + LOC_IDS.filter(l => stn[l]).map(l => `${locName(l)} → ${stn[l].id}${stn[l].name ? " (" + stn[l].name + ")" : ""}${isNum(stn[l].mi) ? `, ${stn[l].mi} mi away` : ""}`).join(" · ") : "";
}

function chipsHTML(ids) {
  return `<span class="chiphint">Draw on the charts (up to 4):</span>` + ids.filter(id => !isPseudo(id)).map(id => {
    const on = isSelected(id);
    return `<button class="schip${on ? " on" : ""}" data-sel="${id}" aria-pressed="${on}">${on ? `<span class="sw" style="background:${selColor(id)}"></span>` : ""}${esc(srcShort(id))}</button>`;
  }).join("");
}
function wireChips(el) {
  el.querySelectorAll("[data-sel]").forEach(b => b.addEventListener("click", () => { toggleSel(b.dataset.sel); renderAccuracy(); }));
}

function renderToday(loc) {
  const snap = acc.today;
  if (!snap) {
    const hr = +new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(Date.now());
    $("accToday").innerHTML = `<p class="empty">${acc.problem === "file" ? "Open the app from its web address to see tracking data." : hr < 6 ? "Today's forecast gets set at 6am Pacific." : "Today's forecast hasn't been set yet. It's usually saved a few minutes after 6am Pacific."}</p>`;
    return;
  }
  const lead0 = snap.v === 2 ? snap.leads[0] : { windowStart: snap.windowStart };
  $("accToday").innerHTML = locsFor(loc).map(lid => {
    const L = snap.locations[lid];
    if (!L) return "";
    const ids = Object.keys(L.sources).sort((a, b) => (isPseudo(b) - isPseudo(a)) || ((acc.scores ? 0 : 0)));
    const rows = ids.map(id => {
      const x = todayEntry(snap, lid, id);
      if (!x) return "";
      if (!x.ok) return `<tr>${nameCell(id)}<td colspan="5" class="l miss" data-label="">Couldn't save: ${esc(x.error)}</td></tr>`;
      return `<tr class="${isPseudo(id) ? "blendrow" : ""}">${nameCell(id)}${td("High", T(x.hi))}${td("Low", T(x.lo))}${td("Max rain chance", isNum(x.maxPop) ? Math.round(x.maxPop) + "%" : "—")}
        ${td("Rain total", isNum(x.qpfTotal) ? R(x.qpfTotal) : "—")}
        ${td("Rain expected", x.rainStart ? "🌧️ from " + esc(fmtTime(x.rainStart, TZ)) + (x.rainStart >= lead0.windowStart + 18 * 3600e3 ? " (" + esc(fmtDayLong(x.rainStart, TZ).split(",")[0]) + ")" : "") : "No rain", "l")}</tr>`;
    }).join("");
    return `<div class="panel daycard">
      <h3>${esc(locName(lid))} · ${esc(fmtDayLong(lead0.windowStart, TZ))} <span class="sub2">set ${esc(fmtTime(snap.setAt, TZ))}, covers 6am → 6am</span></h3>
      <table class="acc stack"><thead><tr><th>Source</th><th>High</th><th>Low</th><th>Max rain chance</th><th>Rain total</th><th style="text-align:left">Rain expected</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");
}

function emptyMsg() {
  return acc.problem === "file"
    ? "Accuracy data loads when the app is opened from its web address (GitHub Pages), not as a local file."
    : "No scored days yet. Forecasts are set at 6am Pacific and scored the next morning, so the first results appear a day after tracking starts.";
}

function renderRecent(loc) {
  const days = (acc.scores?.days || []).filter(d => locsFor(loc).includes(d.loc) && (d.lead ?? 0) === 0);
  if (!days.length) { $("accRecent").innerHTML = `<p class="empty">${emptyMsg()}</p>`; return; }
  const dates = [...new Set(days.map(d => d.date))].sort().reverse().slice(0, 3);
  const recentDays = days.filter(d => dates.includes(d.date)).sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : a.loc < b.loc ? -1 : 1);
  const ids = allIds(recentDays);
  let html = `<div class="chips" id="recentChips">${chipsHTML(ids)}</div>`;
  html += recentDays.map((d, k) => {
    const o = d.obs;
    const rainObs = o.rained ? `🌧️ started ~${esc(fmtTime(o.rainStart, TZ))}${isNum(o.precipIn) ? `, ${o.precipIn.toFixed(2)} in` : ""}` : "no rain";
    const order = Object.keys(d.src).sort((a, b) => (isPseudo(b) - isPseudo(a)) || ((dayScore(d.src[b]) ?? -1) - (dayScore(d.src[a]) ?? -1)));
    const rows = order.map(id => {
      const x = d.src[id];
      if (!x?.ok) return `<tr>${nameCell(id)}<td colspan="5" class="l miss" data-label="">No forecast saved that day</td></tr>`;
      let rain;
      if (x.rain === "hit") rain = `✓ Rain from ${esc(fmtTime(x.rainStart, TZ))} <span class="miss">(${timingText(x.timing)})</span>`;
      else if (x.rain === "miss") rain = `<span class="rain-bad">✗ Missed the rain</span>`;
      else if (x.rain === "false") rain = `<span class="rain-bad">✗ False alarm</span> <span class="miss">(said ${esc(fmtTime(x.rainStart, TZ))})</span>`;
      else rain = `✓ Called it dry`;
      if (isNum(x.qpf) && (x.qpf >= 0.01 || o.rained)) rain += ` <span class="miss">· ☔ ${R(x.qpf)}${isNum(x.qpfErr) ? ` (${x.qpfErr > 0 ? "+" : x.qpfErr < 0 ? "−" : "±"}${R(Math.abs(x.qpfErr), false)})` : ""}</span>`;
      return `<tr class="${isPseudo(id) ? "blendrow" : ""}">${nameCell(id)}${td("Score", scoreBadge(dayScore(x)))}
        ${td("High (miss)", `${T(x.hi)} <span class="miss">${D(x.hiErr)}</span>`)}${td("Low (miss)", `${T(x.lo)} <span class="miss">${D(x.loErr)}</span>`)}
        ${td("Hourly miss", A(x.mae))}${td("Rain", rain, "l")}</tr>`;
    }).join("");
    const stn = `${esc(d.station)}${d.stationName ? ` (${esc(d.stationName)}${isNum(d.stationMi) ? `, ${d.stationMi} mi` : ""})` : ""}`;
    return `<div class="panel daycard">
      <h3>${esc(fmtDayLong(d.windowStart, TZ))}${locsFor(loc).length > 1 ? " · " + esc(locName(d.loc)) : ""}</h3>
      ${d.partial ? `<div class="obsline">⚠️ Forecast was set late (${esc(fmtTime(d.setAt, TZ))}), so this only covers ${esc(fmtTime(d.windowStart, TZ))} onward and isn't counted in the long-term scoreboard.</div>` : ""}
      <div class="obsline">Actual at ${stn}: high <b>${T(o.hi)}</b>, low <b>${T(o.lo)}</b> · ${rainObs}</div>
      <div class="legend fva-legend" id="fvaL${k}"></div>
      <div class="chart" id="fva${k}"></div>
      <details class="srcs"${k === 0 || locsFor(loc).length > 1 && k === 1 ? " open" : ""}><summary>All sources for this day</summary>
      <table class="acc stack"><thead><tr><th>Source</th><th>Score</th><th>High (miss)</th><th>Low (miss)</th><th>Hourly miss</th><th style="text-align:left">Rain</th></tr></thead><tbody>${rows}</tbody></table></details></div>`;
  }).join("");
  // Summary across the shown days
  const ranked = ids.map(id => ({ id, a: aggregate(recentDays, id) })).filter(r => r.a.n).sort((a, b) => (b.a.score ?? -1) - (a.a.score ?? -1));
  html += `<div class="panel"><h3 style="font-size:15px;margin:0 0 6px">${dates.length}-day summary</h3>
    <table class="acc stack"><thead><tr><th>Source</th><th>Avg score</th><th>Avg high miss</th><th>Avg low miss</th><th>Hourly miss</th><th>Rain calls right</th><th>Rain timing</th></tr></thead><tbody>
    ${ranked.map((r, i) => `<tr class="${isPseudo(r.id) ? "blendrow" : ""}${i === 0 ? " rank1" : ""}">${nameCell(r.id)}${td("Avg score", scoreBadge(r.a.score))}${td("Avg high miss", A(r.a.hiMAE))}${td("Avg low miss", A(r.a.loMAE))}${td("Hourly miss", A(r.a.mae))}${td("Rain calls right", pct(r.a.rain.hit + r.a.rain.none, r.a.n))}${td("Rain timing", isNum(r.a.timing) ? "±" + r.a.timing.toFixed(1) + "h" : "—")}</tr>`).join("")}
    </tbody></table></div>`;
  $("accRecent").innerHTML = html;
  wireChips($("recentChips"));
  recentDays.forEach((d, k) => drawFva(d, k));
}

// Forecast vs. what happened, for one scored day.
async function drawFva(d, k) {
  const el = $("fva" + k), leg = $("fvaL" + k);
  if (!el) return;
  const times = d.obs.hours.map((_, i) => d.windowStart + i * 3600e3);
  const ser = [{ name: "Actual", color: "var(--text)", width: 3, values: d.obs.hours.map(cvt) }];
  const snap = await snapshot(d.setDate || d.date);
  const markers = [];
  if (d.obs.rained) markers.push({ t: d.obs.rainStart, label: "rain began", color: "var(--rain)", width: 2 });
  const avgH = forecastHours(snap, d.loc, "avg", d.lead ?? 0);
  if (avgH) {
    const m = new Map(avgH.map(h => [h.t, h.temp]));
    ser.push({ name: "Average forecast", color: "var(--text-3)", dash: "5 4", values: times.map(t => cvt(m.get(t))) });
  }
  for (const id of state.sel) {
    const hs = forecastHours(snap, d.loc, id, d.lead ?? 0);
    if (!hs) continue;
    const m = new Map(hs.map(h => [h.t, h.temp]));
    ser.push({ name: srcShort(id), color: selColor(id), values: times.map(t => cvt(m.get(t))) });
    const rs = d.src[id]?.rainStart;
    if (rs) markers.push({ t: rs, color: selColor(id), dash: "3 3" });
  }
  leg.innerHTML = ser.map(s => `<span><span class="sw${s.dash ? " dash2" : ""}" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("") +
    (markers.length ? `<span><span class="sw vline"></span>Rain start (solid = actual, dashed = forecast)</span>` : "") +
    (!snap ? `<span class="miss">Saved forecast unavailable</span>` : !state.sel.length ? `<span class="miss">Tap sources above to add their forecasts</span>` : "");
  lineChart(el, times, ser, { tz: TZ, startLabel: "6am", markers, directLabels: false });
}

function renderLongTerm(loc) {
  const lead = acc.lead;
  document.querySelectorAll("#accLead button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.lead === lead)));
  // Late-set days cover only part of the window: shown in "Last 3 days", left out of long-term stats.
  const all = (acc.scores?.days || []).filter(d => locsFor(loc).includes(d.loc) && !d.partial && (d.lead ?? 0) === lead);
  const years = [...new Set((acc.scores?.days || []).map(d => d.date.slice(0, 4)))].sort().reverse();
  const sel = $("accPeriod");
  if (acc.period !== "all" && !years.includes(acc.period)) acc.period = "all";
  sel.innerHTML = `<option value="all">All-time</option>` + years.map(y => `<option value="${y}">${y}</option>`).join("");
  sel.value = acc.period;
  const days = acc.period === "all" ? all : all.filter(d => d.date.startsWith(acc.period));
  if (!days.length) {
    const msg = lead > 0 && (acc.scores?.days || []).length ? `No ${LEAD_NAMES[lead].toLowerCase()} forecasts scored yet. They start once forecasts saved ${lead} day${lead > 1 ? "s" : ""} earlier reach their day.` : emptyMsg();
    $("accOverall").innerHTML = `<tbody><tr><td class="l empty">${msg}</td></tr></tbody>`;
    $("accSeason").innerHTML = `<tbody><tr><td class="l empty">Nothing yet.</td></tr></tbody>`;
    return;
  }
  const ids = allIds(days);
  const ranked = ids.map(id => ({ id, a: aggregate(days, id) })).filter(r => r.a.n).sort((a, b) => (b.a.score ?? -1) - (a.a.score ?? -1));
  const bias = v => isNum(v) ? `${D(v, 1)} <span class="miss">${Math.abs(v) < 0.5 ? "" : v > 0 ? "warm" : "cold"}</span>` : "—";
  let rank = 0;
  $("accOverall").innerHTML = `<thead><tr><th>#</th><th style="text-align:left">Source</th><th>Score</th><th>Days</th>
      <th title="Average size of the high-temperature miss">High miss</th><th title="Average signed high miss: + runs warm, − runs cold">High bias</th><th>Highs ±3°F</th>
      <th>Low miss</th><th>Low bias</th><th>Lows ±3°F</th><th>Hourly miss</th>
      <th>Rain right</th><th title="Hits / misses / false alarms">Hit · Miss · False</th><th title="Average gap between forecast and actual rain start, for hits">Rain timing</th><th title="0 is perfect">Brier</th></tr></thead><tbody>` +
    ranked.map(r => { const a = r.a, ps = isPseudo(r.id); if (!ps) rank++; return `<tr class="${ps ? "blendrow" : ""}${!ps && rank === 1 ? " rank1" : ""}"><td data-label="#">${ps ? "" : rank}</td>${nameCell(r.id)}${td("Score", scoreBadge(a.score))}${td("Days", a.n)}
      ${td("High miss", A(a.hiMAE))}${td("High bias", bias(a.hiBias))}${td("Highs ±3°F", pct(a.hi3.ok, a.hi3.n))}
      ${td("Low miss", A(a.loMAE))}${td("Low bias", bias(a.loBias))}${td("Lows ±3°F", pct(a.lo3.ok, a.lo3.n))}${td("Hourly miss", A(a.mae))}
      ${td("Rain right", isNum(a.rainRight) ? Math.round(a.rainRight * 100) + "%" : "—")}${td("Hit · Miss · False", `${a.rain.hit} · ${a.rain.miss} · ${a.rain.false}`)}
      ${td("Rain timing", isNum(a.timing) ? "±" + a.timing.toFixed(1) + "h" + (Math.abs(a.timingBias) >= 0.5 ? ` <span class="miss">${a.timingBias > 0 ? "late" : "early"}</span>` : "") : "—")}
      ${td("Brier", isNum(a.brier) ? a.brier.toFixed(2) : "—")}</tr>`; }).join("") + `</tbody>`;

  // Seasons: one row per source, columns for the four seasons and wet/dry.
  const cols = [["Winter", metSeason], ["Spring", metSeason], ["Summer", metSeason], ["Fall", metSeason], ["Wet", wetSeason], ["Dry", wetSeason]];
  const nDays = name => new Set(days.filter(d => cols.find(c => c[0] === name)[1](d.date) === name).map(d => d.date)).size;
  $("accSeason").innerHTML = `<thead><tr><th style="text-align:left">Source</th>${cols.map(([n], i) => `<th class="${i === 4 ? "sep" : ""}">${n === "Wet" ? "Wet (Nov–Apr)" : n === "Dry" ? "Dry (May–Oct)" : n}<div class="sub2">${nDays(n) ? nDays(n) + " d" : ""}</div></th>`).join("")}</tr></thead><tbody>` +
    ranked.map(r => `<tr class="${isPseudo(r.id) ? "blendrow" : ""}">${nameCell(r.id)}` + cols.map(([n, fn], i) => { const a = aggregate(days.filter(d => fn(d.date) === n), r.id); return td(n, a.n ? scoreBadge(a.score) : `<span class="miss">—</span>`, i === 4 ? "sep" : ""); }).join("") + `</tr>`).join("") + `</tbody>`;
}

// ---------- Controls ----------
document.querySelectorAll("#accLoc button").forEach(b => b.addEventListener("click", () => {
  acc.loc = b.dataset.loc; store.set("wc.accLoc", acc.loc); renderAccuracy();
}));
document.querySelectorAll("#accLead button").forEach(b => b.addEventListener("click", () => { acc.lead = +b.dataset.lead; renderAccuracy(); }));
document.getElementById("accPeriod").addEventListener("change", e => { acc.period = e.target.value; renderAccuracy(); });
