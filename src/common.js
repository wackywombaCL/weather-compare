// Small helpers shared by the main app and the standalone NFL page (nfl/index.html).
import { isNum } from "./sources.js";

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const metric = () => store.get("wc.units", "F") === "C";
export const T = f => !isNum(f) ? "—" : Math.round(metric() ? (f - 32) * 5 / 9 : f) + "°";
// Rain amounts: inches (°F mode) or millimeters (°C mode).
export const R = (inch, unit = true) => !isNum(inch) ? "—" : !metric()
  ? (inch < 0.005 ? "0" : unit ? inch.toFixed(inch < 10 ? 2 : 1) + " in" : inch.toFixed(2).replace(/^0\./, "."))
  : (inch * 25.4 < 0.5 ? "0" : (inch * 25.4).toFixed(inch * 25.4 < 10 ? 1 : 0)) + (unit ? " mm" : "");
