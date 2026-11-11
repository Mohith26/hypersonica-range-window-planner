// Range window planner: core logic (no DOM). Works in the browser and in Node (node --test).
//
// Question it answers: "If we book range R starting on date D, how many days do we need
// to book so that an N-flight campaign finishes with confidence 1 - alpha, given that
// weather has to meet our launch commit criteria (LCC)?"
//
// Method
//  1. Hourly ERA5 reanalysis (2010-2024) -> per-day "launchable" flag under the LCC
//     (a run of >= minRun consecutive hours inside the ops window where every limit holds,
//     optionally in daylight using the NOAA solar-position equations).
//  2. Historical replay: for each past year, start the campaign on D (and D +/- jitter days),
//     fly each vehicle on the first launchable day after setup / turnaround. Earliest-launch
//     is provably optimal for completion time (exchange argument; brute-force checked in tests).
//  3. Booking length = hierarchical conformal upper bound of completion time (years are the
//     exchangeable groups, the +/- jitter replays are draws within a year): the smallest t with
//     (1/(K+1)) * sum_years F_year(t) >= 1 - alpha  (Lee, Barber & Willett 2023, "HCP"; the
//     same threshold as Dunn, Wasserman & Ramdas's pooled CDF with a K/(K+1) finite-sample
//     correction). Coverage is checked out-of-sample: calibrate on 2010-2019, test on 2020-2024.
//  4. Annual plan: choose K campaign start dates (min gap G between starts for hardware
//     turnaround) minimizing total booked range days; exact DP, O(K * 365).

export const MS_DAY = 86400000;

// ---------- data access ----------

export function makeSite(meta, siteMeta, bytes) {
  const first = Date.parse(meta.first_day + 'T00:00:00Z');
  return {
    slug: siteMeta.slug, name: siteMeta.name, lat: siteMeta.lat, lon: siteMeta.lon,
    tz: siteMeta.tz, first, ndays: meta.ndays, hour0: meta.hour0, nhours: meta.nhours,
    scales: meta.scales, offsets: siteMeta.utc_offset_by_day, bytes,
  };
}

/** Decoded hourly values for day index k, hour slot j (0..nhours-1). null if missing. */
export function hourValues(site, k, j) {
  const b = (k * site.nhours + j) * 4;
  const raw = [site.bytes[b], site.bytes[b + 1], site.bytes[b + 2], site.bytes[b + 3]];
  if (raw.some((v) => v === 255)) return null;
  return { wind: raw[0] * site.scales[0], gust: raw[1] * site.scales[1],
    precip: raw[2] * site.scales[2], cloud: raw[3] * site.scales[3] };
}

export function dayIndex(site, y, m, d) {
  return Math.round((Date.UTC(y, m - 1, d) - site.first) / MS_DAY);
}

export function dateOfIndex(site, k) {
  return new Date(site.first + k * MS_DAY);
}

// ---------- solar elevation (NOAA General Solar Position equations) ----------

/** Solar elevation in degrees at a UTC instant (ms) for lat/lon in degrees. */
export function solarElevation(lat, lon, utcMs) {
  const d = new Date(utcMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = Math.floor((utcMs - start) / MS_DAY) + 1;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const yearDays = (d.getUTCFullYear() % 4 === 0 && (d.getUTCFullYear() % 100 !== 0 || d.getUTCFullYear() % 400 === 0)) ? 366 : 365;
  const g = (2 * Math.PI / yearDays) * (doy - 1 + (hour - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hour * 60 + eqt + 4 * lon; // true solar time, minutes
  const ha = ((tst / 4) - 180) * Math.PI / 180;
  const phi = lat * Math.PI / 180;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) * 180 / Math.PI;
}

// ---------- launch commit criteria ----------

export const DEFAULT_LCC = Object.freeze({
  maxWind: 10, maxGust: 15, maxPrecip: 0.5, maxCloud: 80,
  opsStart: 8, opsEnd: 18, minRun: 2, daylight: true,
});

/** Why an hour fails (array of reasons); empty array = green. */
export function hourReasons(site, k, j, lcc) {
  const v = hourValues(site, k, j);
  if (!v) return ['missing'];
  const r = [];
  if (v.wind > lcc.maxWind + 1e-9) r.push('wind');
  if (v.gust > lcc.maxGust + 1e-9) r.push('gust');
  if (v.precip > lcc.maxPrecip + 1e-9) r.push('precip');
  if (v.cloud > lcc.maxCloud + 1e-9) r.push('cloud');
  if (lcc.daylight) {
    const civilHour = site.hour0 + j + 0.5; // middle of the hour
    const utcMs = site.first + k * MS_DAY + (civilHour - site.offsets[k]) * 3600000;
    if (solarElevation(site.lat, site.lon, utcMs) <= 0) r.push('dark');
  }
  return r;
}

/** Longest run of consecutive green hours inside the ops window for day k. */
export function longestGreenRun(site, k, lcc) {
  let best = 0, cur = 0;
  for (let h = lcc.opsStart; h < lcc.opsEnd; h++) {
    const j = h - site.hour0;
    if (j < 0 || j >= site.nhours) { cur = 0; continue; }
    if (hourReasons(site, k, j, lcc).length === 0) { cur++; if (cur > best) best = cur; } else cur = 0;
  }
  return best;
}

/** Uint8Array over all days: 1 if the day has a launch opportunity under the LCC. */
export function launchableDays(site, lcc) {
  const out = new Uint8Array(site.ndays);
  for (let k = 0; k < site.ndays; k++) out[k] = longestGreenRun(site, k, lcc) >= lcc.minRun ? 1 : 0;
  return out;
}

// ---------- campaign replay ----------

export const DEFAULT_SPEC = Object.freeze({ flights: 2, setup: 5, turnaround: 3, teardown: 2, horizon: 120 });

/**
 * Replay a campaign arriving on day index s over a launchable series.
 * Flights go on the first launchable day >= earliest ready day (earliest-launch policy).
 * Returns { launches: [day offsets], days: booking length needed (arrival..teardown inclusive),
 *           censored: true if the data ran out before the horizon }.
 * days = Infinity when the campaign does not finish within the horizon.
 */
export function replay(launchable, s, spec) {
  const launches = [];
  let ready = spec.setup; // first possible launch offset (setup occupies days 0..setup-1)
  for (let t = ready; t < spec.horizon; t++) {
    const k = s + t;
    if (k >= launchable.length) return { launches, days: Infinity, censored: true };
    if (t < ready) continue;
    if (launchable[k]) {
      launches.push(t);
      if (launches.length === spec.flights) return { launches, days: t + 1 + spec.teardown, censored: false };
      ready = t + spec.turnaround;
      t = ready - 1;
    }
  }
  return { launches, days: Infinity, censored: s + spec.horizon > launchable.length };
}

/** Minimum completion offset over ALL feasible launch-day choices (exhaustive; tests only). */
export function bruteForceLastLaunch(launchable, s, spec) {
  let best = Infinity;
  const rec = (t, left) => {
    if (left === 0) { best = Math.min(best, t); return; }
    for (let u = t; u < spec.horizon && u < best; u++) {
      if (s + u >= launchable.length) return;
      if (launchable[s + u]) rec(u + spec.turnaround, left - 1);
    }
  };
  // rec carries "next earliest day"; best tracks the day of the last launch + turnaround
  rec(spec.setup, spec.flights);
  return best === Infinity ? Infinity : best - spec.turnaround; // offset of last launch
}

// ---------- conformal booking length ----------

/** Split-conformal upper bound: ceil((n+1)(1-alpha))-th order statistic (Infinity if > n). */
export function conformalUpper(samples, alpha) {
  const xs = [...samples].sort((a, b) => a - b);
  const n = xs.length;
  const k = Math.ceil((n + 1) * (1 - alpha));
  if (n === 0 || k > n) return Infinity;
  return xs[k - 1];
}

export function quantile(samples, p) {
  const xs = [...samples].sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const i = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1));
  return xs[i];
}

/**
 * Hierarchical conformal upper bound. replays: [{year, days}]. Years are groups.
 * Returns the smallest t with sum_y F_y(t) / (K + 1) >= 1 - alpha, or Infinity.
 * Finite-sample guarantee P(new <= t) >= 1 - alpha when years are exchangeable and the new
 * campaign is exchangeable with the replays of its own year (Lee, Barber & Willett 2023).
 */
export function hcpUpper(replays, alpha) {
  const by = new Map();
  for (const r of replays) {
    if (!by.has(r.year)) by.set(r.year, []);
    by.get(r.year).push(r.days);
  }
  const K = by.size;
  if (K === 0) return Infinity;
  // weighted point masses: each replay in year y has weight 1 / ((K + 1) * n_y)
  const pts = [];
  for (const v of by.values()) for (const d of v) pts.push([d, 1 / ((K + 1) * v.length)]);
  pts.sort((a, b) => a[0] - b[0]);
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    acc += pts[i][1];
    if ((i === pts.length - 1 || pts[i + 1][0] !== pts[i][0]) && acc >= 1 - alpha - 1e-12) return pts[i][0];
  }
  return Infinity;
}

/** Reference calendar used for start dates (non-leap year, so day 1..365). */
export function monthDayOfDoy(doy) {
  const d = new Date(Date.UTC(2023, 0, doy));
  return [d.getUTCMonth() + 1, d.getUTCDate()];
}

export function doyOf(m, d) {
  return Math.round((Date.UTC(2023, m - 1, d) - Date.UTC(2023, 0, 1)) / MS_DAY) + 1;
}

/**
 * Replays for a start date (month/day) over the given years, with +/- jitter days.
 * Returns [{year, offset, days, launches}] excluding data-censored replays.
 */
export function startReplays(site, launchable, m, d, spec, { years, jitter = 7 } = {}) {
  const out = [];
  for (const y of years) {
    const s0 = dayIndex(site, y, m, d);
    for (let j = -jitter; j <= jitter; j++) {
      const s = s0 + j;
      if (s < 0) continue;
      const r = replay(launchable, s, spec);
      if (r.censored) continue;
      out.push({ year: y, offset: j, days: r.days, launches: r.launches });
    }
  }
  return out;
}

export function yearsRange(a, b) { const ys = []; for (let y = a; y <= b; y++) ys.push(y); return ys; }

/** Booking curve over the reference year: per start day, conformal booking length and median. */
export function bookingCurve(site, launchable, spec, alpha, { years, jitter = 7 } = {}) {
  const curve = [];
  for (let doy = 1; doy <= 365; doy++) {
    const [m, d] = monthDayOfDoy(doy);
    const reps = startReplays(site, launchable, m, d, spec, { years, jitter });
    const days = reps.map((r) => r.days);
    curve.push({ doy, m, d, n: days.length, book: hcpUpper(reps, alpha), median: quantile(days, 0.5),
      fail: days.filter((x) => x === Infinity).length });
  }
  return curve;
}

/**
 * Out-of-sample check: calibrate booking lengths on calibYears, then measure how often
 * campaigns in testYears (exact start dates, no jitter) finish within the booking.
 * opts.bookOf(doy) can override the per-date booking (used for the season-blind baseline).
 */
export function backtest(site, launchable, spec, alpha, { calibYears, testYears, jitter = 7, bookOf = null }) {
  let hit = 0, total = 0, booked = 0;
  const byMonth = Array.from({ length: 12 }, () => ({ hit: 0, total: 0 }));
  for (let doy = 1; doy <= 365; doy++) {
    const [m, d] = monthDayOfDoy(doy);
    const book = bookOf ? bookOf(doy) : hcpUpper(startReplays(site, launchable, m, d, spec, { years: calibYears, jitter }), alpha);
    for (const r of startReplays(site, launchable, m, d, spec, { years: testYears, jitter: 0 })) {
      const ok = r.days <= book ? 1 : 0;
      hit += ok; total++; booked += book;
      byMonth[m - 1].hit += ok; byMonth[m - 1].total++;
    }
  }
  return { coverage: total ? hit / total : NaN, total, meanBooked: total ? booked / total : NaN,
    byMonth: byMonth.map((b) => (b.total ? b.hit / b.total : NaN)) };
}

/** Season-blind baseline: one booking length for every start date (same HCP rule, all dates pooled per year). */
export function flatBooking(site, launchable, spec, alpha, { years, jitter = 7 }) {
  const all = [];
  for (let doy = 1; doy <= 365; doy++) {
    const [m, d] = monthDayOfDoy(doy);
    for (const r of startReplays(site, launchable, m, d, spec, { years, jitter })) all.push(r);
  }
  return hcpUpper(all, alpha);
}

// ---------- probability of finishing within a chosen booking ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** P(days <= W) with a year-cluster bootstrap 90% interval (years resampled, not replays). */
export function probWithin(replays, W, { B = 400, seed = 7 } = {}) {
  const byYear = new Map();
  for (const r of replays) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r.days <= W ? 1 : 0);
  }
  const groups = [...byYear.values()];
  const all = groups.flat();
  const p = all.length ? all.reduce((a, b) => a + b, 0) / all.length : NaN;
  const rnd = mulberry32(seed);
  const boots = [];
  for (let b = 0; b < B && groups.length; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[Math.floor(rnd() * groups.length)];
      for (const v of g) { s += v; n++; }
    }
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  return { p, lo: boots.length ? boots[Math.floor(0.05 * (B - 1))] : NaN,
    hi: boots.length ? boots[Math.ceil(0.95 * (B - 1))] : NaN, years: groups.length, n: all.length };
}

// ---------- annual plan (exact DP) ----------

/**
 * Pick K start days (1..365) with start gaps >= minGap, all within [earliest, latest],
 * minimizing the sum of cost[doy] (booked range days). Exact dynamic program.
 * cost: array indexed by doy-1 (Infinity allowed). Returns { days: [doy...], total }.
 */
export function planYear(cost, K, minGap, earliest = 1, latest = 365) {
  const N = 365;
  const f = Array.from({ length: K + 1 }, () => new Float64Array(N + 1).fill(Infinity));
  const arg = Array.from({ length: K + 1 }, () => new Int32Array(N + 1).fill(-1));
  // f[k][d]: min cost choosing k campaigns with the k-th starting exactly on day d
  for (let d = earliest; d <= latest; d++) f[1][d] = cost[d - 1];
  for (let k = 2; k <= K; k++) {
    let bestPrev = Infinity, bestPrevDay = -1;
    for (let d = earliest; d <= latest; d++) {
      const p = d - minGap; // previous start must be <= d - minGap
      if (p >= earliest && f[k - 1][p] < bestPrev) { bestPrev = f[k - 1][p]; bestPrevDay = p; }
      if (bestPrev < Infinity && cost[d - 1] < Infinity) { f[k][d] = bestPrev + cost[d - 1]; arg[k][d] = bestPrevDay; }
    }
  }
  let total = Infinity, last = -1;
  for (let d = earliest; d <= latest; d++) if (f[K][d] < total) { total = f[K][d]; last = d; }
  if (last < 0) return { days: [], total: Infinity };
  const days = [last];
  for (let k = K; k > 1; k--) days.unshift(arg[k][days[0]]);
  return { days, total };
}

/** Baseline: K campaigns evenly spaced from `earliest`, one every `minGap` days. */
export function evenPlan(cost, K, minGap, earliest = 1) {
  const days = [];
  for (let i = 0; i < K; i++) days.push(earliest + i * minGap);
  if (days[days.length - 1] > 365) return { days, total: Infinity };
  return { days, total: days.reduce((a, d) => a + cost[d - 1], 0) };
}

/** Exhaustive minimum for small instances (tests only). */
export function bruteForcePlan(cost, K, minGap, earliest = 1, latest = 365) {
  let best = Infinity;
  const rec = (from, left, acc) => {
    if (acc >= best) return;
    if (left === 0) { best = acc; return; }
    for (let d = from; d <= latest; d++) rec(d + minGap, left - 1, acc + cost[d - 1]);
  };
  rec(earliest, K, 0);
  return best;
}

// ---------- summaries ----------

export function monthlySummary(curve) {
  const months = Array.from({ length: 12 }, () => []);
  for (const c of curve) months[c.m - 1].push(c);
  return months.map((cs, i) => ({ month: i + 1,
    book: quantile(cs.map((c) => c.book), 0.5), median: quantile(cs.map((c) => c.median), 0.5),
    bestDoy: cs.reduce((a, c) => (c.book < a.book ? c : a), cs[0]).doy }));
}

export function goRate(launchable, site, months, years) {
  let g = 0, n = 0;
  for (let k = 0; k < launchable.length; k++) {
    const dt = dateOfIndex(site, k);
    if (months && !months.includes(dt.getUTCMonth() + 1)) continue;
    if (years && !years.includes(dt.getUTCFullYear())) continue;
    g += launchable[k]; n++;
  }
  return n ? g / n : NaN;
}

export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => { const s = v === Infinity ? 'inf' : String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
