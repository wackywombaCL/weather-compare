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

export const PSEUDO = new Set(["avg", "smart"]);
export const PSEUDO_NAMES = { avg: "Average (all sources)", smart: "Smart average" };

// Rating bands for the green→red shading. Always shown with the number and a word, never color alone.
export function rating(score) {
  if (!isNum(score)) return null;
  if (score >= 88) return { key: "good", label: "Great" };
  if (score >= 80) return { key: "warning", label: "Good" };
  if (score >= 70) return { key: "serious", label: "Fair" };
  return { key: "critical", label: "Poor" };
}
