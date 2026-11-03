// NFL weather phone alerts (ntfy). Runs every 5 minutes inside the lightning job; it only does
// work in these windows (Pacific time), and only sends when a game has SIGNIFICANT weather:
//   • Saturday 8:00pm      → the rest of the weekend's outdoor games (Sunday + Monday)
//   • Sunday 9:00am        → Sunday's outdoor games still to be played
//   • Sunday 12:45pm       → Sunday afternoon/evening games (kickoff 1pm PT or later)
//   • 1 hour before kickoff for Thursday and Saturday games
// Each alert is sent once (remembered in data/nfl-alerts.json).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setRequestInit } from "../src/sources.js";
import { findStadium } from "../src/stadiums.js";
import { fetchStadiumWeather, gameWeather, flagsFor, modelAgreement } from "../src/nflwx.js";

const TZ = "America/Los_Angeles";
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const STATE = path.join(DATA, "nfl-alerts.json");
const SITE = "https://wackywombacl.github.io/weather-compare/#nfl";
const now = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
const DRY = !!process.env.DRY_RUN;
setRequestInit({ headers: { "User-Agent": "weather-compare/1.0 (github.com/wackywombaCL/weather-compare)" } });

const parts = t => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t).map(p => [p.type, p.value]));
const p = parts(now), mins = +p.hour * 60 + +p.minute, day = p.weekday, date = `${p.year}-${p.month}-${p.day}`;
const kickTxt = t => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(t).replace(":00", "").replace(" AM", "am").replace(" PM", "pm");
const within = (start, len = 45) => mins >= start && mins < start + len;

const state = JSON.parse(await readFile(STATE, "utf8").catch(() => "{}"));
state.sent ||= {};
let sched;
try { sched = JSON.parse(await readFile(path.join(DATA, "nfl.json"), "utf8")); } catch { process.exit(0); }
const games = (sched.games || []).filter(g => g.status?.state === "pre");

// Which alerts are due right now?
const due = [];
if (day === "Sat" && within(20 * 60)) due.push({ key: `sat-${date}`, title: "NFL weekend weather", pick: g => Date.parse(g.date) > now && Date.parse(g.date) - now < 3 * 24 * 3600e3 });
if (day === "Sun" && within(9 * 60)) due.push({ key: `sun-am-${date}`, title: "NFL Sunday weather", pick: g => Date.parse(g.date) > now && parts(Date.parse(g.date)).weekday === "Sun" });
if (day === "Sun" && within(12 * 60 + 45)) due.push({ key: `sun-pm-${date}`, title: "NFL afternoon weather", pick: g => { const k = Date.parse(g.date); const q = parts(k); return k > now && q.weekday === "Sun" && +q.hour >= 13; } });
for (const g of games) {
  const k = Date.parse(g.date), wd = parts(k).weekday;
  if ((wd === "Thu" || wd === "Sat") && k - now <= 75 * 60e3 && k - now > 15 * 60e3)
    due.push({ key: `pre-${g.id}`, title: `NFL pregame weather: ${g.short}`, pick: x => x.id === g.id });
}
const todo = due.filter(d => !state.sent[d.key]);
if (!todo.length) process.exit(0);

// Forecast the outdoor games involved, once each.
const cache = new Map();
async function check(g) {
  const st = findStadium(g.venue?.name);
  if (!st || st.roof !== "open") return null;           // domes, roofs and unknown venues: skip
  const key = `${st.lat},${st.lon}`;
  if (!cache.has(key)) cache.set(key, await fetchStadiumWeather(st.lat, st.lon).catch(e => { console.log("forecast failed", st.name, e.message); return null; }));
  const wx = cache.get(key);
  if (!wx) return null;
  const gw = gameWeather(wx, Date.parse(g.date));
  const sig = flagsFor(gw.win, gw.before, st).filter(f => f.lvl === "sig");
  return sig.length ? { g, st, sig, agree: modelAgreement(gw.byModel) } : null;
}
for (const d of todo) {
  const hits = (await Promise.all(games.filter(d.pick).map(check))).filter(Boolean).sort((a, b) => Date.parse(a.g.date) - Date.parse(b.g.date));
  state.sent[d.key] = now;                                // checked: don't repeat, whether or not there was weather
  if (!hits.length) { console.log(`${d.key}: no significant weather`); continue; }
  const body = hits.map(h => `${h.g.short} · ${kickTxt(Date.parse(h.g.date))} PT · ${h.st.name}\n  ${h.sig.map(f => `${f.ic} ${f.t}`).join("\n  ")}${h.agree ? `\n  Models agree: ${h.agree.level}` : ""}`).join("\n");
  const title = `${d.title}: ${hits.length} game${hits.length > 1 ? "s" : ""}`;
  console.log(`NOTIFY [${title}]\n${body}`);
  if (!DRY && process.env.NTFY_TOPIC) {
    try { await fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, { method: "POST", body, headers: { Title: title.replace(/[^\x20-\x7e]/g, ""), Tags: "football", Priority: "high", Click: SITE } }); }
    catch (e) { console.log("notification failed:", e.message); }
  }
}
for (const [k, t] of Object.entries(state.sent)) if (now - t > 21 * 24 * 3600e3) delete state.sent[k];
if (!DRY) await writeFile(STATE, JSON.stringify(state) + "\n");
