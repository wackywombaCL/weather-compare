# Weather Compare

Side-by-side forecasts from several weather providers, a blended "average of everyone", and a
running accuracy scoreboard.

**No key needed:** National Weather Service, Open-Meteo, MET Norway (Yr), and the ECMWF, GFS,
ICON and GEM forecast models (via Open-Meteo).
**Free API key needed:** Pirate Weather, Tomorrow.io, WeatherAPI.com, Visual Crossing, OpenWeatherMap.

Keys go in two places, never in the code: GitHub secrets (`PIRATE_KEY`, `TOMORROW_KEY`,
`WEATHERAPI_KEY`, `VISUALCROSSING_KEY`, `OWM_KEY`) for the daily job, and the app's ⚙️ Settings
on each device. The "Check sources" workflow prints what every source returns.

## How accuracy tracking works

`.github/workflows/daily.yml` runs `scripts/daily.mjs` every morning:

1. **6am Pacific:** saves each source's hourly forecast for today, tomorrow and the day after
   (each 6am → 6am) for Vallejo and Napa to `data/forecasts/YYYY-MM-DD.json`, plus a plain average
   and an accuracy-weighted "smart" average of all sources.
2. **Next morning:** pulls that window's NWS station observations and scores each source
   (high/low miss, hourly miss, rain hit/miss/false alarm, rain start timing, Brier score),
   appending to `data/scores.json`.
3. Writes `data/status.json` (shown in the app), sends phone notifications through ntfy if
   `NTFY_TOPIC` is set (problems, and rainy days), commits the data and redeploys the site.

The Accuracy tab in the app reads those files.

## Setup (one time)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Actions → General → Workflow permissions: Read and write permissions.**
3. Actions tab → **Deploy site** → Run workflow (first deploy), and **Daily forecast log** →
   Run workflow with "force" ticked to set today's forecast right away.

## Run locally

ES modules don't load from `file://`, so serve the folder:

```
python3 -m http.server 8000
```

then open http://localhost:8000.
