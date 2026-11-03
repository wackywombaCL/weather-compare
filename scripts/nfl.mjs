// This week's NFL schedule (from ESPN's public scoreboard feed) → data/nfl.json for the NFL tab.
// Runs with the daily job. The app reads the file and adds stadium forecasts in the browser.
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "nfl.json");

const r = await fetch(URL, { headers: { "User-Agent": "weather-compare/1.0", Accept: "application/json" } });
if (!r.ok) { console.error("ESPN HTTP", r.status); process.exit(1); }
const j = await r.json();
const games = (j.events || []).map(e => {
  const c = e.competitions?.[0] || {};
  const side = h => {
    const t = (c.competitors || []).find(x => x.homeAway === h) || {};
    return { abbr: t.team?.abbreviation, name: t.team?.displayName, short: t.team?.shortDisplayName, logo: t.team?.logo, score: t.score ?? null };
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
const data = { updated: Date.now(), season: j.season?.year ?? null, seasonType: j.season?.type ?? null, week: j.week?.number ?? null, games };
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(data) + "\n");
console.log(`Week ${data.week}: ${games.length} games`);
for (const g of games) console.log(`  ${g.date} ${g.short.padEnd(10)} ${g.venue.name} (${g.venue.city}, ${g.venue.state || g.venue.country}) indoor=${g.venue.indoor} grass=${g.venue.grass} ${g.status.detail}`);
