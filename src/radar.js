// Radar tab: NEXRAD radar (last 50 minutes, animated), lightning from the GOES-West satellite,
// 20-mile rings around Vallejo and Napa, and any active National Weather Service alerts.
// Leaflet is loaded only when the tab is first opened.
import { PRESETS } from "./sources.js";
import { $, esc, fmtTime } from "./app.js";

const TZ = "America/Los_Angeles";
// Read straight from GitHub so lightning updates show up without waiting for a site redeploy.
const LIGHTNING_URL = "https://raw.githubusercontent.com/wackywombaCL/weather-compare/main/data/lightning.json";
const RING_MI = 20;
const OFFSETS = [50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];   // minutes ago
let map, frames = {}, idx = OFFSETS.length - 1, timer = null, lightLayer, refreshTimer, leafletP;

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return leafletP ||= new Promise((res, rej) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "vendor/leaflet/leaflet.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "vendor/leaflet/leaflet.js";
    js.onload = res; js.onerror = () => rej(new Error("Map library didn't load"));
    document.head.appendChild(js);
  });
}
const dark = () => document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
const slot = () => Math.floor(Date.now() / 300000);   // radar tiles refresh every 5 minutes
function frameLayer(off) {
  const name = "nexrad-n0q-900913" + (off ? `-m${String(off).padStart(2, "0")}m` : "");
  return L.tileLayer(`https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${name}/{z}/{x}/{y}.png?_=${slot()}`, {
    opacity: 0, zIndex: 5, maxNativeZoom: 12, attribution: 'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a> (NEXRAD)',
  });
}
function showFrame(i) {
  idx = i;
  const off = OFFSETS[i];
  if (!frames[off]) frames[off] = frameLayer(off).addTo(map);
  for (const [o, layer] of Object.entries(frames)) layer.setOpacity(+o === off ? 0.72 : 0);
  $("radarTime").textContent = off === 0 ? "Radar: latest (about 5 min old)" : `Radar: ${off} min earlier`;
}
function stop() { clearInterval(timer); timer = null; $("radarPlay").textContent = "▶ Play last 50 min"; showFrame(OFFSETS.length - 1); }
function play() {
  if (timer) return stop();
  $("radarPlay").textContent = "⏸ Stop";
  let i = 0;
  showFrame(0);
  timer = setInterval(() => { i = (i + 1) % (OFFSETS.length + 2); showFrame(Math.min(i, OFFSETS.length - 1)); }, 700);
}

function init() {
  const center = [38.2, -122.27];
  map = L.map("radarMap", { zoomSnap: 0.5, minZoom: 5, maxZoom: 12 }).setView(center, 8.5);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark() ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`, {
    subdomains: "abcd", maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  for (const loc of [PRESETS.vallejo, PRESETS.napa]) {
    L.circle([loc.lat, loc.lon], { radius: RING_MI * 1609.34, color: dark() ? "#f0efec" : "#0b0b0b", weight: 1.5, dashArray: "5 5", fill: false, interactive: false }).addTo(map);
    L.circleMarker([loc.lat, loc.lon], { radius: 4, color: "#fff", weight: 2, fillColor: "#2a78d6", fillOpacity: 1 }).bindTooltip(loc.name.replace(", CA", ""), { permanent: true, direction: "right", className: "radar-label" }).addTo(map);
  }
  lightLayer = L.layerGroup().addTo(map);
  showFrame(OFFSETS.length - 1);
  $("radarPlay").addEventListener("click", play);
}

const miles = (a, b) => { const R = 3958.8, r = x => x * Math.PI / 180; const dl = r(b[0] - a[0]), dn = r(b[1] - a[1]); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const bearing = (a, b) => { const r = x => x * Math.PI / 180, d = x => x * 180 / Math.PI; const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0])); const x = Math.cos(r(a[0])) * Math.sin(r(b[0])) - Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1])); return COMPASS[Math.round(((d(Math.atan2(y, x)) + 360) % 360) / 22.5) % 16]; };

async function refreshLightning() {
  let data = null;
  try { const r = await fetch(LIGHTNING_URL + "?t=" + Math.floor(Date.now() / 60000), { cache: "no-store" }); if (r.ok) data = await r.json(); } catch {}
  lightLayer.clearLayers();
  const now = Date.now();
  const fl = (data?.flashes || []).filter(f => now - f[0] <= 60 * 60e3);
  for (const [t, la, lo] of fl) {
    const age = (now - t) / 60e3;
    L.circleMarker([la, lo], { radius: age < 10 ? 5 : 3.5, weight: 1, color: "#3d2a00", fillColor: age < 10 ? "#ffd21f" : age < 30 ? "#ec835a" : "#9a9890", fillOpacity: age < 10 ? 1 : 0.8, interactive: false }).addTo(lightLayer);
  }
  // Summary line
  const lines = [];
  for (const loc of [PRESETS.vallejo, PRESETS.napa]) {
    const near = fl.filter(f => now - f[0] <= 10 * 60e3).map(f => ({ f, d: miles([loc.lat, loc.lon], [f[1], f[2]]) })).filter(x => x.d <= RING_MI).sort((a, b) => a.d - b.d);
    if (near.length) lines.push(`⚡ <b>${esc(loc.name.replace(", CA", ""))}</b>: ${near.length} flash${near.length > 1 ? "es" : ""} within ${RING_MI} mi in the last 10 min, nearest ${near[0].d.toFixed(0)} mi ${bearing([loc.lat, loc.lon], [near[0].f[1], near[0].f[2]])}`);
  }
  $("radarLightning").innerHTML = !data ? "Lightning data isn't available yet." :
    lines.length ? lines.join("<br>") :
    fl.length ? `⚡ ${fl.length} flash${fl.length > 1 ? "es" : ""} within 120 mi in the past hour, none within ${RING_MI} mi of Vallejo or Napa in the last 10 min.` :
    `No lightning within 120 miles in the past hour.`;
  const alerts = data?.nwsActive || [];
  $("radarAlerts").innerHTML = alerts.map(a => `<div class="nwsalert ${/Warning/.test(a.event || "") ? "warn" : ""}"><b>⚠️ ${esc(a.event)}</b> · ${esc(a.places.join(" & "))}<div>${esc(a.headline || "")}</div></div>`).join("");
}

export async function showRadar() {
  try { await loadLeaflet(); } catch (e) { $("radarMap").innerHTML = `<p class="empty" style="padding:16px">${esc(e.message)}</p>`; return; }
  if (!map) init();
  setTimeout(() => map.invalidateSize(), 50);
  refreshLightning();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if ($("viewRadar").hidden || document.visibilityState !== "visible") return;
    for (const l of Object.values(frames)) l.setUrl(l._url.replace(/_=\d+/, "_=" + slot()));
    refreshLightning();
  }, 2 * 60e3);
}
export function hideRadar() { if (timer) stop(); }
