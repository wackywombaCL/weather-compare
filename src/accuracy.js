// Accuracy tab: reads data/scores.json and today's locked-in forecast written by the daily job.
import { SOURCES, PRESETS, isNum, mean, dayKey } from "./sources.js";
import { state, store, $, esc, T, D, A, fmtTime, fmtDayLong } from "./app.js";

const TZ = "America/Los_Angeles";
const LOC_IDS = ["vallejo", "napa"];
const acc = { scores: null, today: null, problem: null, loading: false, loaded: false, loc: null, period: "all" };

export async function initAccuracy() {
  if (acc.loading) return;
  acc.loading = true;
  const bust = "?t=" + Math.floor(Date.now() / 60000);
  try {
    const r = await fetch("data/scores.json" + bust, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    acc.scores = await r.json();
    acc.problem = null;
  } catch {
    acc.scores = null;
    acc.problem = location.protocol === "file:" ? "file" : "none";
  }
  try {
    const r = await fetch(`data/forecasts/${dayKey(Date.now(), TZ)}.json${bust}`, { cache: "no-store" });
    acc.today = r.ok ? await r.json() : null;
  } catch { acc.today = null; }
  acc.loading = false;
  acc.loaded = true;
  renderAccuracy();
}

// ---------- Scoring helpers ----------
const clamp = v => Math.max(0, Math.min(100, v));
export function dayScore(s) {
  if (!s?.ok) return null;
  const tm = mean([isNum(s.hiErr) ? Math.abs(s.hiErr) : null, isNum(s.loErr) ? Math.abs(s.loErr) : null, s.mae]);
  if (!isNum(tm)) return null;
  const temp = clamp(100 - 10 * tm);
  const rain = isNum(s.brier) ? 100 * (1 - s.brier) : (s.rain === "hit" || s.rain === "none") ? 100 : 0;
  return 0.7 * temp + 0.3 * rain;
}
const pct = (num, den) => den ? Math.round(100 * num / den) + "%" : "—";
function aggregate(days, id) {
  const rows = days.map(d => d.src[id]).filter(s => s?.ok);
  const abs = k => mean(rows.map(s => isNum(s[k]) ? Math.abs(s[k]) : null));
  const within = k => { const v = rows.filter(s => isNum(s[k])); return { n: v.length, ok: v.filter(s => Math.abs(s[k]) <= 3).length }; };
  const c = { hit: 0, miss: 0, false: 0, none: 0 };
  rows.forEach(s => c[s.rain]++);
  const hits = rows.filter(s => s.rain === "hit" && isNum(s.timing));
  return {
    n: rows.length,
    score: mean(rows.map(dayScore)),
    hiMAE: abs("hiErr"), hiBias: mean(rows.map(s => s.hiErr)), hi3: within("hiErr"),
    loMAE: abs("loErr"), loBias: mean(rows.map(s => s.loErr)), lo3: within("loErr"),
    mae: mean(rows.map(s => s.mae)),
    brier: mean(rows.map(s => s.brier)),
    rain: c, rainRight: rows.length ? (c.hit + c.none) / rows.length : null,
    timing: hits.length ? mean(hits.map(s => Math.abs(s.timing))) : null,
    timingBias: hits.length ? mean(hits.map(s => s.timing)) : null,
  };
}
const scoreBadge = v => isNum(v) ? `<span class="score">${Math.round(v)}</span>` : `<span class="miss">—</span>`;
const timingText = h => !isNum(h) ? "" : Math.abs(h) < 0.5 ? "on time" : `${Math.abs(h).toFixed(Math.abs(h) < 10 ? 1 : 0).replace(/\.0$/, "")}h ${h > 0 ? "late" : "early"}`;
const src = id => SOURCES.find(s => s.id === id);
const swatch = s => `<span class="sw"></span>${esc(s.short)}`;

function metSeason(date) { const m = +date.slice(5, 7); return m === 12 || m <= 2 ? "Winter" : m <= 5 ? "Spring" : m <= 8 ? "Summer" : "Fall"; }
function wetSeason(date) { const m = +date.slice(5, 7); return m >= 11 || m <= 4 ? "Wet (Nov–Apr)" : "Dry (May–Oct)"; }

// ---------- Rendering ----------
function currentLoc() {
  if (!acc.loc) acc.loc = store.get("wc.accLoc", LOC_IDS.includes(state.loc.id) ? state.loc.id : "vallejo");
  return acc.loc;
}
const locsFor = l => l === "both" ? LOC_IDS : [l];
const locName = id => PRESETS[id]?.name.replace(", CA", "") || id;

export function renderAccuracy() {
  if (!$("viewAccuracy") || $("viewAccuracy").hidden) return;
  const loc = currentLoc();
  document.querySelectorAll("#accLoc button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.loc === loc)));
  if (!acc.loaded) { $("accToday").innerHTML = $("accRecent").innerHTML = `<p class="empty">Loading…</p>`; return; }
  $("accUpdated").textContent = acc.scores?.updated ? "Scores updated " + fmtDayLong(acc.scores.updated, TZ) + ", " + fmtTime(acc.scores.updated, TZ) : "";
  renderToday(loc);
  renderRecent(loc);
  renderLongTerm(loc);
}

function renderToday(loc) {
  const snap = acc.today;
  if (!snap) {
    const hr = +new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(Date.now());
    $("accToday").innerHTML = `<p class="empty">${acc.problem === "file" ? "Open the app from its web address to see tracking data." : hr < 6 ? "Today's forecast gets set at 6am Pacific." : "Today's forecast hasn't been set yet. It's usually saved a few minutes after 6am Pacific."}</p>`;
    return;
  }
  $("accToday").innerHTML = locsFor(loc).map(id => {
    const L = snap.locations[id];
    if (!L) return "";
    const rows = SOURCES.map(s => {
      const x = L.sources[s.id];
      if (!x) return `<tr><th style="--c:${s.color}">${swatch(s)}</th><td colspan="4" class="l miss">Not tracked yet (added after this forecast was set)</td></tr>`;
      if (!x.ok) return `<tr><th style="--c:${s.color}">${swatch(s)}</th><td colspan="4" class="l miss">Couldn't save: ${esc(x.error)}</td></tr>`;
      return `<tr><th style="--c:${s.color}">${swatch(s)}</th><td>${T(x.hi)}</td><td>${T(x.lo)}</td><td>${isNum(x.maxPop) ? x.maxPop + "%" : "—"}</td>
        <td class="l">${x.rainStart ? "🌧️ from " + esc(fmtTime(x.rainStart, TZ)) + (x.rainStart >= snap.windowStart + 18 * 3600e3 ? " (" + esc(fmtDayLong(x.rainStart, TZ).split(",")[0]) + ")" : "") : "No rain"}</td></tr>`;
    }).join("");
    return `<div class="panel daycard scroll">
      <h3>${esc(locName(id))} · ${esc(fmtDayLong(snap.windowStart, TZ))} <span class="sub2">set ${esc(fmtTime(snap.setAt, TZ))}, covers 6am → 6am</span></h3>
      <table class="acc"><thead><tr><th>Source</th><th>High</th><th>Low</th><th>Max rain chance</th><th style="text-align:left">Rain expected</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");
}

function emptyMsg() {
  return acc.problem === "file"
    ? "Accuracy data loads when the app is opened from its web address (GitHub Pages), not as a local file."
    : "No scored days yet. Forecasts are set at 6am Pacific and scored the next morning, so the first results appear a day after tracking starts.";
}

function renderRecent(loc) {
  const days = (acc.scores?.days || []).filter(d => locsFor(loc).includes(d.loc));
  if (!days.length) { $("accRecent").innerHTML = `<p class="empty">${emptyMsg()}</p>`; return; }
  const dates = [...new Set(days.map(d => d.date))].sort().reverse().slice(0, 3);
  const recent = days.filter(d => dates.includes(d.date)).sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : a.loc < b.loc ? -1 : 1);
  let html = recent.map(d => {
    const o = d.obs;
    const rainObs = o.rained ? `🌧️ started ${esc(fmtTime(o.rainStart, TZ))}${isNum(o.precipIn) ? `, ${o.precipIn.toFixed(2)} in` : ""}` : "no rain";
    const rows = SOURCES.map(s => {
      const x = d.src[s.id];
      if (!x?.ok) return `<tr><th style="--c:${s.color}">${swatch(s)}</th><td colspan="5" class="l miss">${x ? "No forecast saved that day" : "Not tracked yet"}</td></tr>`;
      let rain;
      if (x.rain === "hit") rain = `✓ Called rain from ${esc(fmtTime(x.rainStart, TZ))} <span class="miss">(${timingText(x.timing)})</span>`;
      else if (x.rain === "miss") rain = `<span class="rain-bad">✗ Missed the rain</span>`;
      else if (x.rain === "false") rain = `<span class="rain-bad">✗ False alarm</span> <span class="miss">(said ${esc(fmtTime(x.rainStart, TZ))})</span>`;
      else rain = `✓ Called it dry`;
      return `<tr><th style="--c:${s.color}">${swatch(s)}</th><td>${scoreBadge(dayScore(x))}</td>
        <td>${T(x.hi)} <span class="miss">${D(x.hiErr)}</span></td><td>${T(x.lo)} <span class="miss">${D(x.loErr)}</span></td>
        <td>${A(x.mae)}</td><td class="l">${rain}</td></tr>`;
    }).join("");
    return `<div class="panel daycard scroll">
      <h3>${esc(fmtDayLong(d.windowStart, TZ))}${locsFor(loc).length > 1 ? " · " + esc(locName(d.loc)) : ""}</h3>
      ${d.partial ? `<div class="obsline">⚠️ Forecast was set late (${esc(fmtTime(d.setAt, TZ))}), so this only covers ${esc(fmtTime(d.windowStart, TZ))} onward and isn't counted in the long-term scoreboard.</div>` : ""}
      <div class="obsline">Actual at ${esc(d.station)}: high <b>${T(o.hi)}</b>, low <b>${T(o.lo)}</b> · ${rainObs}</div>
      <table class="acc"><thead><tr><th>Source</th><th>Score</th><th>High (miss)</th><th>Low (miss)</th><th>Hourly miss</th><th style="text-align:left">Rain</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");
  // 3-day summary
  const ranked = SOURCES.map(s => ({ s, a: aggregate(recent, s.id) })).filter(r => r.a.n).sort((a, b) => (b.a.score ?? -1) - (a.a.score ?? -1));
  html += `<div class="panel scroll"><h3 style="font-size:15px;margin:0 0 6px">${dates.length}-day summary</h3>
    <table class="acc"><thead><tr><th>Source</th><th>Avg score</th><th>Avg high miss</th><th>Avg low miss</th><th>Hourly miss</th><th>Rain calls right</th><th>Rain timing</th></tr></thead><tbody>
    ${ranked.map((r, i) => `<tr class="${i === 0 ? "rank1" : ""}"><th style="--c:${r.s.color}">${swatch(r.s)}</th><td>${scoreBadge(r.a.score)}</td><td>${A(r.a.hiMAE)}</td><td>${A(r.a.loMAE)}</td><td>${A(r.a.mae)}</td><td>${pct(r.a.rain.hit + r.a.rain.none, r.a.n)}</td><td>${isNum(r.a.timing) ? "±" + r.a.timing.toFixed(1) + "h" : "—"}</td></tr>`).join("")}
    </tbody></table></div>`;
  $("accRecent").innerHTML = html;
}

function renderLongTerm(loc) {
  // Days whose forecast was set late cover only part of the window: shown in "Last 3 days", left out of long-term stats.
  const all = (acc.scores?.days || []).filter(d => locsFor(loc).includes(d.loc) && !d.partial);
  const years = [...new Set(all.map(d => d.date.slice(0, 4)))].sort().reverse();
  const sel = $("accPeriod");
  if (!years.includes(acc.period)) acc.period = "all";
  sel.innerHTML = `<option value="all">All-time</option>` + years.map(y => `<option value="${y}">${y}</option>`).join("");
  sel.value = acc.period;
  const days = acc.period === "all" ? all : all.filter(d => d.date.startsWith(acc.period));
  if (!days.length) {
    $("accOverall").innerHTML = `<tbody><tr><td class="l empty">${emptyMsg()}</td></tr></tbody>`;
    $("accSeason").innerHTML = $("accWetDry").innerHTML = `<tbody><tr><td class="l empty">Nothing yet.</td></tr></tbody>`;
    return;
  }
  const ranked = SOURCES.map(s => ({ s, a: aggregate(days, s.id) })).filter(r => r.a.n).sort((a, b) => (b.a.score ?? -1) - (a.a.score ?? -1));
  const bias = v => isNum(v) ? `${D(v, 1)} <span class="miss">${Math.abs(v) < 0.5 ? "" : v > 0 ? "warm" : "cold"}</span>` : "—";
  $("accOverall").innerHTML = `<thead><tr><th>#</th><th style="text-align:left">Source</th><th>Score</th><th>Days</th>
      <th title="Average size of the high-temperature miss">High miss</th><th title="Average signed high miss: + runs warm, − runs cold">High bias</th><th>Highs ±3°F</th>
      <th>Low miss</th><th>Low bias</th><th>Lows ±3°F</th><th>Hourly miss</th>
      <th>Rain right</th><th title="Hits / misses / false alarms">Hit · Miss · False</th><th title="Average gap between forecast and actual rain start, for hits">Rain timing</th><th title="0 is perfect">Brier</th></tr></thead><tbody>` +
    ranked.map((r, i) => { const a = r.a; return `<tr class="${i === 0 ? "rank1" : ""}"><td>${i + 1}</td><th style="--c:${r.s.color}">${swatch(r.s)}</th><td>${scoreBadge(a.score)}</td><td>${a.n}</td>
      <td>${A(a.hiMAE)}</td><td>${bias(a.hiBias)}</td><td>${pct(a.hi3.ok, a.hi3.n)}</td>
      <td>${A(a.loMAE)}</td><td>${bias(a.loBias)}</td><td>${pct(a.lo3.ok, a.lo3.n)}</td><td>${A(a.mae)}</td>
      <td>${isNum(a.rainRight) ? Math.round(a.rainRight * 100) + "%" : "—"}</td><td>${a.rain.hit} · ${a.rain.miss} · ${a.rain.false}</td>
      <td>${isNum(a.timing) ? "±" + a.timing.toFixed(1) + "h" + (Math.abs(a.timingBias) >= 0.5 ? ` <span class="miss">${a.timingBias > 0 ? "late" : "early"}</span>` : "") : "—"}</td>
      <td>${isNum(a.brier) ? a.brier.toFixed(2) : "—"}</td></tr>`; }).join("") + `</tbody>`;

  const seasonTable = (names, fn) => {
    const cols = SOURCES.filter(s => days.some(d => d.src[s.id]?.ok));
    return `<thead><tr><th>Season</th>${cols.map(s => `<th>${esc(s.short)}</th>`).join("")}</tr></thead><tbody>` +
      names.map(n => {
        const ds = days.filter(d => fn(d.date) === n);
        return `<tr><th>${esc(n)} <span class="sub2">${ds.length ? Math.round(ds.length / locsFor(loc).length) + " d" : ""}</span></th>` +
          cols.map(s => { const a = aggregate(ds, s.id); return `<td title="${a.n} scored days">${a.n ? scoreBadge(a.score) : `<span class="miss">—</span>`}</td>`; }).join("") + `</tr>`;
      }).join("") + `</tbody>`;
  };
  $("accSeason").innerHTML = seasonTable(["Winter", "Spring", "Summer", "Fall"], metSeason);
  $("accWetDry").innerHTML = seasonTable(["Wet (Nov–Apr)", "Dry (May–Oct)"], wetSeason);
}

// ---------- Controls ----------
document.querySelectorAll("#accLoc button").forEach(b => b.addEventListener("click", () => {
  acc.loc = b.dataset.loc; store.set("wc.accLoc", acc.loc); renderAccuracy();
}));
document.getElementById("accPeriod").addEventListener("change", e => { acc.period = e.target.value; renderAccuracy(); });
