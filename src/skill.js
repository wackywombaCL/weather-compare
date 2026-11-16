// Accuracy math shared by the page and the daily job, so they always agree.
import { isNum, mean } from "./sources.js";

const clamp = v => Math.max(0, Math.min(100, v));

// How close a rain total was, 0–100, on days rain was in play (it rained or the source expected
// some); null otherwise or when the source gives no amounts. The miss is measured against the
// larger of the two totals (at least 0.10"), so 0.1" forecast for 1" of rain scores 10 and
// 0.02" forecast on a dry day scores 80.
export function amountScore(s) {
  if (!isNum(s?.qpf) || !isNum(s.qpfErr)) return null;
  const obs = Math.max(0, s.qpf - s.qpfErr);
  if (obs < 0.01 && s.qpf < 0.01) return null;
  return clamp(100 * (1 - Math.abs(s.qpfErr) / Math.max(obs, s.qpf, 0.1)));
}
// 0–100 score for one source on one day: 70% temperature, 30% rain. The rain part is the
// rain/no-rain call; on days rain was in play, 40% of it is how close the rain total was.
export function dayScore(s) {
  if (!s?.ok) return null;
  const tm = mean([isNum(s.hiErr) ? Math.abs(s.hiErr) : null, isNum(s.loErr) ? Math.abs(s.loErr) : null, s.mae]);
  if (!isNum(tm)) return null;
  const temp = clamp(100 - 10 * tm);
  const call = isNum(s.brier) ? 100 * (1 - s.brier) : (s.rain === "hit" || s.rain === "none") ? 100 : 0;
  const amt = amountScore(s);
  return 0.7 * temp + 0.3 * (isNum(amt) ? 0.6 * call + 0.4 * amt : call);
}

// Average score per source over the most recent `n` scored days (optionally one location / lead).
export function recentScores(days, { locs = null, lead = 0, n = 7, before = null } = {}) {
  const pool = days.filter(d => (d.lead ?? 0) === lead && !d.partial && (!locs || locs.includes(d.loc)) && (!before || d.date < before));
  const dates = [...new Set(pool.map(d => d.date))].sort().slice(-n);
  const use = pool.filter(d => dates.includes(d.date));
  const out = {};
  for (const d of use) for (const [id, s] of Object.entries(d.src)) {
    const v = dayScore(s);
    if (!isNum(v)) continue;
    (out[id] ||= { sum: 0, n: 0 }).sum += v;
    out[id].n++;
  }
  for (const id of Object.keys(out)) out[id] = { score: out[id].sum / out[id].n, n: out[id].n };
  return { scores: out, dates };
}

// Smart-average weights: the best recent source gets weight 1; every 8 points behind it cuts the weight by ~63%.
// Needs at least 3 scored days for a source; returns null (plain average) until 2+ sources qualify.
export const MIN_DAYS_FOR_WEIGHT = 3;
export function smartWeights(scores, ids = null) {
  const ok = Object.entries(scores).filter(([id, v]) => v.n >= MIN_DAYS_FOR_WEIGHT && (!ids || ids.includes(id)) && !PSEUDO.has(id));
  if (ok.length < 2) return null;
  const best = Math.max(...ok.map(([, v]) => v.score));
  return Object.fromEntries(ok.map(([id, v]) => [id, Math.exp((v.score - best) / 8)]));
}

export const PSEUDO = new Set(["avg", "smart", "best"]);
export const PSEUDO_NAMES = { avg: "Average (all sources)", smart: "Smart average", best: "Best forecast" };

// Rating bands for the green→red shading. Always shown with the number and a word, never color alone.
export function rating(score) {
  if (!isNum(score)) return null;
  if (score >= 88) return { key: "good", label: "Great" };
  if (score >= 80) return { key: "warning", label: "Good" };
  if (score >= 70) return { key: "serious", label: "Fair" };
  return { key: "critical", label: "Poor" };
}

// ---------- Per-element skill (for the "Best forecast") ----------
// Each element has its own error measure; lower is better. `scale` sets how quickly weight
// falls off behind the leader (one `scale` of extra error ≈ 63% less weight).
const absv = v => isNum(v) ? Math.abs(v) : null;
export const ELEMENTS = {
  high:   { label: "High temp",     err: s => absv(s.hiErr),  scale: 1.0,  min: 3, fmt: "deg" },
  low:    { label: "Low temp",      err: s => absv(s.loErr),  scale: 1.0,  min: 3, fmt: "deg" },
  temp:   { label: "Hourly temps",  err: s => s.mae,          scale: 0.75, min: 3, fmt: "deg" },
  rain:   { label: "Rain chance",   err: s => isNum(s.brier) ? s.brier : (s.rain === "hit" || s.rain === "none") ? 0 : 1, scale: 0.06, min: 3, fmt: "brier" },
  timing: { label: "Rain timing",   err: s => s.rain === "hit" ? absv(s.timing) : null, scale: 1.0, min: 2, fmt: "hours" },
  amount: { label: "Rain amount",   err: (s, d) => isNum(s.qpfErr) && (d?.obs?.rained || s.qpf >= 0.01) ? Math.abs(s.qpfErr) : null, scale: 0.05, min: 2, fmt: "inches" },
  wind:   { label: "Wind",          err: s => s.windMae,      scale: 1.0,  min: 3, fmt: "mph" },
  humidity: { label: "Humidity",    err: s => s.humMae,       scale: 3.0,  min: 3, fmt: "pct" },
};
// Rain skill uses a longer memory than temperature: the last WET_DAYS days when rain was in play
// (it rained, or a source called for it), however far back those are. Two dry weeks would
// otherwise leave one or two wet days deciding who leads on rain.
const WET_ELEMENTS = new Set(["rain", "timing", "amount"]);
export const WET_DAYS = 10, WET_MIN_DAYS = 3;
const rainInPlay = d => !!d.obs?.rained || Object.entries(d.src || {}).some(([id, s]) => !PSEUDO.has(id) && s?.ok && (s.rain === "hit" || s.rain === "false" || (isNum(s.maxPop) && s.maxPop >= 30)));
export function elementSkill(days, { locs = null, lead = 0, n = 7, before = null } = {}) {
  const pool = days.filter(d => (d.lead ?? 0) === lead && !d.partial && (!locs || locs.includes(d.loc)) && (!before || d.date < before));
  const dates = [...new Set(pool.map(d => d.date))].sort().slice(-n);
  const use = pool.filter(d => dates.includes(d.date));
  const wetDates = [...new Set(pool.filter(rainInPlay).map(d => d.date))].sort().slice(-WET_DAYS);
  const wet = wetDates.length >= WET_MIN_DAYS ? new Set(wetDates) : null;
  const out = {};
  for (const el of Object.keys(ELEMENTS)) out[el] = {};
  for (const d of pool) for (const [id, s] of Object.entries(d.src)) {
    if (!s?.ok || PSEUDO.has(id)) continue;
    const recent = dates.includes(d.date);
    for (const [el, E] of Object.entries(ELEMENTS)) {
      if (WET_ELEMENTS.has(el) && wet ? !wet.has(d.date) : !recent) continue;
      const e = E.err(s, d);
      if (!isNum(e)) continue;
      const o = (out[el][id] ||= { sum: 0, n: 0 });
      o.sum += e; o.n++;
    }
  }
  for (const el of Object.keys(out)) for (const id of Object.keys(out[el])) out[el][id] = { err: out[el][id].sum / out[el][id].n, n: out[el][id].n };
  return { skill: out, dates, wetDates: wet ? wetDates : null };
}
// Weights for one element among `ids` (sources with data right now). Null until 2+ sources have enough history.
export function elementWeights(skill, el, ids = null) {
  const E = ELEMENTS[el];
  const ok = Object.entries(skill[el] || {}).filter(([id, v]) => v.n >= E.min && (!ids || ids.includes(id)));
  if (ok.length < 2) return null;
  const best = Math.min(...ok.map(([, v]) => v.err));
  return Object.fromEntries(ok.map(([id, v]) => [id, Math.exp(-(v.err - best) / E.scale)]));
}
export function elementLeader(skill, el, ids = null) {
  const E = ELEMENTS[el];
  const ok = Object.entries(skill[el] || {}).filter(([id, v]) => v.n >= E.min && (!ids || ids.includes(id))).sort((a, b) => a[1].err - b[1].err);
  return ok.length ? { id: ok[0][0], ...ok[0][1] } : null;
}
// The Best forecast needs this many fully scored days first.
export const BEST_MIN_DAYS = 3;

// ---------- Best forecast track record (display only) ----------
// How the Best forecast has scored against every single source, on the days it was scored.
// Read-only: nothing here (or any Best score) feeds back into the weights. elementSkill and
// smartWeights skip the blends ("avg", "smart", "best") entirely.
export function bestRecord(days, { locs = null, lead = 0, ids = null } = {}) {
  const rows = (days || []).filter(d => (d.lead ?? 0) === lead && !d.partial && (!locs || locs.includes(d.loc)) && isNum(dayScore(d.src?.best)));
  if (!rows.length) return null;
  const per = {}, byDate = {};
  let beatAll = 0, beatAvg = 0, nAvg = 0;
  for (const d of rows) {
    const b = dayScore(d.src.best);
    let top = -Infinity;
    for (const [id, s] of Object.entries(d.src)) {
      if (PSEUDO.has(id) || (ids && !ids.includes(id))) continue;
      const v = dayScore(s);
      if (!isNum(v)) continue;
      (per[id] ||= []).push(v);
      if (v > top) top = v;
    }
    if (b >= top) beatAll++;
    const a = dayScore(d.src.avg);
    if (isNum(a)) { nAvg++; if (b > a) beatAvg++; }
    const o = (byDate[d.date] ||= { best: [], avg: [], src: {} });
    o.best.push(b); o.avg.push(a);
    for (const [id, s] of Object.entries(d.src)) if (!PSEUDO.has(id)) (o.src[id] ||= []).push(dayScore(s));
  }
  // Single sources that were scored on at least half of those days.
  const singles = Object.entries(per).filter(([, v]) => v.length >= rows.length / 2).map(([id, v]) => ({ id, score: mean(v), n: v.length })).sort((a, b) => b.score - a.score);
  const score = mean(rows.map(d => dayScore(d.src.best)));
  const abs = k => mean(rows.map(d => isNum(d.src.best[k]) ? Math.abs(d.src.best[k]) : null));
  const top = singles[0] || null;
  const dates = Object.keys(byDate).sort();
  return {
    n: rows.length, nDates: dates.length, since: dates[0], score,
    rank: 1 + singles.filter(s => s.score > score).length, of: singles.length + 1,
    top, margin: top ? score - top.score : null, singles,
    beatAll, beatAvg, nAvg, avgScore: mean(rows.map(d => dayScore(d.src.avg))), smartScore: mean(rows.map(d => dayScore(d.src.smart))),
    hiMAE: abs("hiErr"), loMAE: abs("loErr"), mae: mean(rows.map(d => d.src.best.mae)),
    rainRight: rows.filter(d => d.src.best.rain === "hit" || d.src.best.rain === "none").length / rows.length,
    series: dates.map(date => ({ date, best: mean(byDate[date].best), avg: mean(byDate[date].avg), top: top ? mean(byDate[date].src[top.id] || []) : null })),
  };
}

// How far off the Best forecast's highs and lows usually are: the miss it stayed within on 3 days
// out of 4, over its last 14 scored days made the current way (method 2: bias-corrected).
// Null until there are a few such days.
export const BEST_METHOD = 2;
export function bestTypical(days, { locs = null, lead = 0, n = 14, min = 3 } = {}) {
  const rows = (days || []).filter(d => (d.lead ?? 0) === lead && !d.partial && (!locs || locs.includes(d.loc)) && d.src?.best?.ok && (d.src.best.method ?? 1) >= BEST_METHOD);
  const dates = [...new Set(rows.map(d => d.date))].sort().slice(-n);
  const use = rows.filter(d => dates.includes(d.date));
  if (dates.length < min) return null;
  const p75 = k => { const v = use.map(d => d.src.best[k]).filter(isNum).map(Math.abs).sort((a, b) => a - b); if (!v.length) return null; const i = 0.75 * (v.length - 1), lo = Math.floor(i); return v[lo] + (v[Math.min(v.length - 1, lo + 1)] - v[lo]) * (i - lo); };
  return { hi: p75("hiErr"), lo: p75("loErr"), n: dates.length };
}
