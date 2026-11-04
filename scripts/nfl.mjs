// This week's NFL schedule (from ESPN's public scoreboard feed) → data/nfl.json for the NFL tab.
// Runs with the daily job. The app reads the file and adds stadium forecasts in the browser.
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "nfl.json");

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": "weather-compare/1.0", Accept: "application/json" } });
  if (!r.ok) throw new Error("ESPN HTTP " + r.status);
  return r.json();
}
let j = await get(URL);
// ESPN keeps showing a finished week until midweek: once every game is over, show the next one.
const done = ev => ev.length && ev.every(e => (e.competitions?.[0]?.status?.type?.state || e.status?.type?.state) === "post");
if (done(j.events || []) && j.week?.number && j.season?.type) {
  try {
    const next = await get(`${URL}?seasontype=${j.season.type}&week=${j.week.number + 1}&dates=${j.season.year}`);
    if ((next.events || []).length) j = next;
    else if (j.season.type === 2) {          // regular season over: try the first playoff week
      const po = await get(`${URL}?seasontype=3&week=1&dates=${j.season.year}`);
      if ((po.events || []).length) j = po;
    }
  } catch (e) { console.log("next week fetch failed:", e.message); }
}
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
const data = { updated: Date.now(), season: j.season?.year ?? null, seasonType: j.season?.type ?? null, week: j.week?.number ?? null, games };
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(data) + "\n");
console.log(`Week ${data.week}: ${games.length} games`);
for (const g of games) console.log(`  ${g.date} ${g.short.padEnd(10)} ${g.venue.name} (${g.venue.city}, ${g.venue.state || g.venue.country}) indoor=${g.venue.indoor} grass=${g.venue.grass} ${g.status.detail}`);
