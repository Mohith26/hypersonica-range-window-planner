import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/core.js';
import { compute, loadSites, DEFAULTS } from '../scripts/precompute.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { meta, sites } = loadSites();
const bySlug = Object.fromEntries(sites.map((s) => [s.slug, s]));
const andoya = bySlug.andoya;
const YEARS = C.yearsRange(2010, 2024);

test('data: 5 ranges, 15 years of complete hourly records', () => {
  assert.equal(meta.sites.length, 5);
  assert.equal(meta.ndays, 5479);
  for (const s of sites) {
    assert.equal(s.bytes.length, meta.ndays * meta.nhours * 4);
    assert.equal(s.bytes.filter((b) => b === 255).length, 0, s.slug + ' has missing hours');
  }
});

test('data: decoded values are physically sane (gust >= sustained wind almost always)', () => {
  for (const s of sites) {
    let ok = 0, n = 0;
    for (let k = 0; k < s.ndays; k += 7) for (let j = 0; j < s.nhours; j++) {
      const v = C.hourValues(s, k, j);
      assert.ok(v.wind >= 0 && v.wind < 50 && v.cloud >= 0 && v.cloud <= 100 && v.precip >= 0);
      ok += v.gust + 1e-9 >= v.wind ? 1 : 0; n++;
    }
    assert.ok(ok / n > 0.97, s.slug + ' gust>=wind ' + ok / n);
  }
});

test('solar elevation: equinox noon at equator ~90°, Andøya polar night and midnight sun', () => {
  assert.ok(C.solarElevation(0, 0, Date.UTC(2023, 2, 20, 12, 7)) > 88);
  // Andøya (UTC+1): local solar noon on 21 Dec is below the horizon; local midnight on 21 Jun is above it
  assert.ok(C.solarElevation(69.294, 16.021, Date.UTC(2023, 11, 21, 10, 56)) < 0);
  assert.ok(C.solarElevation(69.294, 16.021, Date.UTC(2023, 5, 20, 22, 56)) > 0);
});

test('LCC: a value exactly at the limit passes; one step above fails', () => {
  const k = 100, j = 4;
  const v = C.hourValues(andoya, k, j);
  const lcc = { maxWind: v.wind, maxGust: v.gust, maxPrecip: v.precip, maxCloud: v.cloud, opsStart: 6, opsEnd: 22, minRun: 1, daylight: false };
  assert.deepEqual(C.hourReasons(andoya, k, j, lcc), []);
  assert.deepEqual(C.hourReasons(andoya, k, j, { ...lcc, maxGust: v.gust - 0.2 }), ['gust']);
});

test('LCC monotonicity: tightening any limit never adds launchable days (randomized)', () => {
  const rnd = C.mulberry32(42);
  for (let trial = 0; trial < 6; trial++) {
    const base = { maxWind: 6 + rnd() * 10, maxGust: 10 + rnd() * 10, maxPrecip: rnd() * 2, maxCloud: 50 + rnd() * 50, opsStart: 8, opsEnd: 18, minRun: 1 + Math.floor(rnd() * 3), daylight: rnd() < 0.5 };
    const tight = { ...base, maxWind: base.maxWind - 2, minRun: base.minRun + 1 };
    const a = C.launchableDays(bySlug.hebrides, base), b = C.launchableDays(bySlug.hebrides, tight);
    for (let k = 0; k < a.length; k++) assert.ok(b[k] <= a[k]);
  }
});

test('daylight: no launchable days at Andøya in the polar night (10 Dec - 2 Jan)', () => {
  const L = C.launchableDays(andoya, C.DEFAULT_LCC);
  for (const y of C.yearsRange(2010, 2023)) {
    for (let k = C.dayIndex(andoya, y, 12, 10); k <= C.dayIndex(andoya, y + 1, 1, 2); k++) assert.equal(L[k], 0);
  }
});

test('replay: hand-built series follows setup, turnaround and pack-down', () => {
  //            day: 0 1 2 3 4 5 6 7 8 9
  const L = Uint8Array.from([1, 1, 1, 0, 1, 1, 0, 0, 1, 1]);
  const r = C.replay(L, 0, { flights: 2, setup: 2, turnaround: 3, teardown: 1, horizon: 10 });
  assert.deepEqual(r.launches, [2, 5]);
  assert.equal(r.days, 7);
  const r2 = C.replay(L, 0, { flights: 3, setup: 2, turnaround: 3, teardown: 1, horizon: 10 });
  assert.deepEqual(r2.launches, [2, 5, 8]);
  const r4 = C.replay(L, 0, { flights: 4, setup: 2, turnaround: 3, teardown: 1, horizon: 10 });
  assert.equal(r4.days, Infinity); // ran out of horizon: a real failure, not censored
  assert.equal(r4.censored, false);
  assert.equal(C.replay(L, 0, { flights: 4, setup: 2, turnaround: 3, teardown: 1, horizon: 20 }).censored, true); // ran out of data
});

test('property: earliest-launch replay equals the brute-force optimum (300 random series)', () => {
  const rnd = C.mulberry32(7);
  for (let i = 0; i < 300; i++) {
    const n = 30, p = 0.2 + rnd() * 0.7;
    const L = Uint8Array.from({ length: n }, () => (rnd() < p ? 1 : 0));
    const spec = { flights: 1 + Math.floor(rnd() * 3), setup: Math.floor(rnd() * 3), turnaround: 1 + Math.floor(rnd() * 3), teardown: 0, horizon: n };
    const g = C.replay(L, 0, spec);
    const bf = C.bruteForceLastLaunch(L, 0, spec);
    if (g.days === Infinity) assert.equal(bf, Infinity);
    else assert.equal(g.launches[g.launches.length - 1], bf);
  }
});

test('conformal: finite-sample rank and the Infinity edge', () => {
  assert.equal(C.conformalUpper([5, 1, 3, 2, 4, 6, 7, 8, 9], 0.1), 9); // ceil(10*0.9)=9th
  assert.equal(C.conformalUpper([1, 2, 3, 4, 5], 0.1), Infinity); // ceil(6*0.9)=6 > 5
  assert.equal(C.conformalUpper([1, 2, 3, 4, 5], 0.4), 4); // ceil(6*0.6)=4
});

test('hierarchical conformal reduces to split conformal with one replay per year (randomized)', () => {
  const rnd = C.mulberry32(3);
  for (let t = 0; t < 200; t++) {
    const K = 2 + Math.floor(rnd() * 30), alpha = [0.05, 0.1, 0.2, 0.3][Math.floor(rnd() * 4)];
    const reps = Array.from({ length: K }, (_, y) => ({ year: y, days: Math.floor(rnd() * 20) }));
    assert.equal(C.hcpUpper(reps, alpha), C.conformalUpper(reps.map((r) => r.days), alpha));
  }
});

test('hierarchical conformal keeps coverage with correlated within-year replays (simulation)', () => {
  // Strong year effects + 15 correlated replays per year: naive pooled quantile under-covers, HCP does not.
  const rnd = C.mulberry32(99);
  const draw = (yeff) => Math.round(12 + yeff + 2 * rnd());
  let hcpHit = 0, naiveHit = 0, trials = 2000;
  for (let t = 0; t < trials; t++) {
    const reps = [];
    for (let y = 0; y < 10; y++) { const e = -Math.log(rnd()) * 6; for (let j = 0; j < 15; j++) reps.push({ year: y, days: draw(e) }); }
    const test = draw(-Math.log(rnd()) * 6);
    hcpHit += test <= C.hcpUpper(reps, 0.1) ? 1 : 0;
    naiveHit += test <= C.quantile(reps.map((r) => r.days), 0.9) ? 1 : 0;
  }
  assert.ok(hcpHit / trials >= 0.9, 'hcp ' + hcpHit / trials);
  assert.ok(naiveHit / trials < hcpHit / trials, 'naive ' + naiveHit / trials);
});

test('annual plan DP matches brute force and respects the minimum gap (randomized)', () => {
  const rnd = C.mulberry32(5);
  for (let t = 0; t < 60; t++) {
    const cost = Array.from({ length: 365 }, () => 10 + Math.floor(rnd() * 30));
    const K = 1 + Math.floor(rnd() * 3), gap = 20 + Math.floor(rnd() * 40), E = 1 + Math.floor(rnd() * 200), Lt = Math.min(365, E + 40 + Math.floor(rnd() * 100));
    const dp = C.planYear(cost, K, gap, E, Lt);
    const bf = C.bruteForcePlan(cost, K, gap, E, Lt);
    assert.equal(dp.total, bf);
    if (dp.total < Infinity) {
      assert.equal(dp.days.reduce((a, d) => a + cost[d - 1], 0), dp.total);
      for (let i = 1; i < dp.days.length; i++) assert.ok(dp.days[i] - dp.days[i - 1] >= gap);
      assert.ok(dp.days[0] >= E && dp.days[dp.days.length - 1] <= Lt);
    }
  }
  assert.equal(C.planYear(new Array(365).fill(1), 3, 200).total, Infinity);
});

test('multi-range plan: never worse than any single range, matches brute force over range choices', () => {
  const rnd = C.mulberry32(17);
  for (let t = 0; t < 40; t++) {
    const costs = { a: [], b: [], c: [] };
    for (const k of Object.keys(costs)) costs[k] = Array.from({ length: 365 }, () => 10 + Math.floor(rnd() * 30));
    const K = 1 + Math.floor(rnd() * 3), gap = 30 + Math.floor(rnd() * 30), E = 1 + Math.floor(rnd() * 150), Lt = Math.min(365, E + 60 + Math.floor(rnd() * 80));
    const multi = C.planYearMulti(costs, K, gap, E, Lt);
    for (const k of Object.keys(costs)) assert.ok(multi.total <= C.planYear(costs[k], K, gap, E, Lt).total);
    const env = Array.from({ length: 365 }, (_, i) => Math.min(costs.a[i], costs.b[i], costs.c[i]));
    assert.equal(multi.total, C.bruteForcePlan(env, K, gap, E, Lt));
    if (multi.total < Infinity) assert.equal(multi.days.reduce((acc, d, i) => acc + costs[multi.ranges[i]][d - 1], 0), multi.total);
  }
});

test('blackouts: no planned booking window overlaps a closed period', () => {
  const rnd = C.mulberry32(23);
  for (let t = 0; t < 30; t++) {
    const cost = Array.from({ length: 365 }, () => 8 + Math.floor(rnd() * 20));
    const a = 30 + Math.floor(rnd() * 250), bl = [[a, a + 10 + Math.floor(rnd() * 40)]];
    const masked = C.applyBlackouts(cost, bl);
    const p = C.planYear(masked, 3, 40);
    for (const d of p.days) assert.ok(d + cost[d - 1] - 1 < bl[0][0] || d > bl[0][1]);
    assert.equal(masked[bl[0][0] - 1], Infinity);
  }
});

test('probWithin: point estimate is the replay fraction and the bootstrap interval contains it', () => {
  const L = C.launchableDays(andoya, C.DEFAULT_LCC);
  const reps = C.startReplays(andoya, L, 2, 15, C.DEFAULT_SPEC, { years: YEARS, jitter: 7 });
  const pw = C.probWithin(reps, 13, { seed: 1 });
  assert.equal(pw.p, reps.filter((r) => r.days <= 13).length / reps.length);
  assert.ok(pw.lo <= pw.p && pw.p <= pw.hi);
  assert.deepEqual(C.probWithin(reps, 13, { seed: 1 }), pw);
});

test('booking length grows with confidence and with the number of flights', () => {
  const L = C.launchableDays(andoya, C.DEFAULT_LCC);
  const b = (alpha, flights) => C.hcpUpper(C.startReplays(andoya, L, 2, 15, { ...C.DEFAULT_SPEC, flights }, { years: YEARS, jitter: 7 }), alpha);
  assert.ok(b(0.2, 2) <= b(0.1, 2) && b(0.1, 2) <= b(0.05, 2));
  assert.ok(b(0.1, 1) <= b(0.1, 2) && b(0.1, 2) <= b(0.1, 3));
});

test('headline: committed results.json is reproduced exactly and quotes Andøya, 15 Feb', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(root, 'data/results.json'), 'utf8'));
  const fresh = JSON.parse(JSON.stringify(compute()));
  assert.deepEqual(fresh, committed);
  const a = committed.sites.andoya;
  assert.equal(a.book[C.doyOf(2, 15) - 1], 15); // 2-flight February campaign: book 15 days at 90%
  assert.equal(a.backtest.coverage, 0.957); // held-out 2020-2024 coverage
  assert.ok(a.backtest.mean_booked < a.flat.booking / 2); // seasonal booking < half the season-blind one
  for (const s of Object.values(committed.sites)) assert.ok(s.backtest.coverage >= 1 - DEFAULTS.alpha);
});

test('toCSV escapes commas, quotes and infinity', () => {
  assert.equal(C.toCSV([{ a: 'x,y', b: 'say "hi"', c: Infinity }]), 'a,b,c\n"x,y","say ""hi""",inf');
});
