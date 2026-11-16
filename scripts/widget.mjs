// Phone widget feed: the Best forecast for Vallejo and Napa, written to data/widget.json every
// 30 minutes (widget.yml) for the KWGT home-screen widget (widget/*.kwgt) to read.
// Same math as the Best forecast card at the top of the Forecast tab (src/best.js): each source's
// temperatures are corrected for its recent warm/cold bias, each part (hourly temps, high, low,
// rain chance, wind) is weighted toward the sources that have been most accurate at it in that
// town, and "now" and the next few hours follow what the stations are reading.
// Flat keys ("v_now", "v_h1_t", ...) keep the widget formulas short: v_ = Vallejo, n_ = Napa.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { SOURCES, PRESETS, setRequestInit, setKeyProvider, dayKey, localHour, localHourStart, isNum, mean, mode, isRainyHour, icon, catLabel } from "../src/sources.js";
import { weightsBy, biasFor, bestHours, nudge } from "../src/best.js";
import { fetchObsNow } from "../src/stations.js";

const H = 3600e3;
const LOCS = [["v", PRESETS.vallejo], ["n", PRESETS.napa]];

function wmean(pairs, w) {
  const v = pairs.filter(([, x]) => isNum(x));
  if (!v.length) return null;
  if (!w) return mean(v.map(([, x]) => x));
  const ws = v.map(([id]) => w[id] ?? 0), tw = ws.reduce((a, b) => a + b, 0);
  return tw ? v.reduce((s, [, x], i) => s + x * ws[i], 0) / tw : mean(v.map(([, x]) => x));
}
const deg = v => isNum(v) ? Math.round(v) + "°" : "—";
const isNight = (t, tz) => { const h = localHour(t, tz); return h < 7 || h >= 18; };
const fmtHour = (t, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" }).format(t).replace(" ", "").toLowerCase();
const fmtTime = (t, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(t).replace(" ", "").toLowerCase();
const dayName = (k, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(localHourStart(k, 12, tz));

// One location's Best forecast from each source's data ({ id: {current, hourly, daily} }).
// bias: the scores.json bias table; obs: latest station reading ({ temp, at }) or null.
export function bestFor(results, days, loc, now, { bias = null, obs = null } = {}) {
  const tz = loc.tz, ids = Object.keys(results);
  const W = weightsBy(days, { locs: [loc.id], ids });
  const B = biasFor(bias, loc.id);
  const maps = Object.fromEntries(ids.map(id => [id, new Map(results[id].hourly.map(h => [h.t, h]))]));
  const h0 = Math.floor(now / H) * H;
  const raw = bestHours(maps, [-1, 0, 1, 2, 3, 4].map(k => h0 + k * H), { W, bias: B, tz, now });
  const nd = obs ? nudge(raw, obs) : { rows: raw };
  const rows = nd.rows.slice(1);
  const cur = obs ? obs.temp : wmean(ids.map(id => [id, results[id].current?.temp]), W(0, "temp")) ?? rows[0]?.temp;
  const curCat = rows[0]?.cat || mode(ids.map(id => results[id].current?.cat));
  const hours = rows.map((r, k) => ({ t: h0 + k * H, label: k === 0 ? "Now" : fmtHour(h0 + k * H, tz), temp: k === 0 ? cur : r?.temp ?? null, icon: icon(k === 0 ? curCat : r?.cat, isNight(h0 + k * H, tz)) }));
  const keys = [];
  for (let t = now; keys.length < 6; t += 6 * H) { const k = dayKey(t, tz); if (!keys.includes(k)) keys.push(k); }
  const daysOut = keys.map((k, i) => {
    const ds = ids.map(id => [id, results[id].daily?.[k]]).filter(([, x]) => x);
    const pop = wmean(ds.map(([id, x]) => [id, x.pop]), W(i, "rain"));
    const d0 = Math.max(localHourStart(k, 7, tz), i === 0 ? h0 : 0), d1 = localHourStart(k, 19, tz);
    const wind = wmean(ids.map(id => { const v = results[id].hourly.filter(h => h.t >= d0 && h.t < d1).map(h => h.wind).filter(isNum); return [id, v.length ? Math.max(...v) : null]; }), W(i, "wind"));
    const cat = isNum(pop) && pop >= 50 ? "rain" : mode(ds.map(([, x]) => x.cat));
    let hi = wmean(ds.map(([id, x]) => [id, isNum(x.hi) ? x.hi - B.hi(id, i) : null]), W(i, "high")), lo = wmean(ds.map(([id, x]) => [id, isNum(x.lo) ? x.lo - B.lo(id, i) : null]), W(i, "low"));
    if (i === 0 && obs) { if (isNum(hi)) hi = Math.max(hi, obs.temp); if (isNum(lo)) lo = Math.min(lo, obs.temp); }
    return { key: k, name: i === 0 ? "Today" : dayName(k, tz), hi, lo, pop, wind, icon: icon(cat, false) };
  });
  return { now: cur, cat: curCat, night: isNight(now, tz), hours, days: daysOut, sources: ids.length, weighted: !!W(0, "temp"), measured: !!obs, nudge: nd.delta ?? null };
}

export function flatten(p, b, loc, now) {
  const t = b.days[0], o = {};
  const name = loc.name.replace(/, [A-Z]{2}$/, "");
  o[`${p}_loc`] = name;
  o[`${p}_upd`] = "Updated " + fmtTime(now, loc.tz);
  o[`${p}_now`] = deg(b.now);
  o[`${p}_icon`] = icon(b.cat, b.night);
  o[`${p}_cond`] = catLabel(b.cat, b.night);
  o[`${p}_hilo`] = `${deg(t.hi)} · ${deg(t.lo)}`;
  o[`${p}_line`] = [isNum(t.pop) ? `💧 ${Math.round(t.pop)}%` : null, isNum(t.wind) ? `💨 ${Math.round(t.wind)} mph` : null].filter(Boolean).join("   ");
  b.hours.forEach((h, i) => { o[`${p}_h${i}_l`] = h.label; o[`${p}_h${i}_t`] = deg(h.temp); o[`${p}_h${i}_i`] = h.icon; });
  b.days.slice(1, 6).forEach((d, j) => {
    const i = j + 1;
    o[`${p}_d${i}_n`] = d.name; o[`${p}_d${i}_t`] = `${deg(d.hi)}  ${deg(d.lo)}`; o[`${p}_d${i}_i`] = d.icon;
    o[`${p}_d${i}_p`] = isNum(d.pop) && d.pop >= 20 ? `💧${Math.round(d.pop)}%` : "";
  });
  return o;
}

export async function run({ dataDir, now = Date.now(), log = console.log } = {}) {
  let days = null, bias = null;
  try { const sc = JSON.parse(await readFile(path.join(dataDir, "scores.json"), "utf8")); days = sc.days; bias = sc.bias || null; } catch {}
  const out = { updated: now, about: "Best forecast for the Weather Compare phone widget. v_ = Vallejo, n_ = Napa." };
  for (const [p, loc] of LOCS) {
    const results = {};
    await Promise.all(SOURCES.map(async s => {
      if (s.key && !process.env[s.key.env]) return;
      try { const d = await s.fetch(loc); if (d?.hourly?.length) results[s.id] = d; } catch (e) { log(`${loc.id}/${s.id}: ${e.message}`); }
    }));
    if (Object.keys(results).length < 2) { log(`${loc.id}: only ${Object.keys(results).length} sources; skipping`); continue; }
    const b = bestFor(results, days, loc, now, { bias, obs: await fetchObsNow(loc.id, { now }) });
    Object.assign(out, flatten(p, b, loc, now));
    out[`${p}_sources`] = b.sources;
    log(`${loc.id}: ${b.sources} sources${b.weighted ? " (accuracy-weighted)" : ""}${b.measured ? `, stations read now${b.nudge ? ` (nudge ${b.nudge > 0 ? "+" : ""}${b.nudge}°)` : ""}` : ""}: now ${out[`${p}_now`]} ${out[`${p}_cond`]}, ${out[`${p}_hilo`]}`);
  }
  if (!out.v_now && !out.n_now) throw new Error("no forecasts");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "widget.json"), JSON.stringify(out, null, 1) + "\n");
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  setKeyProvider(id => { const s = SOURCES.find(x => x.id === id); return s?.key ? process.env[s.key.env] : null; });
  setRequestInit({ headers: { "User-Agent": `weather-compare/1.0 (github.com/${process.env.GITHUB_REPOSITORY || "personal"})`, Accept: "application/geo+json, application/json" } });
  const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
  run({ dataDir }).catch(e => { console.error(e); process.exit(1); });
}
