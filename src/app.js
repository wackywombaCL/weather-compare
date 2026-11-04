import { PROXY_URL } from "./config.js";
import { PRESETS, PENDING_SOURCES, SOURCES, setKeyProvider, setProxy, isRainyHour, localHourStart, icon, catLabel, isNum, mean, mode, dayKey, localHour } from "./sources.js";
import { recentScores, smartWeights, rating, MIN_DAYS_FOR_WEIGHT, elementSkill, elementWeights, elementLeader, ELEMENTS, BEST_MIN_DAYS } from "./skill.js";
import { initAccuracy, renderAccuracy, accData } from "./accuracy.js";

const HOURS = 30;
const DAYS = 5;
const REFRESH_MS = 15 * 60 * 1000;
const MAX_SELECTED = 4;

// ---------- Storage (best effort) ----------
import { store, $, esc, T, R } from "./common.js";
export { store, $, esc, T, R };

// ---------- State ----------
export const state = {
  loc: store.get("wc.loc", PRESETS.vallejo),
  units: store.get("wc.units", "F"),
  avgMode: store.get("wc.avgMode", "smart"),
  sel: store.get("wc.sel", []),           // sources drawn on charts, in selection order
  slots: store.get("wc.slots", {}),       // source id -> color slot (stable while selected)
  results: {},
  fetchedAt: null,
  run: 0,
};
const getKeys = () => store.get("wc.keys", {});
setKeyProvider(id => getKeys()[id]);
// Access code for the shared key server. A link like …/#code=XXXX saves it on this device.
{
  const m = location.hash.match(/(?:^#|&)code=([^&]+)/);
  if (m) { store.set("wc.code", decodeURIComponent(m[1])); history.replaceState(null, "", location.pathname + location.search); }
}
const applyProxy = () => setProxy({ url: store.get("wc.proxyUrl", "") || PROXY_URL, code: store.get("wc.code", "") });
applyProxy();

// ---------- Formatting ----------
export const D = (d, digits = 0) => { if (!isNum(d)) return "—"; const v = state.units === "F" ? d : d * 5 / 9; const r = +v.toFixed(digits); return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r).toFixed(digits) + "°"; };
export const A = (d, digits = 1) => !isNum(d) ? "—" : (state.units === "F" ? d : d * 5 / 9).toFixed(digits) + "°";
const W = mph => !isNum(mph) ? "—" : state.units === "F" ? Math.round(mph) + " mph" : Math.round(mph * 1.609) + " km/h";
const P = p => !isNum(p) ? "—" : Math.round(p) + "%";
const wetAmt = inch => isNum(inch) && inch >= 0.005;
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
export const cvt = f => !isNum(f) ? null : state.units === "F" ? f : (f - 32) * 5 / 9;
export const srcName = id => SOURCES.find(s => s.id === id)?.name || accData()?.scores?.sources?.[id]?.name || id;
export const srcShort = id => SOURCES.find(s => s.id === id)?.short || accData()?.scores?.sources?.[id]?.short || id;

// ---------- Recent accuracy (green → red) ----------
const trackedLocs = () => (state.loc.id === "vallejo" || state.loc.id === "napa") ? [state.loc.id] : null;
let recentCache = null;
export function recent() {
  const days = accData()?.scores?.days;
  if (!days) return { scores: {}, dates: [] };
  const key = `${days.length}|${trackedLocs()}`;
  if (recentCache?.key !== key) recentCache = { key, ...recentScores(days, { locs: trackedLocs(), lead: 0, n: 7 }) };
  return recentCache;
}
export function badge(id, { compact = false } = {}) {
  const r = recent().scores[id];
  if (!r) return `<span class="badge b-none" title="No accuracy scores yet">${compact ? "new" : "Not scored yet"}</span>`;
  const g = rating(r.score);
  const where = trackedLocs() ? "" : " at Vallejo + Napa";
  return `<span class="badge b-${g.key}" title="Accuracy score over the last ${r.n} scored day${r.n > 1 ? "s" : ""}${where} (0–100)"><i></i>${Math.round(r.score)}${compact ? "" : " · " + g.label}</span>`;
}
const recentScoreOf = id => recent().scores[id]?.score ?? -1;
// Sources sorted best recent accuracy first; ones without keys last.
function orderedSources() {
  const rank = s => { const r = state.results[s.id]?.status; return r === "nokey" ? 3 : r === "error" ? 2 : 0; };
  return [...SOURCES].sort((a, b) => rank(a) - rank(b) || recentScoreOf(b.id) - recentScoreOf(a.id) || SOURCES.indexOf(a) - SOURCES.indexOf(b));
}

// ---------- Plain vs smart average ----------
function weightsFor(ids) {
  if (state.avgMode !== "smart") return null;
  return smartWeights(recentScores(accData()?.scores?.days || [], { locs: trackedLocs(), lead: 0, n: 14 }).scores, ids);
}
function wmean(pairs, weights) {   // pairs: [[id, value]]
  const v = pairs.filter(([, x]) => isNum(x));
  if (!v.length) return null;
  if (!weights) return mean(v.map(([, x]) => x));
  const w = v.map(([id]) => weights[id] ?? 0), tw = w.reduce((a, b) => a + b, 0);
  return tw ? v.reduce((s, [, x], i) => s + x * w[i], 0) / tw : mean(v.map(([, x]) => x));
}

// ---------- Chart selection (tap a source to draw it; colors stick while selected) ----------
export function isSelected(id) { return state.sel.includes(id); }
export function slotOf(id) { return state.slots[id] ?? null; }
export function toggleSel(id) {
  if (isSelected(id)) { state.sel = state.sel.filter(x => x !== id); delete state.slots[id]; }
  else {
    if (state.sel.length >= MAX_SELECTED) { const drop = state.sel.shift(); delete state.slots[drop]; }
    const used = new Set(Object.values(state.slots));
    let k = 1; while (used.has(k)) k++;
    state.sel.push(id); state.slots[id] = k;
  }
  store.set("wc.sel", state.sel); store.set("wc.slots", state.slots);
}
export const selColor = id => `var(--c${slotOf(id)})`;

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
  let pending = 0;
  const flush = () => { if (!pending++) requestAnimationFrame(() => { pending = 0; if (run === state.run) renderAll(); }); };
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
    flush();
  }));
  if (run === state.run) { state.fetchedAt = Date.now(); renderAll(); }
}
const okSources = () => orderedSources().filter(s => state.results[s.id]?.status === "ok");

// ---------- Rendering ----------
export function renderAll() {
  renderHeader();
  renderStatus();
  renderBest();
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
  if (!navigator.onLine) parts.push("Offline: showing saved data");
  $("statusLine").innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join("");
}

function renderCards() {
  const tz = state.loc.tz;
  const today = dayKey(Date.now(), tz);
  $("cards").innerHTML = orderedSources().map(s => {
    const r = state.results[s.id] || { status: "loading" };
    const rs = recent().scores[s.id], g = rs ? rating(rs.score) : null;
    const head = `<div class="src"><a href="${esc(s.site)}" target="_blank" rel="noopener">${esc(s.name)}</a>${badge(s.id, { compact: true })}</div>`;
    const cls = `card ${g ? "r-" + g.key : ""}`;
    if (r.status === "loading") return `<div class="${cls} loading">${head}<div class="big"><span class="t">··</span></div><div class="cond">Loading…</div></div>`;
    if (r.status === "nokey") return `<div class="${cls} err">${head}<div class="cond">Needs an access code or API key on this device.</div><button class="btn addkey" data-open-settings>⚙️ Settings</button></div>`;
    if (r.status === "error") return `<div class="${cls} err">${head}<div class="big"><span class="t">—</span></div><div class="cond">${esc(r.error)}</div></div>`;
    const c = r.data.current, d = r.data.daily[today];
    return `<div class="${cls}">${head}
      <div class="big"><span class="i" aria-hidden="true">${icon(c.cat, c.night)}</span><span class="t">${T(c.temp)}</span></div>
      <div class="cond">${esc(c.text)}</div>
      <div class="meta">Feels ${T(c.feels)} · ${P(c.humidity)} · ${W(c.wind)} ${esc(dir(c.windDir))}</div>
      <div class="meta">Today ${d ? `${T(d.hi)} / ${T(d.lo)}${d.partial ? "*" : ""}${wetAmt(d.qpf) ? ` · ☔ ${R(d.qpf)}` : ""}` : "—"} · <span title="${esc(r.data.note)}">${esc(ago(c.observedAt))}</span></div>
    </div>`;
  }).join("");
  $("cards").querySelectorAll("[data-open-settings]").forEach(b => b.addEventListener("click", openSettings));
  const any = SOURCES.some(s => recent().scores[s.id]);
  $("pending").innerHTML = (any ? `<span class="legendline">Accuracy over the last 7 scored days: ${["good", "warning", "serious", "critical"].map((k, i) => `<span class="badge b-${k}"><i></i>${["88+ Great", "80+ Good", "70+ Fair", "under 70 Poor"][i]}</span>`).join(" ")} · sorted best first</span>` : `<span class="legendline">Accuracy shading appears here once the first days are scored.</span>`) +
    (PENDING_SOURCES.length ? " Coming once you add API keys: " + PENDING_SOURCES.map(n => `<span class="chip">${esc(n)}</span>`).join("") : "");
}

function renderAverage() {
  const ok = okSources(), tz = state.loc.tz;
  const ids = ok.map(s => s.id);
  const weights = weightsFor(ids);
  const smartReady = !!smartWeights(recentScores(accData()?.scores?.days || [], { locs: trackedLocs(), lead: 0, n: 14 }).scores, ids);
  document.querySelectorAll("#avgMode button").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.mode === state.avgMode));
  });
  $("avgModeNote").textContent = state.avgMode === "smart"
    ? (smartReady ? "Smart: sources that have been more accurate lately count more." : `Smart average starts once sources have ${MIN_DAYS_FOR_WEIGHT}+ scored days. Until then it's the plain average.`)
    : "Plain: every source counts the same.";
  if (!ok.length) {
    const loading = SOURCES.some(s => state.results[s.id]?.status === "loading");
    $("avgNow").innerHTML = `<div class="cond">${loading ? "Waiting for data…" : "No sources available."}</div>`;
    $("avgDays").innerHTML = ""; $("avgChart").innerHTML = ""; $("avgLegend").innerHTML = "";
    return;
  }
  const cur = ok.map(s => [s.id, state.results[s.id].data.current]);
  const temps = cur.map(([, c]) => c.temp).filter(isNum);
  const night = cur[0][1].night;
  const cat = mode(cur.map(([, c]) => c.cat));
  $("avgNow").innerHTML = `
    <div class="src" style="font-weight:600;font-size:14px">Now · ${ok.length} source${ok.length > 1 ? "s" : ""}</div>
    <div class="big"><span class="i" aria-hidden="true">${icon(cat, night)}</span><span class="t">${T(wmean(cur.map(([id, c]) => [id, c.temp]), weights))}</span></div>
    <div class="cond">${esc(catLabel(cat, night))}</div>
    <div class="spread">Range ${T(Math.min(...temps))} to ${T(Math.max(...temps))}</div>
    <div class="meta" style="margin-top:6px">Feels ${T(wmean(cur.map(([id, c]) => [id, c.feels]), weights))} · ${P(wmean(cur.map(([id, c]) => [id, c.humidity]), weights))} · ${W(wmean(cur.map(([id, c]) => [id, c.wind]), weights))}</div>`;

  const nowHour = Math.floor(Date.now() / 3600e3) * 3600e3;
  $("avgDays").innerHTML = nextDays(tz, DAYS).map((d, i) => {
    const ds = ok.map(s => [s.id, state.results[s.id].data.daily[d.key]]).filter(([, x]) => x);
    const his = ds.map(([, x]) => x.hi).filter(isNum);
    const c = mode(ds.map(([, x]) => x.cat));
    const avgPop = wmean(ds.map(([id, x]) => [id, x.pop]), weights);
    const rain = isNum(avgPop) && avgPop > RAIN_SHOW_POP ? avgRainStart(ok, d.key, i === 0 ? nowHour : null, weights) : null;
    return `<div class="day">
      <div class="dn">${i === 0 ? "Today" : fmtDay(d.ms, tz)}</div>
      <div class="di" aria-hidden="true">${ds.length ? icon(c, false) : ""}</div>
      <div class="hl">${T(wmean(ds.map(([id, x]) => [id, x.hi]), weights))} <span class="lo">${T(wmean(ds.map(([id, x]) => [id, x.lo]), weights))}</span></div>
      <div class="pp">💧 ${P(avgPop)}${(() => { const q = wmean(ds.map(([id, x]) => [id, x.qpf]), weights); return wetAmt(q) ? ` · ☔ ${R(q)}` : ""; })()}</div>
      ${rain ? `<div class="rs" title="Average of when each source has rain starting (${rain.n} of ${rain.of} sources call for rain that day)">🌧️ ${rain.now ? "now" : "~" + esc(fmtTime(rain.t, tz))}<span class="rsn"> · ${rain.n}/${rain.of}</span></div>` : ""}
      <div class="rg" title="Range of highs across sources">${his.length > 1 ? `highs ${T(Math.min(...his))}–${T(Math.max(...his))}` : "&nbsp;"}</div>
    </div>`;
  }).join("");

  const grid = hourGrid();
  const maps = ok.map(s => [s.id, new Map(state.results[s.id].data.hourly.map(h => [h.t, h]))]);
  const avg = [], lo = [], hi = [], pop = [], qpfs = [];
  for (const t of grid) {
    const v = maps.map(([id, m]) => [id, m.get(t)?.temp]).filter(([, x]) => isNum(x));
    avg.push(v.length ? wmean(v, weights) : null);
    lo.push(v.length ? Math.min(...v.map(x => x[1])) : null); hi.push(v.length ? Math.max(...v.map(x => x[1])) : null);
    pop.push(wmean(maps.map(([id, m]) => [id, m.get(t)?.pop]), weights));
    qpfs.push(wmean(maps.map(([id, m]) => [id, m.get(t)?.qpf]), weights));
  }
  const label = state.avgMode === "smart" && smartReady ? "Smart average" : "Average";
  const ser = [{ name: label, color: "var(--avg)", width: 2.5, values: avg.map(cvt), band: [lo.map(cvt), hi.map(cvt)], extra: i => `<div class="row"><span>Range</span><span>${T(lo[i])} – ${T(hi[i])}</span></div>` }];
  $("avgLegend").innerHTML = `<span><span class="sw" style="background:var(--avg)"></span>${label}</span>` + (ok.length > 1 ? `<span><span class="sw band"></span>Lowest–highest source</span>` : "") + `<span><span class="sw bar"></span>Rain chance</span>`;
  lineChart($("avgChart"), grid, ser, { tz, bars: pop, amounts: qpfs });
}

// ---------- Best forecast: each element from the sources that have been best at it lately ----------
const fmtErr = (el, e) => !isNum(e) ? "—" : ({ deg: A(e), brier: e.toFixed(2), hours: "±" + e.toFixed(1) + "h", inches: R(e), mph: (state.units === "F" ? e.toFixed(1) + " mph" : (e * 1.609).toFixed(1) + " km/h"), pct: e.toFixed(1) + " pts" })[ELEMENTS[el].fmt];
const ERR_WORD = { pct: "avg miss", deg: "avg miss", brier: "score (0 = perfect)", hours: "avg timing miss", inches: "avg amount miss", mph: "avg miss" };
function wstd(pairs, w) {
  const v = pairs.filter(([id, x]) => isNum(x) && (!w || w[id]));
  if (v.length < 2) return null;
  const m = wmean(v, w);
  const ws = v.map(([id]) => w ? w[id] : 1), tw = ws.reduce((a, b) => a + b, 0);
  return Math.sqrt(v.reduce((s, [, x], i) => s + ws[i] * (x - m) ** 2, 0) / tw);
}
function renderBest() {
  const el = $("best");
  if (!el) return;
  const days = accData()?.scores?.days;
  const locs = trackedLocs() || ["vallejo", "napa"];
  const full = new Set((days || []).filter(d => locs.includes(d.loc) && (d.lead ?? 0) === 0 && !d.partial).map(d => d.date));
  const ok = okSources(), ids = ok.map(s => s.id), tz = state.loc.tz;
  if (!days || full.size < BEST_MIN_DAYS) {
    const left = BEST_MIN_DAYS - full.size;
    const eta = fmtDayLong(Date.now() + left * 24 * 3600e3, tz).split(",").slice(0, 2).join(",");
    el.innerHTML = `<div class="best-wait"><b>Best forecast: coming soon.</b> It builds each part of the forecast (high, low, rain chance, rain timing, rain amount, wind) from the sources that have been most accurate at that part lately, so it needs ${BEST_MIN_DAYS} fully scored days first: ${full.size} so far. ${days ? `Expected around <b>${esc(eta)}</b> morning.` : ""} Until then, see the averages below.</div>`;
    return;
  }
  if (ok.length < 2) { el.innerHTML = `<div class="best-wait">Waiting for forecasts…</div>`; return; }
  const sk = [0, 1, 2].map(L => elementSkill(days, { locs, lead: L, n: 14 }).skill);
  const skFor = i => sk[Math.min(i, 2)];
  const W = (i, e) => elementWeights(skFor(i), e, ids) || elementWeights(sk[0], e, ids);
  const nowHour = Math.floor(Date.now() / 3600e3) * 3600e3;
  const dayInfo = nextDays(tz, DAYS).map((d, i) => {
    const ds = ok.map(s => [s.id, state.results[s.id].data.daily[d.key]]).filter(([, x]) => x);
    const wh = W(i, "high"), wl = W(i, "low"), wr = W(i, "rain"), wa = W(i, "amount") || wr, wt = W(i, "timing") || wr, ww = W(i, "wind");
    const hi = wmean(ds.map(([id, x]) => [id, x.hi]), wh), lo = wmean(ds.map(([id, x]) => [id, x.lo]), wl);
    const pop = wmean(ds.map(([id, x]) => [id, x.pop]), wr), qpf = wmean(ds.map(([id, x]) => [id, x.qpf]), wa);
    const rain = isNum(pop) && pop > RAIN_SHOW_POP ? avgRainStart(ok, d.key, i === 0 ? nowHour : null, wt) : null;
    const d0 = localHourStart(d.key, 7, tz), d1 = localHourStart(d.key, 19, tz);
    const wind = wmean(ok.map(s => { const v = state.results[s.id].data.hourly.filter(h => h.t >= Math.max(d0, i === 0 ? nowHour : 0) && h.t < d1).map(h => h.wind).filter(isNum); return [s.id, v.length ? Math.max(...v) : null]; }), ww);
    // Humidity range for the rest of the day (lowest–highest), weighted toward the best humidity sources.
    const wu = W(i, "humidity");
    const hr0 = Math.max(localHourStart(d.key, 0, tz), i === 0 ? nowHour : 0), hr1 = localHourStart(d.key, 23, tz) + 3600e3;
    const humMin = wmean(ok.map(s => { const v = state.results[s.id].data.hourly.filter(h => h.t >= hr0 && h.t < hr1).map(h => h.humidity).filter(isNum); return [s.id, v.length ? Math.min(...v) : null]; }), wu);
    const humMax = wmean(ok.map(s => { const v = state.results[s.id].data.hourly.filter(h => h.t >= hr0 && h.t < hr1).map(h => h.humidity).filter(isNum); return [s.id, v.length ? Math.max(...v) : null]; }), wu);
    const spread = wstd(ds.map(([id, x]) => [id, x.hi]), wh);
    const conf = !isNum(spread) ? null : spread <= 1.5 ? "High" : spread <= 3 ? "Medium" : "Low";
    const cat = isNum(pop) && pop >= 50 ? "rain" : mode(ds.map(([, x]) => x.cat));
    return { d, i, hi, lo, pop, qpf, rain, wind, humMin, humMax, spread, conf, cat };
  });
  const t = dayInfo[0];
  const cur = wmean(ok.map(s => [s.id, state.results[s.id].data.current.temp]), W(0, "temp"));
  const leaders = Object.keys(ELEMENTS).map(e => ({ e, L: elementLeader(sk[0], e, ids) })).filter(x => x.L);
  const pill = (txt, title) => `<span class="bpill" title="${esc(title)}">${txt}</span>`;
  el.innerHTML = `
    <div class="best-hero">
      <div class="best-main">
        <div class="best-kicker">Best forecast · today${trackedLocs() ? "" : " · tuned on Vallejo + Napa"}</div>
        <div class="best-temps"><span class="i" aria-hidden="true">${icon(t.cat, false)}</span><span class="hi">${T(t.hi)}</span><span class="lo">${T(t.lo)}</span></div>
        <div class="cond">${esc(catLabel(t.cat, false))}${isNum(cur) ? ` · now ${T(cur)}` : ""}${t.conf ? ` · <span class="conf conf-${t.conf.toLowerCase()}" title="How closely the most accurate sources agree on the high (±${A(t.spread)})">${t.conf} confidence</span>` : ""}</div>
        <div class="best-pills">
          ${pill(`💧 ${P(t.pop)} chance of rain`, "Rain chance, weighted toward the sources best at rain chances lately")}
          ${t.rain ? pill(`🌧️ ${t.rain.now ? "raining now" : "starts ~" + esc(fmtTime(t.rain.t, tz))}`, `Weighted toward the sources best at rain timing (${t.rain.n} of ${t.rain.of} sources call for rain)`) : ""}
          ${wetAmt(t.qpf) ? pill(`☔ ${R(t.qpf)}`, "Rain total, weighted toward the sources best at amounts") : ""}
          ${isNum(t.wind) ? pill(`💨 up to ${W_(t.wind)}`, "Peak daytime wind, weighted toward the sources best at wind") : ""}
          ${isNum(t.humMin) ? pill(`Humidity ${Math.round(t.humMin)}–${Math.round(t.humMax)}%`, "Lowest to highest humidity for the rest of today, weighted toward the sources best at humidity") : ""}
        </div>
      </div>
      <div class="best-from">
        <div class="best-kicker">Built from the most accurate sources (last ${Math.min(14, full.size)} scored days)</div>
        <ul>${leaders.map(({ e, L }) => `<li><span class="bel">${ELEMENTS[e].label}</span><span class="bsrc">${esc(srcShort(L.id))}</span><span class="berr">${ERR_WORD[ELEMENTS[e].fmt]} ${fmtErr(e, L.err)}</span></li>`).join("")}
        ${leaders.length < Object.keys(ELEMENTS).length ? `<li class="bmore">${Object.keys(ELEMENTS).filter(e => !leaders.some(x => x.e === e)).map(e => ELEMENTS[e].label).join(", ")}: not enough data yet, so those use all sources equally.</li>` : ""}</ul>
      </div>
    </div>
    <div class="best-days">${dayInfo.slice(1).map(x => `
      <div class="bday" title="${x.conf ? x.conf + " confidence" : ""}">
        <div class="dn">${esc(fmtDay(x.d.ms, tz))}</div>
        <div class="di" aria-hidden="true">${icon(x.cat, false)}</div>
        <div class="hl">${T(x.hi)} <span class="lo">${T(x.lo)}</span></div>
        <div class="pp">💧 ${P(x.pop)}${wetAmt(x.qpf) ? ` · ☔ ${R(x.qpf)}` : ""}</div>
        ${x.rain ? `<div class="rs">🌧️ ~${esc(fmtTime(x.rain.t, tz))}</div>` : ""}
        ${x.conf ? `<div class="conf conf-${x.conf.toLowerCase()}">${x.conf}</div>` : ""}
      </div>`).join("")}</div>`;
}
const W_ = mph => !isNum(mph) ? "—" : state.units === "F" ? Math.round(mph) + " mph" : Math.round(mph * 1.609) + " km/h";

// Average rain start for a local day: each source's first rainy hour that day, averaged.
// Only shown when the average rain chance for the day is above this.
const RAIN_SHOW_POP = 40;
function avgRainStart(ok, key, fromT, weights) {
  const tz = state.loc.tz;
  const start = fromT ?? localHourStart(key, 0, tz), end = localHourStart(dayKey(localHourStart(key, 12, tz) + 24 * 3600e3, tz), 0, tz);
  const starts = [];
  let of = 0;
  for (const s of ok) {
    const hrs = state.results[s.id].data.hourly.filter(h => h.t >= start && h.t < end);
    if (hrs.length < 6) continue;          // source doesn't forecast hourly that far out
    of++;
    const r = hrs.find(isRainyHour);
    if (r) starts.push([s.id, r.t]);
  }
  if (!starts.length) return null;
  const t = Math.round(wmean(starts, weights) / 1800e3) * 1800e3;   // nearest half hour
  return { t, now: fromT != null && t <= fromT, n: starts.length, of };
}

function renderDaily() {
  const tz = state.loc.tz, days = nextDays(tz, DAYS);
  const ok = okSources();
  const weights = weightsFor(ok.map(s => s.id));
  let html = `<thead><tr><th></th>${days.map((d, i) => `<th>${i === 0 ? "Today" : esc(fmtDayLong(d.ms, tz))}</th>`).join("")}</tr></thead><tbody>`;
  if (ok.length > 1) {
    html += `<tr class="avgrow"><th>${state.avgMode === "smart" && weights ? "Smart average" : "Average"}</th>`;
    for (const d of days) {
      const ds = ok.map(s => [s.id, state.results[s.id].data.daily[d.key]]).filter(([, x]) => x);
      html += `<td class="cell"><span class="ci" aria-hidden="true">${ds.length ? icon(mode(ds.map(([, x]) => x.cat)), false) : ""}</span>
        <span class="ct">${T(wmean(ds.map(([id, x]) => [id, x.hi]), weights))} <span class="lo">${T(wmean(ds.map(([id, x]) => [id, x.lo]), weights))}</span></span>
        <span class="cp">💧 ${P(wmean(ds.map(([id, x]) => [id, x.pop]), weights))}</span>${(() => { const q = wmean(ds.map(([id, x]) => [id, x.qpf]), weights); return wetAmt(q) ? `<span class="cq">☔ ${R(q)}</span>` : ""; })()}</td>`;
    }
    html += `</tr>`;
  }
  for (const s of orderedSources()) {
    const r = state.results[s.id];
    if (r?.status === "nokey") continue;
    html += `<tr><th><span class="nm">${esc(s.short)}</span>${badge(s.id, { compact: true })}</th>`;
    if (r?.status !== "ok") { html += `<td colspan="${DAYS}" class="cell na">${r?.error ? esc(r.error) : "Loading…"}</td></tr>`; continue; }
    for (const d of days) {
      const x = r.data.daily[d.key];
      if (!x) { html += `<td class="cell na">—</td>`; continue; }
      html += `<td class="cell" title="${esc(x.text || catLabel(x.cat))}${x.partial ? " (rest of today only)" : ""}${x.nightOnly ? " (tonight)" : ""}">
        <span class="ci" aria-hidden="true">${icon(x.cat, !!x.nightOnly)}</span>
        <span class="ct">${T(x.hi)} <span class="lo">${T(x.lo)}</span>${x.partial ? "*" : ""}</span>
        <span class="cp">💧 ${P(x.pop)}</span>${wetAmt(x.qpf) ? `<span class="cq">☔ ${R(x.qpf)}</span>` : ""}</td>`;
    }
    html += `</tr>`;
  }
  $("dailyTable").innerHTML = html + `</tbody>`;
}

// ---------- Hourly: chart with tap-to-compare + a calmer table ----------
function renderHourly() {
  const tz = state.loc.tz, grid = hourGrid(), ok = okSources();
  const weights = weightsFor(ok.map(s => s.id));
  const maps = Object.fromEntries(ok.map(s => [s.id, new Map(state.results[s.id].data.hourly.map(h => [h.t, h]))]));
  // Legend chips: every loaded source, best first; tap to draw it (up to 4 at once).
  $("hourLegend").innerHTML = `<span class="chiphint">Tap to compare (up to ${MAX_SELECTED}):</span>` + ok.map(s => {
    const on = isSelected(s.id);
    return `<button class="schip${on ? " on" : ""}" data-sel="${s.id}" aria-pressed="${on}">${on ? `<span class="sw" style="background:${selColor(s.id)}"></span>` : ""}${esc(s.short)}${badge(s.id, { compact: true })}</button>`;
  }).join("") + (state.sel.length ? `<button class="schip clear" data-clear>Clear</button>` : "");
  $("hourLegend").querySelectorAll("[data-sel]").forEach(b => b.addEventListener("click", () => { toggleSel(b.dataset.sel); renderHourly(); renderAccuracy(); }));
  $("hourLegend").querySelector("[data-clear]")?.addEventListener("click", () => { state.sel = []; state.slots = {}; store.set("wc.sel", []); store.set("wc.slots", {}); renderHourly(); renderAccuracy(); });

  if (ok.length) {
    const avg = grid.map(t => wmean(ok.map(s => [s.id, maps[s.id].get(t)?.temp]), weights));
    const lo = grid.map(t => { const v = ok.map(s => maps[s.id].get(t)?.temp).filter(isNum); return v.length ? Math.min(...v) : null; });
    const hi = grid.map(t => { const v = ok.map(s => maps[s.id].get(t)?.temp).filter(isNum); return v.length ? Math.max(...v) : null; });
    const pop = grid.map(t => wmean(ok.map(s => [s.id, maps[s.id].get(t)?.pop]), weights));
    const qpf = grid.map(t => wmean(ok.map(s => [s.id, maps[s.id].get(t)?.qpf]), weights));
    const ser = [{ name: weights ? "Smart avg" : "Average", color: "var(--avg)", width: 2.5, values: avg.map(cvt), band: ok.length > 1 ? [lo.map(cvt), hi.map(cvt)] : null }];
    for (const id of state.sel) if (maps[id]) ser.push({ name: srcShort(id), color: selColor(id), values: grid.map(t => cvt(maps[id].get(t)?.temp)), pops: grid.map(t => maps[id].get(t)?.pop) });
    lineChart($("hourChart"), grid, ser, { tz, bars: pop, amounts: qpf, directLabels: ser.length > 1, extra: (x, i) => x.pops && isNum(x.pops[i]) ? ` <span class="tipp">💧${Math.round(x.pops[i])}%</span>` : "" });
  } else $("hourChart").innerHTML = "";

  // Table: best sources first; icons only when conditions change; rain chance only when 20%+.
  const onlySel = state.sel.length && store.get("wc.tableSel", false);
  $("tableMode").innerHTML = state.sel.length ? `<button class="schip${onlySel ? "" : " on"}" data-tm="all">All sources</button><button class="schip${onlySel ? " on" : ""}" data-tm="sel">Selected only</button>` : "";
  $("tableMode").querySelectorAll("[data-tm]").forEach(b => b.addEventListener("click", () => { store.set("wc.tableSel", b.dataset.tm === "sel"); renderHourly(); }));
  const dayCells = []; let lastDay = null;
  grid.forEach((t, i) => {
    const k = dayKey(t, tz);
    if (k !== lastDay) { dayCells.push({ label: i === 0 ? "Today" : fmtDayLong(t, tz), span: 0 }); lastDay = k; }
    dayCells[dayCells.length - 1].span++;
  });
  const head1 = `<tr class="dayrow"><th></th>` + dayCells.map(d => `<th colspan="${d.span}"><span class="daylbl">${esc(d.label)}</span></th>`).join("") + `</tr>`;
  let prev = null;
  const newDay = grid.map(t => { const k = dayKey(t, tz); const nd = prev !== null && k !== prev; prev = k; return nd; });
  const head2 = `<tr><th></th>` + grid.map((t, i) => `<th class="${newDay[i] ? "newday" : ""}">${i === 0 ? "Now" : esc(fmtHour(t, tz))}</th>`).join("") + `</tr>`;
  const row = (label, getH) => {
    let lastCat = null;
    return grid.map((t, i) => {
      const h = getH(t);
      if (!h || !isNum(h.temp)) return `<td class="cell na ${newDay[i] ? "newday" : ""}">—</td>`;
      const key = h.cat + (h.night ? "n" : "");
      const showIcon = key !== lastCat || i === 0; lastCat = key;
      const wet = isNum(h.pop) && h.pop >= 20;
      const amt = isNum(h.qpf) && h.qpf >= 0.01;
      return `<td class="cell ${newDay[i] ? "newday" : ""}${isRainyHour(h) ? " wet" : ""}" title="${esc(h.text || catLabel(h.cat))}${isNum(h.pop) ? ` · ${Math.round(h.pop)}% rain` : ""}${isNum(h.qpf) ? ` · ${R(h.qpf)}` : ""}"><span class="ci" aria-hidden="true">${showIcon ? icon(h.cat, h.night) : ""}</span><span class="ct">${T(h.temp)}</span><span class="cp">${wet ? Math.round(h.pop) + "%" : ""}</span><span class="cq">${amt ? R(h.qpf, false) : ""}</span></td>`;
    }).join("");
  };
  let body = "";
  if (ok.length > 1) {
    body += `<tr class="avgrow"><th>${weights ? "Smart avg" : "Average"}</th>` + row("avg", t => {
      const hs = ok.map(s => [s.id, maps[s.id].get(t)]).filter(([, h]) => h);
      if (!hs.length) return null;
      const temp = wmean(hs.map(([id, h]) => [id, h.temp]), weights), pop = wmean(hs.map(([id, h]) => [id, h.pop]), weights);
      const wet = hs.filter(([, h]) => isRainyHour(h)).length >= hs.length / 2;
      return { temp, pop, qpf: wmean(hs.map(([id, h]) => [id, h.qpf]), weights), cat: wet ? "rain" : mode(hs.map(([, h]) => h.cat)), night: hs[0][1].night, text: "" };
    }) + `</tr>`;
  }
  for (const s of orderedSources()) {
    const r = state.results[s.id];
    if (r?.status === "nokey" || (onlySel && !isSelected(s.id))) continue;
    const sw = isSelected(s.id) ? `<span class="sw" style="background:${selColor(s.id)}"></span>` : "";
    body += `<tr><th>${sw}<span class="nm">${esc(s.short)}</span>${badge(s.id, { compact: true })}</th>`;
    if (r?.status !== "ok") { body += `<td colspan="${HOURS}" class="cell na" style="text-align:left">${r?.error ? esc(r.error) : "Loading…"}</td></tr>`; continue; }
    body += row(s.id, t => maps[s.id]?.get(t)) + `</tr>`;
  }
  $("hourlyTable").innerHTML = `<thead>${head1}${head2}</thead><tbody>${body}</tbody>`;
  // Day labels stick just right of the pinned source-name column while scrolling sideways.
  const nameCol = $("hourlyTable").querySelector("tbody th");
  if (nameCol) $("hourlyTable").style.setProperty("--namecol", nameCol.offsetWidth + "px");
  const row1 = $("hourlyTable").querySelector("thead tr");
  if (row1) $("hourlyTable").style.setProperty("--row1", row1.offsetHeight + "px");
}

// ---------- Line chart (inline SVG) ----------
// series: [{name, color, values, width?, dash?, band?: [lo[], hi[]], extra?(i)}]
// opts: { tz, bars?: rain-chance % per point, markers?: [{t, label, dash}], startLabel?, directLabels?, extra?(series, i) }
export function lineChart(el, times, series, opts = {}) {
  el._args = [times, series, opts];
  const W = Math.max(280, el.clientWidth || 600);
  const barH = opts.bars ? 34 : 0;
  const H = (W < 500 ? 190 : 230) + barH;
  const m = { l: 34, r: opts.directLabels && W >= 480 ? 74 : 12, t: opts.markers?.length ? 22 : 12, b: 26 + (barH ? barH + 8 : 0) };
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
  const xLabelY = m.t + ih + 16;
  times.forEach((t, i) => {
    const hr = localHour(t, tz);
    if (i === 0 || hr % 6 === 0) {
      if (i !== 0 && i < 3) return;
      const label = i === 0 ? (opts.startLabel ?? "Now") : hr === 0 ? fmtDay(t, tz) : fmtHour(t, tz);
      svg += `<text class="axis" x="${x(i)}" y="${xLabelY}" text-anchor="${i === 0 ? "start" : "middle"}"${hr === 0 ? ' style="font-weight:600;fill:var(--text-2)"' : ""}>${esc(label)}</text>`;
      if (hr === 0) svg += `<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${m.t + ih}" stroke-dasharray="2 3"/>`;
    }
  });
  if (barH) {
    const by = m.t + ih + 24, bw = Math.max(2, iw / times.length - 2);
    svg += `<text class="axis" x="${m.l - 6}" y="${by + barH / 2 + 4}" text-anchor="end">💧</text>`;
    svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${by + barH}" y2="${by + barH}"/>`;
    opts.bars.forEach((p, i) => {
      if (!isNum(p) || p < 1) return;
      const h = Math.max(1.5, p / 100 * barH);
      svg += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(by + barH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="var(--rain)" opacity="${(0.35 + 0.65 * p / 100).toFixed(2)}"/>`;
    });
  }
  for (const mk of opts.markers || []) {
    const i = (mk.t - times[0]) / 3600e3;
    if (i < 0 || i > times.length - 1) continue;
    const xx = m.l + i / (times.length - 1) * iw;
    svg += `<line x1="${xx}" x2="${xx}" y1="${m.t - 4}" y2="${m.t + ih}" stroke="${mk.color || "var(--rain)"}" stroke-width="${mk.width || 1.5}"${mk.dash ? ` stroke-dasharray="${mk.dash}"` : ""}/>`;
    if (mk.label) svg += `<text class="mk" x="${xx}" y="${m.t - 8}" text-anchor="middle">${esc(mk.label)}</text>`;
  }
  for (const s of series) if (s.band) {
    const [bl, bh] = s.band;
    const idx = bl.map((v, i) => i).filter(i => isNum(bl[i]) && isNum(bh[i]));
    if (idx.length) svg += `<path d="${idx.map((i, k) => (k ? "L" : "M") + x(i) + "," + y(bh[i])).join("") + idx.slice().reverse().map(i => "L" + x(i) + "," + y(bl[i])).join("")}Z" fill="var(--band)"/>`;
  }
  for (const s of series) svg += `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash === true ? "5 4" : s.dash}"` : ""}/>`;
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
      series.map(s => `<div class="row"><span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span><span>${isNum(s.values[i]) ? Math.round(s.values[i]) + "°" : "—"}${opts.extra ? opts.extra(s, i) : ""}</span></div>${s.extra ? s.extra(i) : ""}`).join("") +
      (opts.bars && isNum(opts.bars[i]) ? `<div class="row"><span>💧 Rain chance</span><span>${Math.round(opts.bars[i])}%</span></div>` : "") +
      (opts.amounts && wetAmt(opts.amounts[i]) ? `<div class="row"><span>☔ Rain amount</span><span>${R(opts.amounts[i])}</span></div>` : "");
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
  rsz = setTimeout(() => document.querySelectorAll(".chart").forEach(el => { if (el._args && el.offsetParent) lineChart(el, ...el._args); }), 150);
});

// ---------- Settings (API keys) ----------
function openSettings() {
  const keys = getKeys();
  const hasServer = !!(store.get("wc.proxyUrl", "") || PROXY_URL);
  $("keyRows").innerHTML = (hasServer ? `
    <div class="keyrow">
      <label for="accessCode">Access code <span class="sub2">for the shared key server</span></label>
      <input id="accessCode" type="password" autocomplete="off" spellcheck="false" placeholder="Paste access code" value="${esc(store.get("wc.code", ""))}">
      <p class="hint" style="margin:6px 0 0">With the code, every source works without your own keys. Keys entered below are used instead, on this device only.</p>
    </div><h3 style="font-size:14px;margin:16px 0 0">Your own API keys (optional)</h3>` : "") + SOURCES.filter(s => s.key).map(s => `
    <div class="keyrow">
      <label for="key_${s.id}">${esc(s.name)} <a href="${esc(s.key.signup)}" target="_blank" rel="noopener">Get a key ↗</a></label>
      <input id="key_${s.id}" data-id="${s.id}" type="password" autocomplete="off" spellcheck="false" placeholder="Paste key" value="${esc(keys[s.id] || "")}">
    </div>`).join("");
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
  $("keyRows").querySelectorAll("input[data-id]").forEach(i => { const v = i.value.trim(); if (v) keys[i.dataset.id] = v; else delete keys[i.dataset.id]; });
  store.set("wc.keys", keys);
  if ($("accessCode")) { store.set("wc.code", $("accessCode").value.trim()); applyProxy(); }
  loadAll(true);
});

// ---------- Tabs ----------
const TABS = { forecast: ["tabForecast", "viewForecast"], accuracy: ["tabAccuracy", "viewAccuracy"], radar: ["tabRadar", "viewRadar"], nfl: ["tabNFL", "viewNFL"] };
let radarMod = null, nflMod = null;
function showTab(name) {
  if (!TABS[name]) name = "forecast";
  for (const [k, [tab, view]] of Object.entries(TABS)) { $(tab).setAttribute("aria-selected", String(k === name)); $(view).hidden = k !== name; }
  const hash = name === "forecast" ? "" : "#" + name;
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);
  if (name === "accuracy") renderAccuracy();
  else if (name === "forecast") renderAll();
  if (name === "radar") (radarMod ||= import("./radar.js")).then(m => m.showRadar());
  if (name === "nfl") (nflMod ||= import("./nfl.js")).then(m => m.showNFL());
  else radarMod?.then(m => m.hideRadar());
}
for (const k of Object.keys(TABS)) $(TABS[k][0]).addEventListener("click", () => showTab(k));

// ---------- Controls ----------
function setLocation(loc) {
  state.loc = loc;
  store.set("wc.loc", loc);
  loadAll();
}
document.querySelectorAll(".preset").forEach(b => b.addEventListener("click", () => setLocation({ ...PRESETS[b.dataset.preset] })));
$("refreshBtn").addEventListener("click", () => { loadAll(true); initAccuracy().then(renderAll); if (!$("viewNFL").hidden) nflMod?.then(m => m.showNFL(true)); });
$("unitBtn").addEventListener("click", () => { state.units = state.units === "F" ? "C" : "F"; store.set("wc.units", state.units); renderAll(); renderAccuracy(); });
document.querySelectorAll("#avgMode button").forEach(b => b.addEventListener("click", () => { state.avgMode = b.dataset.mode; store.set("wc.avgMode", state.avgMode); renderAll(); }));
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
initAccuracy().then(() => { recentCache = null; renderAll(); });
showTab(location.hash.slice(1) || "forecast");
setInterval(() => { if (document.visibilityState === "visible") loadAll(); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.fetchedAt && Date.now() - state.fetchedAt > REFRESH_MS) { loadAll(); initAccuracy().then(renderAll); }
});
window.addEventListener("online", () => loadAll());
window.addEventListener("offline", renderStatus);
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
