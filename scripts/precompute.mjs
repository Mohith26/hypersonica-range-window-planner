// Precomputes the default results shown on first paint (data/results.json).
// Deterministic: same data + same code => same file. tests/core.test.mjs recomputes and compares.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/core.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULTS = { alpha: 0.1, jitter: 7, years: [2010, 2024], calib: [2010, 2019], test: [2020, 2024],
  plan: { K: 4, minGap: 60, earliest: 1 } };

export function loadSites() {
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'data/sites.json'), 'utf8'));
  return { meta, sites: meta.sites.map((sm) => C.makeSite(meta, sm, new Uint8Array(fs.readFileSync(path.join(root, 'data', sm.slug + '.bin'))))) };
}

export function compute() {
  const { sites } = loadSites();
  const D = DEFAULTS, years = C.yearsRange(...D.years);
  const out = { generated_from: 'data/*.bin via src/core.js', lcc: C.DEFAULT_LCC, spec: C.DEFAULT_SPEC, ...D, sites: {} };
  for (const site of sites) {
    const L = C.launchableDays(site, C.DEFAULT_LCC);
    const curve = C.bookingCurve(site, L, C.DEFAULT_SPEC, D.alpha, { years, jitter: D.jitter });
    const cost = curve.map((c) => c.book);
    const opt = C.planYear(cost, D.plan.K, D.plan.minGap, D.plan.earliest);
    const even = C.evenPlan(cost, D.plan.K, D.plan.minGap, D.plan.earliest);
    const bt = C.backtest(site, L, C.DEFAULT_SPEC, D.alpha, { calibYears: C.yearsRange(...D.calib), testYears: C.yearsRange(...D.test), jitter: D.jitter });
    const flatCal = C.flatBooking(site, L, C.DEFAULT_SPEC, D.alpha, { years: C.yearsRange(...D.calib), jitter: D.jitter });
    const btFlat = C.backtest(site, L, C.DEFAULT_SPEC, D.alpha, { calibYears: C.yearsRange(...D.calib), testYears: C.yearsRange(...D.test), bookOf: () => flatCal });
    const r = (x) => Math.round(x * 1000) / 1000;
    out.sites[site.slug] = {
      go_rate: r(C.goRate(L, site)),
      book: cost, median: curve.map((c) => c.median),
      monthly: C.monthlySummary(curve),
      backtest: { coverage: r(bt.coverage), n: bt.total, mean_booked: r(bt.meanBooked), by_month: bt.byMonth.map(r) },
      flat: { booking: flatCal, coverage: r(btFlat.coverage), worst_month: r(Math.min(...btFlat.byMonth)) },
      plan: { optimal: opt, even },
    };
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('precompute.mjs')) {
  const res = compute();
  fs.writeFileSync(path.join(root, 'data/results.json'), JSON.stringify(res));
  for (const [k, v] of Object.entries(res.sites)) {
    console.log(k, 'go', v.go_rate, 'feb15', v.book[C.doyOf(2, 15) - 1], 'monthly', v.monthly.map((m) => m.book).join(' '),
      '| backtest', v.backtest.coverage, v.backtest.mean_booked, '| flat', v.flat.booking, v.flat.coverage, v.flat.worst_month,
      '| plan', v.plan.optimal.days.join('/'), v.plan.optimal.total, 'even', v.plan.even.total);
  }
}
