// This week's NFL schedule (from ESPN's public scoreboard feed) → data/nfl.json for the NFL tab.
// Runs every 2 hours (nfl.yml) and with the daily job. The app reads the file and adds stadium
// forecasts in the browser.
//
// Week rollover: the current week stays up (finished games included) until 12:30am Pacific on
// the Tuesday after its last game. After that, next week's games are loaded and the finished
// week's schedule, with final scores, is archived to data/nfl/weeks/. Accuracy data
// (data/nfl/games, data/nfl/scores.json) is separate and never touched here.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dayKey, localHourStart } from "../src/sources.js";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const TZ = "America/Los_Angeles";
const H = 3600e3;

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": "weather-compare/1.0", Accept: "application/json" } });
  if (!r.ok) throw new Error("ESPN HTTP " + r.status);
  return r.json();
}

// 12:30am Pacific on the first Tuesday after the week's last kickoff (+4 h for the game itself).
export function rolloverAt(lastKick) {
  const after = lastKick + 4 * H;
  for (let d = 0; d < 9; d++) {
    const k = dayKey(after + d * 24 * H, TZ);
    const t = localHourStart(k, 0, TZ) + 30 * 60e3;
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(localHourStart(k, 12, TZ));
    if (wd === "Tue" && t > after) return t;
  }
  return after + 2 * 24 * H;
}

export function parse(j, now) {
  const games = (j.events || []).map(e => {
    const c = e.competitions?.[0] || {};
    const side = h => {
      const t = (c.competitors || []).find(x => x.homeAway === h) || {};
      return { abbr: t.team?.abbreviation, name: t.team?.displayName, short: t.team?.shortDisplayName, logo: t.team?.logo,
        color: t.team?.color || null, alt: t.team?.alternateColor || null, score: t.score ?? null };
    };
    const v = c.venue || {};
    return {
      id: e.id, date: e.date, name: e.name, short: e.shortName,
      home: side("home"), away: side("away"),
      venue: { id: v.id, name: v.fullName, city: v.address?.city, state: v.address?.state, country: v.address?.country, indoor: v.indoor ?? null, grass: v.grass ?? null },
      neutral: !!c.neutralSite,
      status: { state: c.status?.type?.state || e.status?.type?.state, detail: c.status?.type?.shortDetail || e.status?.type?.shortDetail },
      tv: (c.broadcasts || []).flatMap(b => b.names || []).join(", ") || null,
    };
  });
  const last = Math.max(...games.map(g => Date.parse(g.date)).filter(Number.isFinite), 0);
  return { updated: now, season: j.season?.year ?? null, seasonType: j.season?.type ?? null, week: j.week?.number ?? null,
    rollover: last ? rolloverAt(last) : null, games };
}

export async function run({ dataDir, now = Date.now(), log = console.log } = {}) {
  const cur = await get(ESPN);
  let data = parse(cur, now);
  const finished = data.games.length && data.games.every(g => g.status.state === "post" || now > Date.parse(g.date) + 4.5 * H);
  if (finished && data.rollover && now >= data.rollover && cur.week?.number && cur.season?.type) {
    // Time to move on: archive this week (with its final scores), then load the next one.
    const archive = path.join(dataDir, "nfl", "weeks", `${data.season}-${data.seasonType}-${String(data.week).padStart(2, "0")}.json`);
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, JSON.stringify(data) + "\n");
    log(`archived week ${data.week} → ${path.relative(dataDir, archive)}`);
    try {
      let next = await get(`${ESPN}?seasontype=${cur.season.type}&week=${cur.week.number + 1}&dates=${cur.season.year}`);
      if (!(next.events || []).length && cur.season.type === 2) next = await get(`${ESPN}?seasontype=3&week=1&dates=${cur.season.year}`);
      if ((next.events || []).length) data = parse(next, now);
    } catch (e) { log("next week fetch failed: " + e.message); }
  }
  // Never let a temporary ESPN hiccup blank the tab.
  if (!data.games.length) { log("ESPN returned no games; keeping the current file"); return null; }
  const out = path.join(dataDir, "nfl.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(out, JSON.stringify(data) + "\n");
  const fmt = t => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(t);
  log(`Week ${data.week}: ${data.games.length} games; rolls over ${data.rollover ? fmt(data.rollover) + " PT" : "?"}`);
  for (const g of data.games) log(`  ${g.date} ${(g.short || "").padEnd(10)} ${g.venue.name} (${g.venue.city}, ${g.venue.state || g.venue.country}) ${g.status.detail}`);
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
  run({ dataDir }).catch(e => { console.error(e); process.exit(1); });
}
