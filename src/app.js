import { PRESETS, PENDING_SOURCES, SOURCES, setKeyProvider, isRainyHour, localHourStart, icon, catLabel, isNum, mean, mode, dayKey, localHour } from "./sources.js";
import { initAccuracy, renderAccuracy } from "./accuracy.js";

const HOURS = 30;
const DAYS = 5;
const REFRESH_MS = 15 * 60 * 1000;

// ---------- Storage (best effort) ----------
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- State ----------
export const state = {
  loc: store.get("wc.loc", PRESETS.vallejo),
  units: store.get("wc.units", "F"),
  results: {},
  fetchedAt: null,
  run: 0,
};

// API keys entered in Settings, stored only on this device.
const getKeys = () => store.get("wc.keys", {});
setKeyProvider(id => getKeys()[id]);

// ---------- Formatting ----------
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const T = f => !isNum(f) ? "—" : Math.round(state.units === "F" ? f : (f - 32) * 5 / 9) + "°";
// A temperature difference (no offset when converting).
export const D = (d, digits = 0) => { if (!isNum(d)) return "—"; const v = state.units === "F" ? d : d * 5 / 9; const r = +v.toFixed(digits); return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r).toFixed(digits) + "°"; };
export const A = (d, digits = 1) => !isNum(d) ? "—" : (state.units === "F" ? d : d * 5 / 9).toFixed(digits) + "°";
const W = mph => !isNum(mph) ? "—" : state.units === "F" ? Math.round(mph) + " mph" : Math.round(mph * 1.609) + " km/h";
const P = p => !isNum(p) ? "—" : Math.round(p) + "%";
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const dir = d => typeof d === "string" ? d : isNum(d) ? COMPASS[Math.round(d / 22.5) % 16] : "";
export const fmtHour = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" }).format(ms).replace(":00", "").replace(" ", "").toLowerCase();
export const fmtDay = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(ms);
export const fmtDayLong = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(ms);
export const fmtTime = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms).replace(" ", "").toLowerCase();
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  return h < 24 ? h + " hr ago" : Math.round(h / 24) + " d ago";
}
function nextDays(tz, n) {
  const out = [], seen = new Set();
  for (let t = Date.now(); out.length < n; t += 6 * 3600e3) {
    const k = dayKey(t, tz);
    if (!seen.has(k)) { seen.add(k); out.push({ key: k, ms: t }); }
  }
  return out;
}
const hourGrid = () => { const t0 = Math.floor(Date.now() / 3600e3) * 3600e3; return Array.from({ length: HOURS }, (_, i) => t0 + i * 3600e3); };
const cvt = f => !isNum(f) ? null : state.units === "F" ? f : (f - 32) * 5 / 9;

// ---------- Fetch orchestration ----------
// Sources with API keys have tight free limits (Tomorrow.io: 25 requests/hour), so reuse a
// recent result for the same place instead of asking again. The ↻ button forces a refresh.
const CACHE_MS = 10 * 60 * 1000;
const cacheKey = (s, loc) => `wc.cache.${s.id}.${(+loc.lat).toFixed(3)},${(+loc.lon).toFixed(3)}`;
async function fetchSource(s, loc, signal, force) {
  if (!s.key) return s.fetch(loc, signal);
  const k = cacheKey(s, loc), hit = store.get(k, null);
  if (!force && hit && Date.now() - hit.at < (s.cacheMin ? s.cacheMin * 60e3 : CACHE_MS)) return hit.data;
  const data = await s.fetch(loc, signal);
  store.set(k, { at: Date.now(), data });
  return data;
}
function friendlyError(e) {
  if (e.friendly) return e.message;
  if (e.status === 401 || e.status === 403) return "Key was rejected. Check it in ⚙️ Settings.";
  if (e.status === 429) return "Free-plan request limit reached. It will come back on its own.";
  return "Couldn't load (" + (e.message || "network error") + ")";
}

let controller = null;
async function loadAll(force = false) {
  controller?.abort();
  controller = new AbortController();
  const run = ++state.run;
  const loc = state.loc;
  for (const s of SOURCES) state.results[s.id] = { status: "loading" };
  renderAll();
  await Promise.all(SOURCES.map(async s => {
    try {
      const data = await fetchSource(s, loc, controller.signal, force);
      if (run !== state.run) return;
      state.results[s.id] = { status: "ok", data };
      if (s.id === "nws" && data.place && loc.autoName) { loc.name = data.place; delete loc.autoName; store.set("wc.loc", loc); }
    } catch (e) {
      if (run !== state.run || e.name === "AbortError") return;
      console.warn(s.id, e);
      state.results[s.id] = { status: e.nokey ? "nokey" : "error", error: friendlyError(e) };
    }
    renderAll();
  }));
  if (run === state.run) { state.fetchedAt = Date.now(); renderStatus(); }
}
const okSources = () => SOURCES.filter(s => state.results[s.id]?.status === "ok");

// ---------- Rendering ----------
function renderAll() {
  renderHeader();
  renderStatus();
  renderCards();
  renderAverage();
  renderDaily();
  renderHourly();
}

function renderHeader() {
  $("locLabel").textContent = state.loc.name + " · " + (+state.loc.lat).toFixed(2) + ", " + (+state.loc.lon).toFixed(2);
  document.querySelectorAll(".preset").forEach(b => b.setAttribute("aria-pressed", String(PRESETS[b.dataset.preset].name === state.loc.name)));
  $("unitBtn").textContent = state.units === "F" ? "°F" : "°C";
  document.title = "Weather · " + state.loc.name;
}

function renderStatus() {
  const n = okSources().length, loading = SOURCES.filter(s => state.results[s.id]?.status === "loading").length;
  const active = SOURCES.filter(s => state.results[s.id]?.status !== "nokey").length;
  const parts = [loading ? `Loading ${loading} source${loading > 1 ? "s" : ""}…` : `${n} of ${active} sources loaded`];
  if (state.fetchedAt) parts.push("Updated " + fmtTime(state.fetchedAt, Intl.DateTimeFormat().resolvedOptions().timeZone));
  $("statusLine").innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join("");
}

function renderCards() {
  const tz = state.loc.tz;
  const today = dayKey(Date.now(), tz);
  $("cards").innerHTML = SOURCES.map(s => {
    const r = state.results[s.id] || { status: "loading" };
    const head = `<div class="src"><a href="${esc(s.site)}" target="_blank" rel="noopener">${esc(s.name)}</a>${r.status === "ok" ? `<span class="ago">${esc(ago(r.data.current.observedAt))}</span>` : ""}</div>`;
    if (r.status === "loading") return `<div class="card loading" style="--c:${s.color}">${head}<div class="big"><span class="t">··</span></div><div class="cond">Loading…</div></div>`;
    if (r.status === "nokey") return `<div class="card err" style="--c:${s.color}">${head}<div class="big"><span class="t">—</span></div><div class="cond">Needs an API key on this device.</div><button class="btn addkey" data-open-settings>⚙️ Add key</button></div>`;
    if (r.status === "error") return `<div class="card err" style="--c:${s.color}">${head}<div class="big"><span class="t">—</span></div><div class="cond">${esc(r.error)}</div></div>`;
    const c = r.data.current, d = r.data.daily[today];
    return `<div class="card" style="--c:${s.color}">${head}
      <div class="big"><span class="i" aria-hidden="true">${icon(c.cat, c.night)}</span><span class="t">${T(c.temp)}</span></div>
      <div class="cond">${esc(c.text)}</div>
      <dl class="kv">
        <dt>Feels like</dt><dd>${T(c.feels)}</dd>
        <dt>Humidity</dt><dd>${P(c.humidity)}</dd>
        <dt>Wind</dt><dd>${W(c.wind)} ${esc(dir(c.windDir))}</dd>
        <dt>Today</dt><dd>${d ? `${T(d.hi)} / ${T(d.lo)}${d.partial ? " <span title='Rest of today only'>*</span>" : ""}` : "—"}</dd>
        <dt>Source</dt><dd>${esc(r.data.note)}</dd>
      </dl></div>`;
  }).join("");
  $("cards").querySelectorAll("[data-open-settings]").forEach(b => b.addEventListener("click", openSettings));
  $("pending").innerHTML = PENDING_SOURCES.length ? "Coming once you add API keys: " + PENDING_SOURCES.map(n => `<span class="chip">${esc(n)}</span>`).join("") : "";
}

function renderAverage() {
  const ok = okSources(), tz = state.loc.tz;
  if (!ok.length) {
    const loading = SOURCES.some(s => state.results[s.id]?.status === "loading");
    $("avgNow").innerHTML = `<div class="cond">${loading ? "Waiting for data…" : "No sources available."}</div>`;
    $("avgDays").innerHTML = ""; $("avgChart").innerHTML = ""; $("avgLegend").innerHTML = "";
    return;
  }
  const cur = ok.map(s => state.results[s.id].data.current);
  const temps = cur.map(c => c.temp).filter(isNum);
  const night = cur[0].night;
  const cat = mode(cur.map(c => c.cat));
  $("avgNow").innerHTML = `
    <div class="src" style="font-weight:600;font-size:14px">Now · ${ok.length} source${ok.length > 1 ? "s" : ""}</div>
    <div class="big"><span class="i" aria-hidden="true">${icon(cat, night)}</span><span class="t">${T(mean(temps))}</span></div>
    <div class="cond">${esc(catLabel(cat, night))}</div>
    <div class="spread">Range ${T(Math.min(...temps))} to ${T(Math.max(...temps))}</div>
    <dl class="kv" style="margin-top:8px">
      <dt>Feels like</dt><dd>${T(mean(cur.map(c => c.feels)))}</dd>
      <dt>Humidity</dt><dd>${P(mean(cur.map(c => c.humidity)))}</dd>
      <dt>Wind</dt><dd>${W(mean(cur.map(c => c.wind)))}</dd>
    </dl>`;

  const nowHour = Math.floor(Date.now() / 3600e3) * 3600e3;
  $("avgDays").innerHTML = nextDays(tz, DAYS).map((d, i) => {
    const ds = ok.map(s => state.results[s.id].data.daily[d.key]).filter(Boolean);
    const his = ds.map(x => x.hi).filter(isNum), los = ds.map(x => x.lo).filter(isNum);
    const c = mode(ds.map(x => x.cat));
    const avgPop = mean(ds.map(x => x.pop));
    const rain = isNum(avgPop) && avgPop > RAIN_SHOW_POP ? avgRainStart(ok, d.key, i === 0 ? nowHour : null) : null;
    return `<div class="day">
      <div class="dn">${i === 0 ? "Today" : fmtDay(d.ms, tz)}</div>
      <div class="di" aria-hidden="true">${ds.length ? icon(c, false) : ""}</div>
      <div class="hl">${T(mean(his))} <span class="lo">${T(mean(los))}</span></div>
      <div class="pp">💧 ${P(avgPop)}</div>
      ${rain ? `<div class="rs" title="Average of when each source has rain starting (${rain.n} of ${rain.of} sources call for rain that day)">🌧️ ${rain.now ? "now" : "~" + esc(fmtTime(rain.t, tz))}<span class="rsn"> · ${rain.n}/${rain.of}</span></div>` : ""}
      <div class="rg" title="Range of highs across sources">${his.length > 1 ? `highs ${T(Math.min(...his))}–${T(Math.max(...his))}` : "&nbsp;"}</div>
    </div>`;
  }).join("");

  const grid = hourGrid();
  const maps = ok.map(s => new Map(state.results[s.id].data.hourly.map(h => [h.t, h])));
  const avg = [], lo = [], hi = [];
  for (const t of grid) {
    const v = maps.map(m => m.get(t)?.temp).filter(isNum);
    avg.push(v.length ? mean(v) : null); lo.push(v.length ? Math.min(...v) : null); hi.push(v.length ? Math.max(...v) : null);
  }
  const ser = [{ name: "Average", color: "var(--avg)", values: avg.map(cvt), band: [lo.map(cvt), hi.map(cvt)], extra: i => `<div class="row"><span>Range</span><span>${T(lo[i])} – ${T(hi[i])}</span></div>` }];
  $("avgLegend").innerHTML = `<span><span class="sw" style="background:var(--avg)"></span>Average temperature</span>` + (ok.length > 1 ? `<span><span class="sw band"></span>Lowest–highest source</span>` : "");
  lineChart($("avgChart"), grid, ser, { tz });
}

// Average rain start for a local day: each source's first rainy hour that day, averaged.
// Only shown when the average rain chance for the day is above this.
const RAIN_SHOW_POP = 40;
function avgRainStart(ok, key, fromT) {
  const tz = state.loc.tz;
  const start = fromT ?? localHourStart(key, 0, tz), end = localHourStart(dayKey(localHourStart(key, 12, tz) + 24 * 3600e3, tz), 0, tz);
  const starts = [];
  let of = 0;
  for (const s of ok) {
    const hrs = state.results[s.id].data.hourly.filter(h => h.t >= start && h.t < end);
    if (hrs.length < 6) continue;          // source doesn't forecast hourly that far out
    of++;
    const r = hrs.find(isRainyHour);
    if (r) starts.push(r.t);
  }
  if (!starts.length) return null;
  const t = Math.round(mean(starts) / 1800e3) * 1800e3;   // nearest half hour
  return { t, now: fromT != null && t <= fromT, n: starts.length, of };
}

function renderDaily() {
  const tz = state.loc.tz, days = nextDays(tz, DAYS);
  const ok = okSources();
  let html = `<thead><tr><th></th>${days.map((d, i) => `<th>${i === 0 ? "Today" : esc(fmtDayLong(d.ms, tz))}</th>`).join("")}</tr></thead><tbody>`;
  for (const s of SOURCES) {
    const r = state.results[s.id];
    html += `<tr><th style="--c:${s.color}"><span class="sw"></span>${esc(s.short)}</th>`;
    if (r?.status !== "ok") {
      html += `<td colspan="${DAYS}" class="cell na">${r?.error ? esc(r.error) : "Loading…"}</td></tr>`;
      continue;
    }
    for (const d of days) {
      const x = r.data.daily[d.key];
      if (!x) { html += `<td class="cell na">—</td>`; continue; }
      html += `<td class="cell" title="${esc(x.text || catLabel(x.cat))}${x.partial ? " (rest of today only)" : ""}${x.nightOnly ? " (tonight)" : ""}">
        <span class="ci" aria-hidden="true">${icon(x.cat, !!x.nightOnly)}</span>
        <span class="ct">${T(x.hi)} <span class="lo">${T(x.lo)}</span>${x.partial ? "*" : ""}</span>
        <span class="cp">💧 ${P(x.pop)}</span></td>`;
    }
    html += `</tr>`;
  }
  if (ok.length > 1) {
    html += `<tr class="avgrow"><th>Average</th>`;
    for (const d of days) {
      const ds = ok.map(s => state.results[s.id].data.daily[d.key]).filter(Boolean);
      html += `<td class="cell"><span class="ci" aria-hidden="true">${ds.length ? icon(mode(ds.map(x => x.cat)), false) : ""}</span>
        <span class="ct">${T(mean(ds.map(x => x.hi)))} <span class="lo">${T(mean(ds.map(x => x.lo)))}</span></span>
        <span class="cp">💧 ${P(mean(ds.map(x => x.pop)))}</span></td>`;
    }
    html += `</tr>`;
  }
  $("dailyTable").innerHTML = html + `</tbody>`;
}

function renderHourly() {
  const tz = state.loc.tz, grid = hourGrid(), ok = okSources();
  const ser = ok.map(s => {
    const m = new Map(state.results[s.id].data.hourly.map(h => [h.t, h]));
    return { name: s.short, color: s.color, values: grid.map(t => cvt(m.get(t)?.temp)), pops: grid.map(t => m.get(t)?.pop) };
  });
  if (ok.length > 1) ser.push({ name: "Average", color: "var(--avg)", dash: true, values: grid.map((_, i) => mean(ser.map(x => x.values[i]))) });
  $("hourLegend").innerHTML = ser.map(x => `<span><span class="sw${x.dash ? " dash" : ""}" style="background:${x.color}"></span>${esc(x.name)}</span>`).join("");
  if (ok.length) lineChart($("hourChart"), grid, ser, { tz, directLabels: true, extra: (x, i) => x.pops && isNum(x.pops[i]) ? ` <span style="color:var(--text-3)">💧${Math.round(x.pops[i])}%</span>` : "" });
  else $("hourChart").innerHTML = "";

  const dayCells = []; let lastDay = null;
  grid.forEach((t, i) => {
    const k = dayKey(t, tz);
    if (k !== lastDay) { dayCells.push({ label: i === 0 ? "Today" : fmtDayLong(t, tz), span: 0 }); lastDay = k; }
    dayCells[dayCells.length - 1].span++;
  });
  const head1 = `<tr class="dayrow"><th></th>` + dayCells.map(d => `<th colspan="${d.span}">${esc(d.label)}</th>`).join("") + `</tr>`;
  let prev = null;
  const newDay = grid.map(t => { const k = dayKey(t, tz); const nd = prev !== null && k !== prev; prev = k; return nd; });
  const head2 = `<tr><th></th>` + grid.map((t, i) => `<th class="${newDay[i] ? "newday" : ""}">${i === 0 ? "Now" : esc(fmtHour(t, tz))}</th>`).join("") + `</tr>`;
  let body = "";
  for (const s of SOURCES) {
    const r = state.results[s.id];
    body += `<tr><th style="--c:${s.color}"><span class="sw"></span>${esc(s.short)}</th>`;
    if (r?.status !== "ok") { body += `<td colspan="${HOURS}" class="cell na" style="text-align:left">${r?.error ? esc(r.error) : "Loading…"}</td></tr>`; continue; }
    const m = new Map(r.data.hourly.map(h => [h.t, h]));
    body += grid.map((t, i) => {
      const h = m.get(t);
      if (!h) return `<td class="cell na ${newDay[i] ? "newday" : ""}">—</td>`;
      return `<td class="cell ${newDay[i] ? "newday" : ""}" title="${esc(h.text)} · wind ${esc(W(h.wind))}"><span class="ci" aria-hidden="true">${icon(h.cat, h.night)}</span><span class="ct">${T(h.temp)}</span><span class="cp">${isNum(h.pop) ? Math.round(h.pop) + "%" : "–"}</span></td>`;
    }).join("") + `</tr>`;
  }
  $("hourlyTable").innerHTML = `<thead>${head1}${head2}</thead><tbody>${body}</tbody>`;
}

// ---------- Line chart (inline SVG) ----------
function lineChart(el, times, series, opts = {}) {
  el._args = [times, series, opts];
  const W = Math.max(280, el.clientWidth || 600);
  const H = W < 500 ? 200 : 240;
  const m = { l: 34, r: opts.directLabels && W >= 480 ? 78 : 12, t: 12, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const all = [];
  for (const s of series) { all.push(...s.values.filter(isNum)); if (s.band) all.push(...s.band[0].filter(isNum), ...s.band[1].filter(isNum)); }
  if (!all.length) { el.innerHTML = `<div class="cond">No hourly data.</div>`; return; }
  let lo = Math.min(...all), hi = Math.max(...all);
  const step = (hi - lo) > 25 ? 10 : 5;
  lo = Math.floor((lo - 1) / step) * step; hi = Math.ceil((hi + 1) / step) * step;
  if (hi - lo < step * 2) hi = lo + step * 2;
  const x = i => m.l + (times.length === 1 ? 0 : i / (times.length - 1)) * iw;
  const y = v => m.t + (1 - (v - lo) / (hi - lo)) * ih;
  const path = vals => { let d = "", pen = false; vals.forEach((v, i) => { if (isNum(v)) { d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); pen = true; } else pen = false; }); return d; };
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Hourly temperature chart">`;
  for (let v = lo; v <= hi; v += step) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}°</text>`;
  const tz = opts.tz;
  times.forEach((t, i) => {
    const hr = localHour(t, tz);
    if (i === 0 || hr % 6 === 0) {
      if (i !== 0 && i < 3) return;
      const label = i === 0 ? "Now" : hr === 0 ? fmtDay(t, tz) : fmtHour(t, tz);
      svg += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : "middle"}"${hr === 0 ? ' style="font-weight:600;fill:var(--text-2)"' : ""}>${esc(label)}</text>`;
      if (hr === 0) svg += `<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${m.t + ih}" stroke-dasharray="2 3"/>`;
    }
  });
  for (const s of series) if (s.band) {
    const [bl, bh] = s.band;
    const idx = bl.map((v, i) => i).filter(i => isNum(bl[i]) && isNum(bh[i]));
    if (idx.length) svg += `<path d="${idx.map((i, k) => (k ? "L" : "M") + x(i) + "," + y(bh[i])).join("") + idx.slice().reverse().map(i => "L" + x(i) + "," + y(bl[i])).join("")}Z" fill="var(--band)"/>`;
  }
  for (const s of series) svg += `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="5 4"' : ""}/>`;
  if (opts.directLabels && m.r > 20) {
    const ends = series.map(s => { let i = s.values.length - 1; while (i >= 0 && !isNum(s.values[i])) i--; return i >= 0 ? { s, yy: y(s.values[i]), i } : null; }).filter(Boolean).sort((a, b) => a.yy - b.yy);
    for (let k = 1; k < ends.length; k++) if (ends[k].yy - ends[k - 1].yy < 13) ends[k].yy = ends[k - 1].yy + 13;
    for (const e of ends) svg += `<text class="dl" x="${x(e.i) + 6}" y="${e.yy + 4}">${esc(e.s.name)}</text>`;
  }
  svg += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="var(--text-3)" stroke-width="1" style="display:none"/>`;
  svg += `<g class="dots"></g><rect x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent" class="hit"/></svg>`;
  el.innerHTML = svg + `<div class="tip"></div>`;
  const svgEl = el.querySelector("svg"), tip = el.querySelector(".tip"), xh = el.querySelector(".xh"), dots = el.querySelector(".dots");
  const show = ev => {
    const r = svgEl.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(times.length - 1, Math.round((px - m.l) / iw * (times.length - 1))));
    xh.setAttribute("x1", x(i)); xh.setAttribute("x2", x(i)); xh.style.display = "";
    dots.innerHTML = series.filter(s => isNum(s.values[i])).map(s => `<circle cx="${x(i)}" cy="${y(s.values[i])}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join("");
    tip.innerHTML = `<div class="tt">${esc(fmtDay(times[i], tz))} ${esc(fmtHour(times[i], tz))}</div>` +
      series.map(s => `<div class="row"><span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span><span>${isNum(s.values[i]) ? Math.round(s.values[i]) + "°" : "—"}${opts.extra ? opts.extra(s, i) : ""}</span></div>${s.extra ? s.extra(i) : ""}`).join("");
    tip.style.display = "block";
    const sx = x(i) * (r.width / W), tw = tip.offsetWidth;
    tip.style.left = (sx + 14 + tw > r.width ? sx - 14 - tw : sx + 14) + "px";
    tip.style.top = "8px";
  };
  const hide = () => { tip.style.display = "none"; xh.style.display = "none"; dots.innerHTML = ""; };
  const hit = el.querySelector(".hit");
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
}
let rsz;
window.addEventListener("resize", () => {
  clearTimeout(rsz);
  rsz = setTimeout(() => ["avgChart", "hourChart"].forEach(id => { const el = $(id); if (el._args) lineChart(el, ...el._args); }), 150);
});

// ---------- Settings (API keys) ----------
function openSettings() {
  const keys = getKeys();
  $("keyRows").innerHTML = SOURCES.filter(s => s.key).map(s => `
    <div class="keyrow">
      <label for="key_${s.id}">${esc(s.name)} <a href="${esc(s.key.signup)}" target="_blank" rel="noopener">Get a key ↗</a></label>
      <input id="key_${s.id}" data-id="${s.id}" type="password" autocomplete="off" spellcheck="false" placeholder="Paste key" value="${esc(keys[s.id] || "")}">
    </div>`).join("") + (PENDING_SOURCES.length ? `<p class="hint" style="margin-top:14px">More sources (${esc(PENDING_SOURCES.join(", "))}) will appear here as they're added.</p>` : "");
  $("keyRows").querySelectorAll("input").forEach(i => {
    i.addEventListener("focus", () => i.type = "text");
    i.addEventListener("blur", () => i.type = "password");
  });
  $("settings").showModal();
}
$("settingsBtn").addEventListener("click", openSettings);
$("settings").addEventListener("close", () => {
  if ($("settings").returnValue !== "save") return;
  const keys = getKeys();
  $("keyRows").querySelectorAll("input").forEach(i => { const v = i.value.trim(); if (v) keys[i.dataset.id] = v; else delete keys[i.dataset.id]; });
  store.set("wc.keys", keys);
  loadAll(true);
});

// ---------- Tabs ----------
function showTab(name) {
  const acc = name === "accuracy";
  $("tabForecast").setAttribute("aria-selected", String(!acc));
  $("tabAccuracy").setAttribute("aria-selected", String(acc));
  $("viewForecast").hidden = acc;
  $("viewAccuracy").hidden = !acc;
  if (location.hash !== (acc ? "#accuracy" : "")) history.replaceState(null, "", acc ? "#accuracy" : location.pathname + location.search);
  if (acc) renderAccuracy();
}
$("tabForecast").addEventListener("click", () => showTab("forecast"));
$("tabAccuracy").addEventListener("click", () => showTab("accuracy"));

// ---------- Location controls ----------
function setLocation(loc) {
  state.loc = loc;
  store.set("wc.loc", loc);
  loadAll();
}
document.querySelectorAll(".preset").forEach(b => b.addEventListener("click", () => setLocation({ ...PRESETS[b.dataset.preset] })));
$("refreshBtn").addEventListener("click", () => { loadAll(true); initAccuracy(true); });
$("unitBtn").addEventListener("click", () => { state.units = state.units === "F" ? "C" : "F"; store.set("wc.units", state.units); renderAll(); renderAccuracy(); });
$("geoBtn").addEventListener("click", () => {
  if (!navigator.geolocation) return alert("Location isn't available in this browser.");
  $("geoBtn").textContent = "📍 …";
  navigator.geolocation.getCurrentPosition(pos => {
    $("geoBtn").textContent = "📍 Me";
    setLocation({ name: "My location", autoName: true, lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, country: null });
  }, err => { $("geoBtn").textContent = "📍 Me"; alert("Couldn't get your location: " + err.message); }, { timeout: 15000, maximumAge: 600000 });
});

const US_STATES = { Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",Delaware:"DE",Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",Mississippi:"MS",Missouri:"MO",Montana:"MT",Nebraska:"NE",Nevada:"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",Washington:"WA","West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY","District of Columbia":"DC" };
const q = $("q"), sug = $("suggest");
let qTimer, qCtl;
q.addEventListener("input", () => {
  clearTimeout(qTimer);
  const term = q.value.trim();
  if (term.length < 2) { sug.hidden = true; return; }
  qTimer = setTimeout(async () => {
    qCtl?.abort(); qCtl = new AbortController();
    try {
      const r0 = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=${encodeURIComponent(term)}`, { signal: qCtl.signal });
      const res = (await r0.json()).results || [];
      sug.innerHTML = res.length ? res.map((r, i) => `<li><button data-i="${i}">${esc(r.name)} <span class="sub">${esc([r.admin1, r.country].filter(Boolean).join(", "))}</span></button></li>`).join("") : `<li><button disabled>No matches</button></li>`;
      sug.hidden = false;
      sug.querySelectorAll("button[data-i]").forEach(b => b.addEventListener("click", () => {
        const r = res[+b.dataset.i];
        const region = r.country_code === "US" && r.admin1 ? (US_STATES[r.admin1] || r.admin1) : r.country;
        setLocation({ name: `${r.name}, ${region}`, lat: r.latitude, lon: r.longitude, tz: r.timezone || "UTC", country: r.country_code });
        q.value = ""; sug.hidden = true; q.blur();
        showTab("forecast");
      }));
    } catch (e) { if (e.name !== "AbortError") { sug.innerHTML = `<li><button disabled>Search failed</button></li>`; sug.hidden = false; } }
  }, 300);
});
q.addEventListener("keydown", e => {
  if (e.key === "Escape") sug.hidden = true;
  if (e.key === "ArrowDown") { e.preventDefault(); sug.querySelector("button")?.focus(); }
  if (e.key === "Enter") { e.preventDefault(); sug.querySelector("button[data-i]")?.click(); }
});
sug.addEventListener("keydown", e => {
  const items = [...sug.querySelectorAll("button")], i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); i <= 0 ? q.focus() : items[i - 1].focus(); }
  if (e.key === "Escape") { sug.hidden = true; q.focus(); }
});
document.addEventListener("click", e => { if (!e.target.closest(".search")) sug.hidden = true; });

// ---------- Go ----------
loadAll();
initAccuracy();
showTab(location.hash === "#accuracy" ? "accuracy" : "forecast");
setInterval(() => { if (document.visibilityState === "visible") loadAll(); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.fetchedAt && Date.now() - state.fetchedAt > REFRESH_MS) { loadAll(); initAccuracy(true); }
});
