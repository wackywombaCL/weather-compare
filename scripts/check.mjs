// Quick live check of every source for Vallejo. Run by .github/workflows/check.yml.
// Prints what each source returned (never the keys) so problems are easy to spot.
import { SOURCES, PRESETS, setRequestInit, setKeyProvider, setProxy, dayKey, getJSON, cToF } from "../src/sources.js";
import { stationCandidates, getObservations, windowFor, TZ } from "./daily.mjs";

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
    console.log(`    daily: ` + days.slice(0, 6).map(k => `${k} ${Math.round(d.daily[k].hi)}/${Math.round(d.daily[k].lo)} ${d.daily[k].pop == null ? "-" : Math.round(d.daily[k].pop)}% ${d.daily[k].qpf == null ? "" : d.daily[k].qpf.toFixed(2) + "in "}${d.daily[k].cat}`).join(" | "));
    const wet = next.filter(x => x.qpf > 0).slice(0, 3);
    console.log(`    rain amounts: ${h.some(x => x.qpf != null) ? (wet.length ? "first wet hours " + wet.map(x => `${fmt(x.t)} ${x.qpf.toFixed(2)}in`).join(", ") : "none expected") : "NOT PROVIDED"}`);
    if (d.cost != null) console.log(`    request cost: ${d.cost} records`);
    if (dayKey(Date.now(), tz) !== days[0]) console.log(`    note: first daily entry is ${days[0]}, today is ${dayKey(Date.now(), tz)}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${s.name}: ${e.message}${e.status ? ` (HTTP ${e.status})` : ""}`);
  }
}
// Shared key server (Cloudflare Worker): every keyed source through it, as a friend's phone would.
import { PROXY_URL } from "../src/config.js";
if (PROXY_URL && process.env.ACCESS_CODE) {
  console.log(`\nKey server ${PROXY_URL}:`);
  setKeyProvider(() => null);                         // no local keys: force the server
  setProxy({ url: PROXY_URL, code: process.env.ACCESS_CODE });
  for (const s of SOURCES.filter(x => x.key)) {
    try { const d = await s.fetch(PRESETS.napa); console.log(`  ✓ ${s.name} via server: now ${Math.round(d.current.temp)}°F, ${d.hourly.length} hours`); }
    catch (e) { failed++; console.log(`  ✗ ${s.name} via server: ${e.message}`); }
  }
  try { const r = await fetch(`${PROXY_URL}/v1/pirate?lat=38.3&lon=-122.29`, { headers: { "X-Access-Code": "wrong" } }); console.log(`  wrong code is rejected: ${r.status === 401 ? "yes" : "NO (HTTP " + r.status + ")"}`); } catch (e) { console.log("  wrong-code test failed:", e.message); }
}

// Every NWS-listed station within 15 miles of Vallejo (all networks), with its latest report.
{
  const v = PRESETS.vallejo;
  const mi = (a, b) => { const R = 3958.8, r = x => x * Math.PI / 180; const dl = r(b[0] - a[0]), dn = r(b[1] - a[1]); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  let url = "https://api.weather.gov/stations?state=CA&limit=500", all = [];
  for (let page = 0; url && page < 20; page++) {
    try { const j = await getJSON(url); all.push(...(j.features || [])); url = (j.features || []).length ? j.pagination?.next : null; } catch (e) { console.log("station list failed:", e.message); break; }
  }
  const near = all.map(f => ({ id: f.properties.stationIdentifier, name: f.properties.name, d: mi([v.lat, v.lon], [f.geometry.coordinates[1], f.geometry.coordinates[0]]) })).filter(x => x.d <= 15).sort((a, b) => a.d - b.d);
  console.log(`\nNWS stations within 15 mi of Vallejo (${all.length} CA stations scanned):`);
  for (const x of near) {
    let latest = "";
    try { const ob = (await getJSON(`https://api.weather.gov/stations/${x.id}/observations/latest`, { tries: 1 })).properties; latest = `latest ${Math.round((Date.now() - Date.parse(ob.timestamp)) / 60000)} min ago, ${ob.temperature?.value == null ? "no temp" : Math.round(cToF(ob.temperature.value)) + "°F"}`; } catch (e) { latest = "no recent data"; }
    console.log(`  ${x.id.padEnd(8)} ${x.d.toFixed(1)} mi  ${x.name} — ${latest}`);
  }
}

// Vallejo local-station average vs Napa airport for the last full 6am→6am day.
{
  const win = windowFor(dayKey(Date.now() - 30 * 3600e3, TZ));
  for (const l of [PRESETS.vallejo, PRESETS.napa]) {
    const got = await getObservations(l, win);
    if (!got) { console.log(`\n${l.name}: no observations`); continue; }
    const o = got.ob;
    console.log(`\n${l.name} ${dayKey(win.start, TZ)} 6am→6am: ${got.station.id} (${got.station.name}${got.station.mi ? ", " + got.station.mi + " mi" : ""}) high ${o.hi}° low ${o.lo}° rain ${o.rained ? "yes " + (o.precipIn ?? "") + "in" : "no"}${o.parts ? " | per station: " + Object.entries(o.parts).map(([id, p]) => `${id} ${p.hi}/${p.lo}`).join(", ") : ""}`);
  }
}

// Station quality over the last 24 hours (candidates for scoring Vallejo).
{
  const ids = (process.env.STATION_PROBE || "UR476,C0879,G7397,E4251,MZXC1,F8437,C6944,G0070,KAPC").split(",");
  console.log("\nStation quality, last 24 h (reports / with temp / wind / humidity / rain field):");
  const end = new Date(), start = new Date(Date.now() - 24 * 3600e3);
  for (const id of ids) {
    try {
      const meta = await getJSON(`https://api.weather.gov/stations/${id}`, { tries: 1 });
      const [lon, lat] = meta.geometry.coordinates;
      const j = await getJSON(`https://api.weather.gov/stations/${id}/observations?start=${start.toISOString()}&end=${end.toISOString()}`, { tries: 2 });
      const o = (j.features || []).map(f => f.properties);
      const c = k => o.filter(p => p[k]?.value != null).length;
      const temps = o.map(p => p.temperature?.value).filter(v => v != null).map(cToF);
      console.log(`  ${id.padEnd(6)} ${meta.properties.name} (${lat.toFixed(3)}, ${lon.toFixed(3)}, elev ${Math.round((meta.properties.elevation?.value ?? 0) * 3.281)} ft): ${o.length} reports / ${c("temperature")} temp / ${c("windSpeed")} wind / ${c("relativeHumidity")} hum / ${c("precipitationLastHour")} rain-hr / ${c("precipitationLast6Hours")} rain-6h; temp range ${temps.length ? Math.round(Math.min(...temps)) + "–" + Math.round(Math.max(...temps)) + "°F" : "-"}`);
    } catch (e) { console.log(`  ${id}: ${e.message}`); }
  }
}

// Nearby observation stations: which ones report, and how far away they are.
for (const l of [PRESETS.vallejo, PRESETS.napa]) {
  console.log(`\nStations near ${l.name}:`);
  for (const st of await stationCandidates(l)) {
    try {
      const ob = (await getJSON(`https://api.weather.gov/stations/${st.id}/observations/latest`, { tries: 1 })).properties;
      const age = Math.round((Date.now() - Date.parse(ob.timestamp)) / 60000);
      const t = ob.temperature?.value;
      console.log(`  ${st.id} ${st.name || ""} (${st.mi ?? "?"} mi): latest ${age} min ago, ${t == null ? "no temp" : Math.round(cToF(t)) + "°F"}, rain-hour ${ob.precipitationLastHour?.value ?? "n/a"}`);
    } catch (e) { console.log(`  ${st.id} ${st.name || ""} (${st.mi ?? "?"} mi): no data (${e.message})`); }
  }
}
// Test phone notification (only if the NTFY_TOPIC secret is set)
if (process.env.NTFY_TOPIC) {
  try {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, { method: "POST", body: `Test from Weather Compare: notifications are working. ${SOURCES.length - failed} of ${SOURCES.length} sources OK.`, headers: { Title: "Weather Compare test", Tags: "white_check_mark", Click: "https://wackywombacl.github.io/weather-compare/" } });
    console.log(`\nTest notification: ${r.ok ? "sent" : "HTTP " + r.status}`);
  } catch (e) { console.log(`\nTest notification failed: ${e.message}`); }
} else console.log("\nNo NTFY_TOPIC secret: skipping test notification");
if (failed) process.exitCode = 1;
