// Accuracy math shared by the page and the daily job, so they always agree.
import { isNum, mean } from "./sources.js";

const clamp = v => Math.max(0, Math.min(100, v));

// 0–100 score for one source on one day: 70% temperature, 30% rain.
export function dayScore(s) {
  if (!s?.ok) return null;
  const tm = mean([isNum(s.hiErr) ? Math.abs(s.hiErr) : null, isNum(s.loErr) ? Math.abs(s.loErr) : null, s.mae]);
  if (!isNum(tm)) return null;
  const temp = clamp(100 - 10 * tm);
  const rain = isNum(s.brier) ? 100 * (1 - s.brier) : (s.rain === "hit" || s.rain === "none") ? 100 : 0;
  return 0.7 * temp + 0.3 * rain;
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
};
export function elementSkill(days, { locs = null, lead = 0, n = 7, before = null } = {}) {
  const pool = days.filter(d => (d.lead ?? 0) === lead && !d.partial && (!locs || locs.includes(d.loc)) && (!before || d.date < before));
  const dates = [...new Set(pool.map(d => d.date))].sort().slice(-n);
  const use = pool.filter(d => dates.includes(d.date));
  const out = {};
  for (const el of Object.keys(ELEMENTS)) out[el] = {};
  for (const d of use) for (const [id, s] of Object.entries(d.src)) {
    if (!s?.ok || PSEUDO.has(id)) continue;
    for (const [el, E] of Object.entries(ELEMENTS)) {
      const e = E.err(s, d);
      if (!isNum(e)) continue;
      const o = (out[el][id] ||= { sum: 0, n: 0 });
      o.sum += e; o.n++;
    }
  }
  for (const el of Object.keys(out)) for (const id of Object.keys(out[el])) out[el][id] = { err: out[el][id].sum / out[el][id].n, n: out[el][id].n };
  return { skill: out, dates };
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
