// Test of the NFL week rollover (scripts/nfl.mjs) with a fake ESPN feed.
// Week 9's last game is Monday night; week 10 must not load until 12:30am Pacific on Tuesday,
// and week 9 must be archived (with final scores) when it does. Run: node tests/nfl-week.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../scripts/nfl.mjs";

const ev = (id, date, state, score) => ({ id, date, shortName: `G${id}`, competitions: [{ venue: { fullName: "Soldier Field" },
  competitors: [{ homeAway: "home", team: { abbreviation: "CHI" }, score }, { homeAway: "away", team: { abbreviation: "TB" }, score }],
  status: { type: { state, shortDetail: state } } }] });
let WEEK9_STATE = "post";
globalThis.fetch = async (url) => {
  const u = new URL(url), j = d => new Response(JSON.stringify(d), { status: 200 });
  const week = u.searchParams.get("week");
  if (week === "10") return j({ season: { year: 2026, type: 2 }, week: { number: 10 }, events: [ev("1001", "2026-11-13T01:15Z", "pre"), ev("1002", "2026-11-15T18:00Z", "pre")] });
  return j({ season: { year: 2026, type: 2 }, week: { number: 9 }, events: [ev("901", "2026-11-08T18:00Z", "post", "21"), ev("902", "2026-11-10T01:15Z", WEEK9_STATE, "17")] });
};
const dir = await mkdtemp(path.join(tmpdir(), "wc-week-"));
const at = s => Date.parse(s);
const quiet = () => {};
let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log("  ✓ " + name); };

await check("Monday 11pm PT (Monday night game over): still week 9", async () => {
  const d = await run({ dataDir: dir, now: at("2026-11-09T23:00:00-08:00"), log: quiet });
  assert.equal(d.week, 9);
  assert.equal(existsSync(path.join(dir, "nfl", "weeks")), false);
});
await check("Tuesday 12:20am PT: still week 9", async () => {
  assert.equal((await run({ dataDir: dir, now: at("2026-11-10T00:20:00-08:00"), log: quiet })).week, 9);
});
await check("Tuesday 12:35am PT: week 10 loads and week 9 is archived with final scores", async () => {
  const d = await run({ dataDir: dir, now: at("2026-11-10T00:35:00-08:00"), log: quiet });
  assert.equal(d.week, 10);
  assert.equal(d.games.length, 2);
  const arch = JSON.parse(await readFile(path.join(dir, "nfl", "weeks", "2026-2-09.json"), "utf8"));
  assert.equal(arch.week, 9);
  assert.equal(arch.games.find(g => g.id === "902").home.score, "17");
});
await check("an unfinished week never rolls over early", async () => {
  WEEK9_STATE = "in";
  const d2 = await mkdtemp(path.join(tmpdir(), "wc-week2-"));
  assert.equal((await run({ dataDir: d2, now: at("2026-11-09T19:00:00-08:00"), log: quiet })).week, 9);
});
console.log(`\nAll ${n} week-rollover checks passed.`);
