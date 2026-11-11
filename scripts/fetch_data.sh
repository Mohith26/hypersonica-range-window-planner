#!/usr/bin/env bash
# Downloads 15 years (2010-2024) of hourly reanalysis weather for each range from the
# free Open-Meteo Historical Weather API (ERA5 / ERA5-Land, "best_match"). No key needed.
# Times are requested in each site's standard-time zone label; Open-Meteo returns a fixed
# offset series, and scripts/build_data.py converts to true civil time (with DST).
set -euo pipefail
OUT=${1:-raw}
mkdir -p "$OUT"
while read -r slug lat lon tz; do
  curl -s -m 110 "https://archive-api.open-meteo.com/v1/archive?latitude=$lat&longitude=$lon&start_date=2010-01-01&end_date=2024-12-31&hourly=wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover_low&wind_speed_unit=ms&timezone=$tz" -o "$OUT/$slug.json"
  sleep 2
done <<'SITES'
andoya 69.294 16.021 Europe/Oslo
esrange 67.893 21.104 Europe/Stockholm
hebrides 57.33 -7.36 Europe/London
churchill 58.734 -93.82 America/Winnipeg
canso 45.31 -61.03 America/Halifax
SITES
