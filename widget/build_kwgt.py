#!/usr/bin/env python3
"""Builds the KWGT home-screen widgets (widget/*.kwgt) and SVG previews.

Each widget reads the Best forecast from data/widget.json (refreshed every 30 minutes by
.github/workflows/widget.yml) with KWGT's $wg(url, json, path)$ download function.
Layout follows the Google weather widget: location + updated time, condition, high/low, big
current temperature, next 5 hours, next 5 days.

Format notes (from working generators): a .kwgt is a zip with preset.json; every module is
TOPLEFT-anchored and placed with left/top padding; KWGT scales the preset to the widget cell
from preset_info width/height (about 2 px per layout unit).

    python3 widget/build_kwgt.py
"""
import json
import pathlib
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
URL = "https://raw.githubusercontent.com/wackywombaCL/weather-compare/main/data/widget.json"
W, H = 728, 764
PAD = 32
WHITE, DIM, FAINT = "#FFFFFFFF", "#FFBDBDBD", "#FF8F8F8F"
CARD, PANEL = "#F02B2B2E", "#FF121212"

SAMPLE = {
    "loc": "Vallejo", "upd": "Updated 8:44am", "now": "56°", "icon": "☁️", "cond": "Cloudy",
    "hilo": "70° · 52°", "line": "💧 0%   💨 3 mph",
    **{f"h{i}_l": l for i, l in enumerate(["Now", "9am", "10am", "11am", "12pm"])},
    **{f"h{i}_t": t for i, t in enumerate(["56°", "57°", "60°", "63°", "65°"])},
    **{f"h{i}_i": e for i, e in enumerate(["☁️", "☁️", "☁️", "⛅", "⛅"])},
    **{f"d{i}_n": d for i, d in enumerate(["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) if i},
    **{f"d{i}_t": t for i, t in enumerate(["", "71°  53°", "73°  53°", "75°  51°", "74°  49°", "70°  50°"]) if i},
    **{f"d{i}_i": e for i, e in enumerate(["", "☁️", "⛅", "☁️", "☁️", "🌧️"]) if i},
    **{f"d{i}_p": p for i, p in enumerate(["", "", "", "", "💧20%", "💧60%"]) if i},
}


def wg(prefix, key):
    return f'$wg("{URL}", json, ".{prefix}_{key}")$'


def base(kind, x, y, title):
    return {"internal_type": kind, "internal_title": title, "position_anchor": "TOPLEFT",
            "position_padding_left": float(x), "position_padding_top": float(y)}


def rect(x, y, w, h, color, r, title):
    m = base("ShapeModule", x, y, title)
    m.update(shape_type="RECT", shape_width=float(w), shape_height=float(h), paint_color=color, shape_corners=float(r))
    return m


def text(x, y, expr, size, sample, color=WHITE, bold=False, align="LEFT", width=None, title="Text"):
    m = base("TextModule", x, y, title)
    m.update(text_expression=f"[b]{expr}[/b]" if bold else expr, text_size=float(size), paint_color=color)
    if width:
        m.update(text_size_type="FIXED_WIDTH", text_width=float(width), text_lines=1.0)
    if align != "LEFT":
        m["text_align"] = align
    m["_s"] = {"text": sample, "bold": bold, "align": align, "width": width}
    return m


def widget(prefix, title):
    S = {k: v for k, v in SAMPLE.items()}
    if prefix == "n":
        S["loc"] = "Napa"
    v = lambda k: wg(prefix, k)
    items = [
        rect(0, 0, W, H, CARD, 46, "Card"),
        text(PAD, 26, v("loc"), 26, S["loc"], DIM, bold=True, title="Location"),
        text(W / 2, 30, v("upd"), 20, S["upd"], FAINT, align="RIGHT", width=W / 2 - PAD, title="Updated"),
        text(PAD, 76, f'{v("icon")} {v("cond")}', 40, f'{S["icon"]} {S["cond"]}', WHITE, width=W / 2 + 40, title="Condition"),
        text(PAD, 136, v("line"), 26, S["line"], DIM, title="Rain and wind"),
        text(PAD, 176, v("hilo"), 32, S["hilo"], WHITE, title="High and low"),
        text(W / 2, 52, v("now"), 120, S["now"], WHITE, align="RIGHT", width=W / 2 - PAD, title="Now"),
        rect(24, 240, W - 48, 172, PANEL, 36, "Hours panel"),
    ]
    colw = (W - 48) / 5
    for i in range(5):
        x = 24 + i * colw
        items += [
            text(x, 256, v(f"h{i}_t"), 26, S[f"h{i}_t"], WHITE, align="CENTER", width=colw, title=f"Hour {i} temp"),
            text(x, 296, v(f"h{i}_i"), 36, S[f"h{i}_i"], WHITE, align="CENTER", width=colw, title=f"Hour {i} icon"),
            text(x, 356, v(f"h{i}_l"), 24, S[f"h{i}_l"], WHITE, align="CENTER", width=colw, title=f"Hour {i} time"),
        ]
    y0, step = 424, 66
    for i in range(1, 6):
        y = y0 + (i - 1) * step
        items += [
            rect(24, y, W - 48, 60, PANEL, 18, f"Day {i} row"),
            text(56, y + 13, v(f"d{i}_n"), 28, S[f"d{i}_n"], WHITE, title=f"Day {i} name"),
            text(300, y + 17, v(f"d{i}_p"), 22, S[f"d{i}_p"], DIM, align="RIGHT", width=110, title=f"Day {i} rain"),
            text(420, y + 13, v(f"d{i}_t"), 28, S[f"d{i}_t"], WHITE, align="RIGHT", width=180, title=f"Day {i} temps"),
            text(620, y + 8, v(f"d{i}_i"), 34, S[f"d{i}_i"], WHITE, align="CENTER", width=70, title=f"Day {i} icon"),
        ]
    panel = {"internal_type": "OverlapLayerModule", "internal_title": "Widget", "position_anchor": "CENTER", "viewgroup_items": items}
    root = {"internal_type": "RootLayerModule", "config_scale_value": 100.0, "viewgroup_items": [panel]}
    info = {"version": 11, "title": title, "description": "Best forecast from Weather Compare (most accurate sources, refreshed every 30 min).",
            "author": "Weather Compare", "email": "", "width": W * 2, "height": H * 2, "features": "DOWNLOAD",
            "release": 377435216, "locked": False, "pflags": 0, "xscreens": 0, "yscreens": 0, "archive": None}
    return {"preset_info": info, "preset_root": root}


def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if not k.startswith("_")}
    if isinstance(o, list):
        return [strip(x) for x in o]
    return o


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def svg(preset):
    out = []
    for m in preset["preset_root"]["viewgroup_items"][0]["viewgroup_items"]:
        x, y = m["position_padding_left"], m["position_padding_top"]
        if m["internal_type"] == "ShapeModule":
            out.append(f'<rect x="{x}" y="{y}" width="{m["shape_width"]}" height="{m["shape_height"]}" rx="{m["shape_corners"]}" fill="#{m["paint_color"][3:]}" fill-opacity="{int(m["paint_color"][1:3], 16) / 255:.2f}"/>')
        else:
            s, size = m["_s"], m["text_size"]
            w = s["width"] or 0
            anchor, tx = {"LEFT": ("start", x), "CENTER": ("middle", x + w / 2), "RIGHT": ("end", x + w)}[s["align"]]
            out.append(f'<text x="{tx}" y="{y + size * 0.85}" font-size="{size}" font-family="Roboto, sans-serif" fill="#{m["paint_color"][3:]}" text-anchor="{anchor}"{" font-weight=\"700\"" if s["bold"] else ""}>{esc(s["text"])}</text>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">' + "".join(out) + "</svg>"


def main():
    for prefix, name, title in [("v", "BestForecast-Vallejo", "Best Forecast · Vallejo"), ("n", "BestForecast-Napa", "Best Forecast · Napa")]:
        p = widget(prefix, title)
        (HERE / f"{name}.svg").write_text(svg(p))
        with zipfile.ZipFile(HERE / f"{name}.kwgt", "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("preset.json", json.dumps(strip(p), ensure_ascii=False, indent=1))
        print("wrote", name)


if __name__ == "__main__":
    main()
