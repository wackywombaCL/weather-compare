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
