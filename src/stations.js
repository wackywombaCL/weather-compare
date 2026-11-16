// Observation stations used to check forecasts and to read "right now" for the Best forecast.
// Vallejo has no official station, so it uses three nearby bay-side personal stations (CWOP,
// through the National Weather Service feed); Napa uses Napa County Airport.
import { getJSON, isNum, cToF } from "./sources.js";

export const LOCAL_STATIONS = {
  vallejo: [
    { id: "C0879", name: "Hercules", lat: 38.029, lon: -122.276 },
    { id: "G7397", name: "Benicia", lat: 38.081, lon: -122.148 },
    { id: "C6944", name: "Cordelia", lat: 38.172, lon: -122.129 },
  ],
};
export const NOW_STATIONS = {
  vallejo: LOCAL_STATIONS.vallejo,
  napa: [{ id: "KAPC", name: "Napa County Airport", lat: 38.213, lon: -122.28 }],
};

// Mean of the values after dropping any more than `tol` from the median (one bad sensor can't skew it).
export function robustMean(vals, tol) {
  const v = vals.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const keep = v.filter(x => Math.abs(x - med) <= tol);
  const use = keep.length ? keep : v;
  return Math.round(use.reduce((a, b) => a + b, 0) / use.length * 10) / 10;
}

// The latest temperature at a tracked town's stations: { temp (°F), at (ms), n, names } or null
// when nothing recent enough is available. Never throws.
export async function fetchObsNow(locId, { signal, now = Date.now(), maxAgeMin = 75 } = {}) {
  const sts = NOW_STATIONS[locId];
  if (!sts) return null;
  const got = (await Promise.all(sts.map(async st => {
    try {
      const p = (await getJSON(`https://api.weather.gov/stations/${st.id}/observations/latest`, { signal, tries: 1 })).properties;
      const at = Date.parse(p?.timestamp), c = p?.temperature?.value;
      if (!isNum(c) || !isNum(at) || p.temperature.qualityControl === "X" || now - at > maxAgeMin * 60e3 || at - now > 10 * 60e3) return null;
      return { st, at, temp: cToF(c) };
    } catch { return null; }
  }))).filter(Boolean);
  if (!got.length) return null;
  const temp = robustMean(got.map(g => g.temp), 4);
  const used = got.filter(g => Math.abs(g.temp - temp) <= 6);
  return { temp, at: Math.round(used.reduce((s, g) => s + g.at, 0) / used.length), n: used.length, names: used.map(g => g.st.name) };
}
