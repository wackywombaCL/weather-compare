#!/usr/bin/env python3
"""Lightning and storm-warning alerts for Vallejo and Napa.

Runs every 5 minutes in GitHub Actions (.github/workflows/lightning.yml):
  1. Lightning: reads the latest GOES-West Geostationary Lightning Mapper (GLM) files from
     NOAA's public bucket (new file every 20 s, ~30 s behind real time) and finds flashes near
     the two cities. A phone alert goes out when lightning is within 20 miles, again if it gets
     much closer, and an "all clear" once there's been none within 20 miles for 45 minutes.
  2. NWS alerts: any active National Weather Service alert (thunderstorm, flood, wind, red
     flag...) for either city, sent once per alert.
Recent flashes (within ~120 mi, last hour) and active alerts are kept in data/lightning.json
for the app's Radar tab.

Phone alerts need the NTFY_TOPIC secret. Without it the script just prints what it would send.
Test anywhere with: LIGHTNING_TEST_LOC="lat,lon" DRY_RUN=1 python scripts/lightning.py
"""
import json, math, os, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

import netCDF4  # pip install netCDF4

LOCS = {"vallejo": ("Vallejo", 38.1041, -122.2566), "napa": ("Napa", 38.2975, -122.2869)}
if os.environ.get("LIGHTNING_TEST_LOC"):
    la, lo = map(float, os.environ["LIGHTNING_TEST_LOC"].split(","))
    LOCS = {"test": ("Test spot", la, lo)}
CENTER = (sum(v[1] for v in LOCS.values()) / len(LOCS), sum(v[2] for v in LOCS.values()) / len(LOCS))
ALERT_MI = 20          # alert when lightning is this close
MAP_MI = 120           # keep flashes this close for the radar map
KEEP_MIN = 60          # ...for this long
WINDOW_MIN = 10        # "recent" lightning for alerts
REPEAT_MIN = 30        # repeat an alert at most this often...
CLOSER_MI = 5          # ...unless the nearest strike is this much closer than last time
CLEAR_MIN = 45         # all-clear after this long with nothing within ALERT_MI
BUCKETS = ["noaa-goes18"]   # GOES-West (covers the Pacific coast)
UA = "weather-compare/1.0 (github.com/%s)" % os.environ.get("GITHUB_REPOSITORY", "personal")
STATE_FILE = os.path.abspath(os.environ.get("LIGHTNING_STATE") or "") if os.environ.get("LIGHTNING_STATE") else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "lightning.json")
DRY = bool(os.environ.get("DRY_RUN"))
SITE = "https://wackywombacl.github.io/weather-compare/#radar"


def http(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def miles(a, b):
    R = 3958.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def bearing(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    deg = (math.degrees(math.atan2(x, y)) + 360) % 360
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][round(deg / 22.5) % 16]


def notify(title, body, tags, priority="default"):
    topic = os.environ.get("NTFY_TOPIC")
    print(f"NOTIFY [{title}] {body}")
    if DRY or not topic:
        return
    try:
        http("https://ntfy.sh/" + urllib.parse.quote(topic), data=body.encode(),
             headers={"Title": title, "Tags": tags, "Priority": priority, "Click": SITE})
    except Exception as e:  # never fail the run over a notification
        print("  notification failed:", e)


# ---------- GLM files ----------
def file_start(key):
    m = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)", key)
    y, doy, H, M, S, tenth = map(int, m.groups())
    return datetime(y, 1, 1, H, M, S, tenth * 100000, tzinfo=timezone.utc) + timedelta(days=doy - 1)


def list_files(bucket, since):
    keys = []
    now = datetime.now(timezone.utc)
    hours = {(now - timedelta(hours=h)).strftime("%Y/%j/%H") for h in (0, 1)} | {since.strftime("%Y/%j/%H")}
    for hp in sorted(hours):
        url = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix=GLM-L2-LCFA/{hp}/"
        root = ET.fromstring(http(url))
        ns = {"s3": root.tag.split("}")[0].strip("{")}
        keys += [k.text for k in root.findall(".//s3:Key", ns)]
    return sorted(k for k in keys if file_start(k) > since)


def download(bucket, key):
    return http(f"https://{bucket}.s3.amazonaws.com/{key}", timeout=60)


def read_flashes(key, raw):
    # netCDF/HDF5 isn't thread-safe: files are downloaded in parallel but read one at a time.
    ds = netCDF4.Dataset("glm", memory=raw)
    try:
        lat = ds.variables["flash_lat"][:]
        lon = ds.variables["flash_lon"][:]
    finally:
        ds.close()
    t = int(file_start(key).timestamp() * 1000)
    out = []
    for la, lo in zip(lat.tolist(), lon.tolist()):
        if la is None or lo is None:
            continue
        if abs(la - CENTER[0]) < 2.5 and abs(lo - CENTER[1]) < 3 and miles(CENTER, (la, lo)) <= MAP_MI:
            out.append([t, round(la, 4), round(lo, 4)])
    return out, len(lat)


def main():
    try:
        state = json.load(open(STATE_FILE))
    except Exception:
        state = {}
    before = json.dumps(state, sort_keys=True)
    now = datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    state.setdefault("flashes", [])
    state.setdefault("alerts", {})
    state.setdefault("nwsSeen", {})

    # 1. Lightning
    since = datetime.fromtimestamp(state.get("lastFile", 0) / 1000, timezone.utc) if state.get("lastFile") else now - timedelta(minutes=20)
    since = max(since, now - timedelta(minutes=20))   # GitHub can run late: always cover the last 20 min
    total = 0
    for bucket in BUCKETS:
        try:
            keys = list_files(bucket, since)
        except Exception as e:
            print("GLM listing failed:", e)
            continue
        with ThreadPoolExecutor(8) as ex:
            raws = list(ex.map(lambda k: download(bucket, k), keys))
        results = [(k, read_flashes(k, raw)) for k, raw in zip(keys, raws)]
        for k, (near, n) in results:
            state["flashes"] += near
            total += n
        if keys:
            state["lastFile"] = int(file_start(keys[-1]).timestamp() * 1000)
        print(f"GLM: {len(keys)} new files, {total} flashes worldwide view, {sum(len(r[1][0]) for r in results)} within {MAP_MI} mi")
        break
    state["flashes"] = sorted({tuple(f) for f in state["flashes"] if now_ms - f[0] <= KEEP_MIN * 60e3})
    state["flashes"] = [list(f) for f in state["flashes"]]

    lines, clears = [], []
    for lid, (name, la, lo) in LOCS.items():
        recent = [f for f in state["flashes"] if now_ms - f[0] <= WINDOW_MIN * 60e3 and miles((la, lo), (f[1], f[2])) <= ALERT_MI]
        st = state["alerts"].setdefault(lid, {})
        if recent:
            nearest = min(recent, key=lambda f: miles((la, lo), (f[1], f[2])))
            d = miles((la, lo), (nearest[1], nearest[2]))
            st["lastSeen"] = now_ms
            st.pop("cleared", None)
            since_alert = (now_ms - st.get("lastAlert", 0)) / 60e3
            if since_alert >= REPEAT_MIN or (since_alert >= 10 and d <= st.get("lastNear", 999) - CLOSER_MI):
                lines.append(f"{name}: {len(recent)} flash{'es' if len(recent) != 1 else ''} in the last {WINDOW_MIN} min, nearest {d:.0f} mi {bearing((la, lo), (nearest[1], nearest[2]))}")
                st["lastAlert"], st["lastNear"] = now_ms, round(d, 1)
        elif st.get("lastAlert") and not st.get("cleared") and now_ms - st.get("lastSeen", 0) >= CLEAR_MIN * 60e3:
            clears.append(name)
            st["cleared"] = now_ms
            st.pop("lastNear", None)
    if lines:
        notify("⚡ Lightning nearby", "\n".join(lines), "zap", "high")
    if clears:
        notify("Lightning has moved away", f"No lightning within {ALERT_MI} mi of {' or '.join(clears)} for {CLEAR_MIN} min.", "white_check_mark")

    # 2. NWS alerts
    active = {}
    for lid, (name, la, lo) in LOCS.items():
        try:
            j = json.loads(http(f"https://api.weather.gov/alerts/active?point={la:.4f},{lo:.4f}", headers={"Accept": "application/geo+json"}))
        except Exception as e:
            print("NWS alerts failed for", name, e)
            continue
        for f in j.get("features", []):
            p = f.get("properties", {})
            aid = p.get("id") or f.get("id")
            a = active.setdefault(aid, {"id": aid, "event": p.get("event"), "headline": p.get("headline"), "severity": p.get("severity"),
                                        "ends": p.get("ends") or p.get("expires"), "places": []})
            a["places"].append(name)
    new = [a for aid, a in active.items() if aid not in state["nwsSeen"]]
    for a in new:
        state["nwsSeen"][a["id"]] = now_ms
        warn = "Warning" in (a["event"] or "")
        notify(f"⚠️ {a['event']}", f"{a['headline'] or a['event']} ({' & '.join(a['places'])})", "warning", "high" if warn else "default")
    state["nwsSeen"] = {k: v for k, v in state["nwsSeen"].items() if k in active or now_ms - v < 3 * 24 * 3600e3}
    state["nwsActive"] = sorted(active.values(), key=lambda a: a["id"])

    # Save only when something changed (keeps commits to stormy days)
    after = json.dumps({k: v for k, v in state.items() if k not in ("lastFile", "updated")}, sort_keys=True)
    if after != json.dumps({k: v for k, v in json.loads(before or "{}").items() if k not in ("lastFile", "updated")}, sort_keys=True) or not os.path.exists(STATE_FILE):
        state["updated"] = now_ms
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as fh:
            json.dump(state, fh, separators=(",", ":"))
            fh.write("\n")
        print("state saved")
    else:
        print("no change")


if __name__ == "__main__":
    main()
