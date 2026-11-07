// Service worker: makes the home-screen app open fast and keep working offline.
// Everything is "network first": when online you always get fresh code and weather; when the
// network is slow or gone, the last saved copy is used instead.
const SHELL = "wc-shell-v15";
const API = "wc-api-v1";
const SHELL_FILES = ["./", "index.html", "styles.css", "src/app.js", "src/sources.js", "src/accuracy.js", "src/skill.js", "src/radar.js", "src/common.js", "src/nfl.js", "src/nflwx.js", "src/stadiums.js", "src/stadiumskill.js", "src/stadiumsview.js", "src/config.js", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== API).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
async function networkFirst(req, cacheName, ms, cacheKey = req) {
  const cache = await caches.open(cacheName);
  try {
    // App files: always ask the server whether there's a newer version (GitHub Pages otherwise
    // lets browsers reuse files for 10 minutes, so an update could take that long to show up).
    const go = cacheName !== SHELL ? fetch(req)
      : req.mode === "navigate" ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      : fetch(req, { cache: "no-cache" });
    const res = await withTimeout(go, ms);
    if (res.ok) {
      cache.put(cacheKey, res.clone());
      if (cacheName === API) prune(cache);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey, { ignoreSearch: cacheName === SHELL });
    if (hit) return hit;
    throw err;
  }
}
async function prune(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - 80))) await cache.delete(k);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // Data files carry a cache-busting ?t=…; store them without it so the offline copy is found.
    const key = url.pathname.includes("/data/") ? new Request(url.origin + url.pathname) : req;
    e.respondWith(networkFirst(req, SHELL, url.pathname.includes("/data/") ? 6000 : 3500, key));
  } else if (/mesonet\.agron|cartocdn|tile\.openstreetmap/.test(url.hostname)) {
    return;   // map and radar tiles: leave to the browser so they don't crowd out saved weather data
  } else if (url.protocol === "https:") {
    e.respondWith(networkFirst(req, API, 9000));
  }
});
