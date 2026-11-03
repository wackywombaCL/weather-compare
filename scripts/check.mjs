// Quick live check of every source for Vallejo. Run by .github/workflows/check.yml.
// Prints what each source returned (never the keys) so problems are easy to spot.
import { SOURCES, PRESETS, setRequestInit, setKeyProvider, dayKey } from "../src/sources.js";

setKeyProvider(id => { const s = SOURCES.find(x => x.id === id); return s?.key ? process.env[s.key.env] : null; });
setRequestInit({ headers: { "User-Agent": `weather-compare/1.0 (github.com/${process.env.GITHUB_REPOSITORY || "personal"})`, Accept: "application/geo+json, application/json" } });

const loc = PRESETS.vallejo, tz = loc.tz;
const fmt = t => new Date(t).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
let failed = 0;
for (const s of SOURCES) {
  if (s.key && !process.env[s.key.env]) { console.log(`- ${s.name}: skipped (no ${s.key.env} secret)`); continue; }
  try {
    const d = await s.fetch(loc);
    const c = d.current, h = d.hourly, days = Object.keys(d.daily).sort();
    const next = h.filter(x => x.t >= Date.now() - 3600e3);
    console.log(`✓ ${s.name}`);
    console.log(`    now: ${Math.round(c.temp)}°F, ${c.text}, feels ${c.feels == null ? "-" : Math.round(c.feels)}, hum ${c.humidity == null ? "-" : Math.round(c.humidity)}%, wind ${c.wind == null ? "-" : Math.round(c.wind)} mph (as of ${fmt(c.observedAt)})`);
    console.log(`    hourly: ${next.length} upcoming hours, ${fmt(next[0]?.t)} -> ${fmt(next.at(-1)?.t)}; first 4: ` + next.slice(0, 4).map(x => `${fmt(x.t)} ${Math.round(x.temp)}° ${x.pop == null ? "-" : Math.round(x.pop)}% ${x.cat}${x.night ? "/night" : ""}`).join(" | "));
    console.log(`    daily: ` + days.slice(0, 6).map(k => `${k} ${Math.round(d.daily[k].hi)}/${Math.round(d.daily[k].lo)} ${d.daily[k].pop == null ? "-" : Math.round(d.daily[k].pop)}% ${d.daily[k].cat}`).join(" | "));
    if (dayKey(Date.now(), tz) !== days[0]) console.log(`    note: first daily entry is ${days[0]}, today is ${dayKey(Date.now(), tz)}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${s.name}: ${e.message}${e.status ? ` (HTTP ${e.status})` : ""}`);
  }
}
if (failed) process.exitCode = 1;
