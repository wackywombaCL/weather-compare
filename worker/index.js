// Weather Compare key proxy (Cloudflare Worker).
//
// The app calls  https://<worker>/v1/<source>?lat=..&lon=..  with an X-Access-Code header.
// The Worker adds the matching API key (stored as a Worker secret, never sent to phones), asks
// the weather service, and keeps each answer for 10 minutes so everyone shares one request.
//
// Secrets: ACCESS_CODE, PIRATE_KEY, TOMORROW_KEY, WEATHERAPI_KEY, VISUALCROSSING_KEY, OWM_KEY
const ORIGINS = ["https://wackywombacl.github.io", "http://localhost:8765", "http://localhost:8000"];
const CACHE_SECONDS = 600;
const memo = new Map();   // per-instance cache (backs up the Cache API)

const ROUTES = {
  pirate: (q, env) => [env.PIRATE_KEY, `https://api.pirateweather.net/forecast/${encodeURIComponent(env.PIRATE_KEY)}/${q.lat},${q.lon}?units=us&extend=hourly&exclude=minutely,alerts`],
  tomorrow: (q, env) => [env.TOMORROW_KEY, `https://api.tomorrow.io/v4/weather/forecast?location=${q.lat},${q.lon}&units=imperial&timesteps=1h,1d&apikey=${encodeURIComponent(env.TOMORROW_KEY)}`],
  weatherapi: (q, env) => [env.WEATHERAPI_KEY, `https://api.weatherapi.com/v1/forecast.json?key=${encodeURIComponent(env.WEATHERAPI_KEY)}&q=${q.lat},${q.lon}&days=5&aqi=no&alerts=no`],
  visualcrossing: (q, env) => [env.VISUALCROSSING_KEY, q.from && q.to && `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${q.lat},${q.lon}/${q.from}/${q.to}?unitGroup=us&include=days,hours,current&contentType=json&key=${encodeURIComponent(env.VISUALCROSSING_KEY)}`],
  "owm/weather": (q, env) => [env.OWM_KEY, `https://api.openweathermap.org/data/2.5/weather?lat=${q.lat}&lon=${q.lon}&units=imperial&appid=${encodeURIComponent(env.OWM_KEY)}`],
  "owm/forecast": (q, env) => [env.OWM_KEY, `https://api.openweathermap.org/data/2.5/forecast?lat=${q.lat}&lon=${q.lon}&units=imperial&appid=${encodeURIComponent(env.OWM_KEY)}`],
};

function cors(req) {
  const o = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "X-Access-Code",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (req, status, body, extra = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...cors(req), ...extra },
});
// Constant-time-ish compare so the code can't be guessed by timing.
function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== "GET") return json(req, 405, { error: "GET only" });
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") return json(req, 200, { ok: true, sources: Object.keys(ROUTES).filter(k => ROUTES[k]({ lat: 0, lon: 0, from: "x", to: "x" }, env)[0]) });
    if (!same(req.headers.get("X-Access-Code") || url.searchParams.get("code") || "", env.ACCESS_CODE || "")) return json(req, 401, { error: "Missing or wrong access code" });

    const route = url.pathname.replace(/^\/v1\//, "");
    const make = ROUTES[route];
    if (!make) return json(req, 404, { error: "Unknown source" });
    // Round to ~1 km so nearby requests share a cache entry (and nobody can fan out endless variants).
    const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json(req, 400, { error: "Bad lat/lon" });
    const q = { lat: lat.toFixed(2), lon: lon.toFixed(2) };
    for (const k of ["from", "to"]) { const v = url.searchParams.get(k); if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) q[k] = v; }
    const [key, upstream] = make(q, env);
    if (!key) return json(req, 501, { error: `No key saved for ${route}` });
    if (!upstream) return json(req, 400, { error: "Missing parameters" });

    const cacheKey = `https://cache.weather-compare/${route}?${new URLSearchParams(q)}`;
    const hit = memo.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_SECONDS * 1000) return json(req, 200, hit.body, { "X-Cache": "memory" });
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache) {
      const c = await cache.match(cacheKey).catch(() => null);
      if (c) { const body = await c.text(); memo.set(cacheKey, { at: Date.now(), body }); return json(req, 200, body, { "X-Cache": "edge" }); }
    }
    const r = await fetch(upstream, { headers: { "User-Agent": "weather-compare-proxy/1.0", Accept: "application/json" } });
    const body = await r.text();
    if (!r.ok) return json(req, r.status, { error: `Upstream HTTP ${r.status}` });
    memo.set(cacheKey, { at: Date.now(), body });
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` } })).catch(() => {}));
    return json(req, 200, body, { "X-Cache": "miss" });
  },
};
