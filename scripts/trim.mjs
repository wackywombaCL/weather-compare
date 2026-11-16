// Keeps the app's data files small. Called by the daily job (scripts/daily.mjs); it does
// something about once a month, when the oldest day in data/scores.json is a month past KEEP_DAYS.
//
// - Scored days older than KEEP_DAYS move from data/scores.json to data/history/{year}.json
//   (hour-by-hour observations dropped; every score kept, so all-time tables are unchanged).
//   The app loads those history files in the background.
// - Saved forecast files (data/forecasts/{date}.json) older than SNAP_DAYS are deleted: they are
//   only needed to score the next few days and to draw the "Last 3 days" charts.
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export const KEEP_DAYS = 60;      // days of full detail kept in scores.json
export const SNAP_DAYS = 35;      // days of saved forecast files kept
const SLACK_DAYS = 31;            // trim when the oldest entry is this far past the limit (≈ monthly)
const DAY = 24 * 3600e3;
const readJSON = async (f, d) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return d; } };
const writeJSON = async (f, d) => { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(d) + "\n"); };
const age = (date, today) => Math.round((Date.parse(today) - Date.parse(date)) / DAY);
const keyOf = d => `${d.date}|${d.loc}|${d.lead ?? 0}`;
const compact = d => { const { hours, wind, hum, parts, ...obs } = d.obs || {}; return { ...d, obs }; };

// scores: the parsed data/scores.json (changed in place). today: "YYYY-MM-DD".
// Returns { moved, deleted } (both 0 when nothing was due).
export async function trimHistory({ dataDir, scores, today, force = false, log = () => {} }) {
  let moved = 0, deleted = 0;
  const oldest = scores.days.reduce((m, d) => d.date < m ? d.date : m, today);
  if (force || age(oldest, today) >= KEEP_DAYS + SLACK_DAYS) {
    const old = scores.days.filter(d => age(d.date, today) > KEEP_DAYS);
    const byYear = {};
    for (const d of old) (byYear[d.date.slice(0, 4)] ||= []).push(compact(d));
    const dir = path.join(dataDir, "history");
    for (const [year, days] of Object.entries(byYear)) {
      const file = path.join(dir, `${year}.json`);
      const have = await readJSON(file, { year: +year, days: [] });
      const seen = new Set(have.days.map(keyOf));
      have.days.push(...days.filter(d => !seen.has(keyOf(d))));
      have.days.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.lead ?? 0) - (b.lead ?? 0) || (a.loc < b.loc ? -1 : 1));
      await writeJSON(file, have);       // history is written before anything is removed from scores.json
    }
    if (old.length) {
      const files = (await readdir(dir)).filter(f => /^\d{4}\.json$/.test(f)).sort();
      await writeJSON(path.join(dir, "index.json"), { files, updated: Date.parse(today) });
      scores.days = scores.days.filter(d => age(d.date, today) <= KEEP_DAYS);
      moved = old.length;
      log(`Trim: moved ${moved} scored entries older than ${KEEP_DAYS} days to data/history/`);
    }
  }
  let snaps = [];
  try { snaps = (await readdir(path.join(dataDir, "forecasts"))).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort(); } catch {}
  if (snaps.length && (force || age(snaps[0].slice(0, 10), today) >= SNAP_DAYS + SLACK_DAYS)) {
    for (const f of snaps) if (age(f.slice(0, 10), today) > SNAP_DAYS) { await unlink(path.join(dataDir, "forecasts", f)); deleted++; }
    if (deleted) log(`Trim: deleted ${deleted} saved forecast files older than ${SNAP_DAYS} days`);
  }
  return { moved, deleted };
}
