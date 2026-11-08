// Phone widget feed: the Best forecast for Vallejo and Napa, written to data/widget.json every
// 30 minutes (widget.yml) for the KWGT home-screen widget (widget/*.kwgt) to read.
// Same math as the Best forecast card at the top of the Forecast tab: each part (current and
// hourly temps, high, low, rain chance, wind) is weighted toward the sources that have been most
// accurate at that part over the last 14 scored days (Vallejo + Napa together).
// Flat keys ("v_now", "v_h1_t", ...) keep the widget formulas short: v_ = Vallejo, n_ = Napa.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { SOURCES, PRESETS, setRequestInit, setKeyProvider, dayKey, localHour, localHourStart, isNum, mean, mode, isRainyHour, icon, catLabel } from "../src/sources.js";
import { elementSkill, elementWeights } from "../src/skill.js";

const H = 3600e3;
const LOCS = [["v", PRESETS.vallejo], ["n", PRESETS.napa]];
const TRACKED = ["vallejo", "napa"];

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
export function bestFor(results, days, loc, now) {
  const tz = loc.tz, ids = Object.keys(results);
  const sk = [0, 1, 2].map(L => days ? elementSkill(days, { locs: TRACKED, lead: L, n: 14 }).skill : null);
  const W = (i, e) => sk[0] ? (elementWeights(sk[Math.min(i, 2)], e, ids) || elementWeights(sk[0], e, ids)) : null;
  const hourCat = (t, i) => {
    const hs = ids.map(id => [id, results[id].hourly.find(h => h.t === t)]).filter(([, h]) => h);
    if (!hs.length) return null;
    const wet = wmean(hs.map(([id, h]) => [id, isRainyHour(h) ? 1 : 0]), W(i, "timing") || W(i, "rain"));
    return wet >= 0.5 ? "rain" : mode(hs.map(([, h]) => h.cat));
  };
  const h0 = Math.floor(now / H) * H;
  const cur = wmean(ids.map(id => [id, results[id].current?.temp]), W(0, "temp"));
  const curCat = hourCat(h0, 0) || mode(ids.map(id => results[id].current?.cat));
  const hours = [0, 1, 2, 3, 4].map(k => {
    const t = h0 + k * H;
    const temp = k === 0 && isNum(cur) ? cur : wmean(ids.map(id => [id, results[id].hourly.find(h => h.t === t)?.temp]), W(0, "temp"));
    const cat = k === 0 ? curCat : hourCat(t, 0);
    return { t, label: k === 0 ? "Now" : fmtHour(t, tz), temp, icon: icon(cat, isNight(t, tz)) };
  });
  const keys = [];
  for (let t = now; keys.length < 6; t += 6 * H) { const k = dayKey(t, tz); if (!keys.includes(k)) keys.push(k); }
  const daysOut = keys.map((k, i) => {
    const ds = ids.map(id => [id, results[id].daily?.[k]]).filter(([, x]) => x);
    const pop = wmean(ds.map(([id, x]) => [id, x.pop]), W(i, "rain"));
    const d0 = Math.max(localHourStart(k, 7, tz), i === 0 ? h0 : 0), d1 = localHourStart(k, 19, tz);
    const wind = wmean(ids.map(id => { const v = results[id].hourly.filter(h => h.t >= d0 && h.t < d1).map(h => h.wind).filter(isNum); return [id, v.length ? Math.max(...v) : null]; }), W(i, "wind"));
    const cat = isNum(pop) && pop >= 50 ? "rain" : mode(ds.map(([, x]) => x.cat));
    return { key: k, name: i === 0 ? "Today" : dayName(k, tz), hi: wmean(ds.map(([id, x]) => [id, x.hi]), W(i, "high")), lo: wmean(ds.map(([id, x]) => [id, x.lo]), W(i, "low")), pop, wind, icon: icon(cat, false) };
  });
  return { now: cur, cat: curCat, night: isNight(now, tz), hours, days: daysOut, sources: ids.length, weighted: !!sk[0] && !!W(0, "temp") };
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
  let days = null;
  try { days = JSON.parse(await readFile(path.join(dataDir, "scores.json"), "utf8")).days; } catch {}
  const out = { updated: now, about: "Best forecast for the Weather Compare phone widget. v_ = Vallejo, n_ = Napa." };
  for (const [p, loc] of LOCS) {
    const results = {};
    await Promise.all(SOURCES.map(async s => {
      if (s.key && !process.env[s.key.env]) return;
      try { const d = await s.fetch(loc); if (d?.hourly?.length) results[s.id] = d; } catch (e) { log(`${loc.id}/${s.id}: ${e.message}`); }
    }));
    if (Object.keys(results).length < 2) { log(`${loc.id}: only ${Object.keys(results).length} sources; skipping`); continue; }
    const b = bestFor(results, days, loc, now);
    Object.assign(out, flatten(p, b, loc, now));
    out[`${p}_sources`] = b.sources;
    log(`${loc.id}: ${b.sources} sources${b.weighted ? " (accuracy-weighted)" : ""}: now ${out[`${p}_now`]} ${out[`${p}_cond`]}, ${out[`${p}_hilo`]}`);
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
