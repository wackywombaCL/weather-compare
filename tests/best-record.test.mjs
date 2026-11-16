// The Best forecast's track record is display-only: scoring it must never change its weights.
// Run: node tests/best-record.test.mjs
import assert from "node:assert/strict";
import { bestRecord, elementSkill, elementWeights, recentScores, smartWeights } from "../src/skill.js";

const src = (e, brier = 0.05) => ({ ok: true, hiErr: e, loErr: -e, mae: e, brier, rain: "none", windMae: 2, humMae: 5 });
const mk = best => Array.from({ length: 6 }, (_, i) => ({ date: `2026-11-0${i + 1}`, loc: "vallejo", lead: 0, src: {
  nws: src(1), metno: src(2), m_gfs: src(i === 0 ? 0.2 : 3), avg: src(2), smart: src(1.5), ...(best && i > 0 ? { best: src(best) } : {}) } }));

// 1. Weights are identical whether the Best was scored perfectly, terribly or not at all.
const ids = ["nws", "metno", "m_gfs"];
const weights = days => JSON.stringify([
  ["high", "low", "temp", "rain", "wind", "humidity"].map(el => elementWeights(elementSkill(days, { locs: ["vallejo"], n: 14 }).skill, el, ids)),
  smartWeights(recentScores(days, { locs: ["vallejo"], n: 14 }).scores, ids)]);
assert.equal(weights(mk(0.1)), weights(mk(null)));
assert.equal(weights(mk(9)), weights(mk(null)));
assert.ok(!("best" in elementSkill(mk(0.1), { n: 14 }).skill.high));

// 2. The record only counts days the Best was scored, and compares sources on those same days.
const r = bestRecord(mk(0.5), { locs: ["vallejo"], ids });
assert.equal(r.n, 5);                       // day 1 had no Best
assert.equal(r.since, "2026-11-02");
assert.equal(r.rank, 1); assert.equal(r.of, 4);
assert.equal(r.top.id, "nws");              // GFS's great day 1 isn't counted
assert.equal(r.beatAll, 5); assert.equal(r.beatAvg, 5);
assert.equal(r.series.length, 5);
assert.ok(Math.abs(r.hiMAE - 0.5) < 1e-9);
// A poor Best ranks last and is reported honestly.
const bad = bestRecord(mk(6), { locs: ["vallejo"], ids });
assert.equal(bad.rank, 4); assert.equal(bad.beatAll, 0); assert.ok(bad.margin < 0);
assert.equal(bestRecord(mk(null), { ids }), null);
console.log("best-record: 3 checks passed");

// Rain memory: rain weights come from the last 10 days rain was in play, however far back;
// temperature weights still come from the most recent days only.
{
  const day = (i, wet) => ({ date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), loc: "vallejo", lead: 0, obs: { rained: wet },
    src: { a: { ok: true, hiErr: 1, loErr: 1, mae: 1, brier: wet ? 0.02 : 0, maxPop: wet ? 90 : 0, rain: wet ? "hit" : "none" },
           b: { ok: true, hiErr: 1, loErr: 1, mae: 1, brier: wet ? 0.6 : 0, maxPop: wet ? 20 : 0, rain: wet ? "miss" : "none" } } });
  // 4 wet days early in the month, then 20 dry ones.
  const hist = Array.from({ length: 24 }, (_, i) => day(i, i < 4));
  const sk = elementSkill(hist, { n: 14 });
  assert.equal(sk.wetDates.length, 4);
  assert.equal(sk.skill.rain.a.n, 4); assert.ok(sk.skill.rain.b.err > 0.5);     // remembered from 3 weeks ago
  assert.equal(sk.skill.temp.a.n, 14);                                           // temperature: last 14 days only
  const w = elementWeights(sk.skill, "rain", ["a", "b"]); assert.ok(w.a > 100 * w.b);
  // With fewer than 3 such days it falls back to the recent window.
  const dry = elementSkill(Array.from({ length: 24 }, (_, i) => day(i, i < 2)), { n: 14 });
  assert.equal(dry.wetDates, null); assert.equal(dry.skill.rain.a.n, 14);
  console.log("best-record: rain memory check passed");
}

// Rain amount in the score, and the "usually within" range.
import { amountScore, dayScore, bestTypical } from "../src/skill.js";
{
  const s = (qpf, obs, extra = {}) => ({ ok: true, hiErr: 0, loErr: 0, mae: 0, brier: 0, rain: "hit", qpf, qpfErr: Math.round((qpf - obs) * 100) / 100, ...extra });
  assert.equal(amountScore(s(0, 0)), null);                       // dry day, nothing forecast: not counted
  assert.equal(amountScore({ ok: true, qpf: null, qpfErr: null }), null);
  assert.equal(Math.round(amountScore(s(0.1, 1))), 10);           // far too little
  assert.equal(Math.round(amountScore(s(1, 1))), 100);
  assert.equal(Math.round(amountScore(s(0.02, 0))), 80);          // a trace on a dry day costs little
  assert.equal(dayScore(s(0, 0)), 100);                           // perfect temps + right call, no rain in play
  assert.equal(Math.round(dayScore(s(0.1, 1)) * 10) / 10, 70 + 30 * (0.6 + 0.4 * 0.1));
  const mk = (errs, method) => errs.map((e, i) => ({ date: `2026-11-${10 + i}`, loc: "vallejo", lead: 0, src: { best: { ok: true, hiErr: e, loErr: -e / 2, ...(method ? { method } : {}) } } }));
  assert.equal(bestTypical(mk([5, 5, 5, 5], null), { locs: ["vallejo"] }), null);       // old-method days don't count
  assert.equal(bestTypical(mk([1, 2], 2), { locs: ["vallejo"] }), null);               // needs 3 days
  const ty = bestTypical(mk([1, -2, 3, -4, 0], 2), { locs: ["vallejo"] });
  assert.equal(ty.hi, 3); assert.equal(ty.lo, 1.5); assert.equal(ty.n, 5);
  console.log("best-record: rain amount score and typical-miss checks passed");
}
