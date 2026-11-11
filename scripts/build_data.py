#!/usr/bin/env python3
"""Pack the raw Open-Meteo archive JSON into compact per-site binaries for the browser.

Deterministic (no randomness): the same raw files always produce byte-identical output.

Layout of data/<site>.bin: day-major, for each calendar day 2010-01-01..2024-12-31,
16 civil-time hours (06:00..21:00 local, DST-aware) x 4 variables, one byte each:
  wind  = byte * 0.2 m/s   (10 m sustained wind)
  gust  = byte * 0.2 m/s   (10 m gusts)
  precip= byte * 0.1 mm/h  (capped at 25.4)
  cloud = byte %           (low cloud cover)
255 = missing.

data/sites.json holds site metadata and the per-day UTC offset (hours) used for the
solar-elevation (daylight) computation.

Usage: python3 scripts/build_data.py raw data
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SITES = [
    # slug, display name, operator/country, lat, lon, tz, note
    ("andoya", "Andøya Space", "Norway", 69.294, 16.021, "Europe/Oslo",
     "Where HS-1 flew in February 2026."),
    ("esrange", "Esrange", "Sweden", 67.893, 21.104, "Europe/Stockholm",
     "SSC range near Kiruna; overland impact area."),
    ("hebrides", "MOD Hebrides", "United Kingdom", 57.33, -7.36, "Europe/London",
     "UK MOD range, South Uist."),
    ("churchill", "Churchill", "Canada", 58.734, -93.82, "America/Winnipeg",
     "Former Churchill Rocket Research Range, Manitoba."),
    ("canso", "Spaceport Nova Scotia", "Canada", 45.31, -61.03, "America/Halifax",
     "Maritime Launch Services site, Canso."),
]
H0, NH = 6, 16
FIRST = datetime(2010, 1, 1)
LAST = datetime(2024, 12, 31)
NDAYS = (LAST - FIRST).days + 1


def q(v, scale, cap=254):
    if v is None:
        return 255
    return max(0, min(cap, int(round(v / scale))))


def main(raw_dir, out_dir):
    raw_dir, out_dir = Path(raw_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {"first_day": "2010-01-01", "ndays": NDAYS, "hour0": H0, "nhours": NH,
            "vars": ["wind", "gust", "precip", "cloud"],
            "scales": [0.2, 0.2, 0.1, 1.0],
            "source": "Open-Meteo Historical Weather API (ERA5/ERA5-Land reanalysis, best_match), hourly, 2010-2024",
            "sites": []}
    for slug, name, country, lat, lon, tzname, note in SITES:
        d = json.loads((raw_dir / f"{slug}.json").read_text())
        off = d["utc_offset_seconds"]
        tz = ZoneInfo(tzname)
        h = d["hourly"]
        buf = bytearray([255]) * (NDAYS * NH * 4)
        filled = 0
        for i, t in enumerate(h["time"]):
            # Open-Meteo returns a fixed-offset series: convert to UTC, then to civil time.
            utc = datetime.fromisoformat(t).replace(tzinfo=timezone(timedelta(seconds=off)))
            civil = utc.astimezone(tz)
            day = (datetime(civil.year, civil.month, civil.day) - FIRST).days
            hr = civil.hour - H0
            if not (0 <= day < NDAYS and 0 <= hr < NH):
                continue
            base = (day * NH + hr) * 4
            if buf[base] != 255:  # repeated hour at DST fall-back: keep the first
                continue
            buf[base] = q(h["wind_speed_10m"][i], 0.2)
            buf[base + 1] = q(h["wind_gusts_10m"][i], 0.2)
            buf[base + 2] = q(h["precipitation"][i], 0.1)
            buf[base + 3] = q(h["cloud_cover_low"][i], 1.0, 100)
            filled += 1
        # Spring-forward days miss one civil hour (02:00, outside 06-21) so coverage is complete.
        (out_dir / f"{slug}.bin").write_bytes(bytes(buf))
        offsets = []
        for k in range(NDAYS):
            noon = (FIRST + timedelta(days=k, hours=12)).replace(tzinfo=tz)
            x = noon.utcoffset().total_seconds() / 3600
            offsets.append(int(x) if x == int(x) else x)
        meta["sites"].append({"slug": slug, "name": name, "country": country, "lat": lat,
                              "lon": lon, "tz": tzname, "note": note,
                              "grid_lat": d["latitude"], "grid_lon": d["longitude"],
                              "elevation_m": d["elevation"], "utc_offset_by_day": offsets,
                              "hours_filled": filled})
        print(slug, filled, "of", NDAYS * NH, "hours filled")
    (out_dir / "sites.json").write_text(json.dumps(meta, separators=(",", ":")))


if __name__ == "__main__":
    main(*(sys.argv[1:3] if len(sys.argv) >= 3 else ("raw", "data")))
