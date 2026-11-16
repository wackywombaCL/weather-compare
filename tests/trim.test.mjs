// Monthly history trim (scripts/trim.mjs) and the Sunday scorecard text (scripts/daily.mjs).
// Run: node tests/trim.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { trimHistory, KEEP_DAYS, SNAP_DAYS } from "../scripts/trim.mjs";
import { weeklySummary } from "../scripts/daily.mjs";
import { bestRecord } from "../src/skill.js";

const DAY = 864e5, TODAY = "2027-02-01";
const dateAgo = n => new Date(Date.parse(TODAY) - n * DAY).toISOString().slice(0, 10);
const src = e => ({ ok: true, hiErr: e, loErr: -e, mae: e, brier: 0.05, rain: "none" });
const mkDays = n => Array.from({ length: n }, (_, i) => ["vallejo", "napa"].map(loc => ({ date: dateAgo(n - i), loc, lead: 0, partial: false,
  obs: { hi: 70, lo: 50, rained: false, hours: Array(24).fill(60), wind: Array(24).fill(5), hum: Array(24).fill(70), parts: { A: { hi: 70, lo: 50 } } },
  src: { nws: src(1), metno: src(2), m_gfs: src(3), avg: src(2), smart: src(1.5), best: src(0.8) } }))).flat();
const dataDir = await mkdtemp(path.join(tmpdir(), "trim-"));
await mkdir(path.join(dataDir, "forecasts"));
const json = async f => JSON.parse(await readFile(path.join(dataDir, f), "utf8"));

// 1. Nothing happens until the oldest day is a month past the limit.
let scores = { days: mkDays(KEEP_DAYS + 20), sources: {} };
for (let i = 1; i <= SNAP_DAYS + 5; i++) await writeFile(path.join(dataDir, "forecasts", `${dateAgo(i)}.json`), "{}");
assert.deepEqual(await trimHistory({ dataDir, scores, today: TODAY }), { moved: 0, deleted: 0 });
assert.equal(scores.days.length, (KEEP_DAYS + 20) * 2);

// 2. When due: old days move to per-year history files, nothing is lost, all-time numbers match.
scores = { days: mkDays(120), sources: {} };
for (let i = 81; i <= 120; i++) await writeFile(path.join(dataDir, "forecasts", `${dateAgo(i)}.json`), "{}");
const before = bestRecord(scores.days, { ids: ["nws", "metno", "m_gfs"] });
const r = await trimHistory({ dataDir, scores, today: TODAY });
assert.equal(r.moved, (120 - KEEP_DAYS) * 2);
assert.equal(scores.days.length, KEEP_DAYS * 2);
const idx = await json("history/index.json");
assert.deepEqual(idx.files, ["2026.json"]);          // 61–120 days before Feb 1, 2027 all fall in 2026
const hist = (await Promise.all(idx.files.map(f => json("history/" + f)))).flatMap(h => h.days);
assert.equal(hist.length, r.moved);
assert.ok(!("hours" in hist[0].obs) && hist[0].obs.hi === 70 && hist[0].src.best.ok);
const after = bestRecord([...hist, ...scores.days], { ids: ["nws", "metno", "m_gfs"] });
assert.equal(after.n, before.n); assert.equal(after.score, before.score); assert.equal(after.since, before.since);
assert.equal((await readdir(path.join(dataDir, "forecasts"))).length, SNAP_DAYS);
assert.equal(r.deleted, 5 + 40);

// 3. Running it again adds no duplicates.
await trimHistory({ dataDir, scores: { days: mkDays(120), sources: {} }, today: TODAY });
assert.equal((await json("history/2026.json")).days.length, hist.length);

// 4. Sunday scorecard text.
const wk = weeklySummary({ days: mkDays(10), sources: { nws: { short: "NWS" }, metno: { short: "Yr" }, m_gfs: { short: "GFS" } } });
assert.match(wk.title, /^Weekly forecast scorecard \(/);
assert.match(wk.body, /Best forecast: 93 \(Great\), #1 of 4 · Vallejo 93, Napa 93/);
assert.match(wk.body, /Top sources: NWS 92, Yr 85, GFS 78/);
assert.equal(weeklySummary({ days: mkDays(2), sources: {} }), null);
console.log("trim: 4 checks passed");
