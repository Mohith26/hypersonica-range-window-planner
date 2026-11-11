// UI layer for the range window planner. All numbers come from src/core.js over data/*.bin.
import * as C from './src/core.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YEARS = C.yearsRange(2010, 2024);
const CALIB = C.yearsRange(2010, 2019);
const TEST = C.yearsRange(2020, 2024);
const JITTER = 7;
const STORE = 'hs-range-window-planner/v1';
const DEF = { site: 'andoya', start: '02-15', flights: 2, setup: 5, turn: 3, tear: 2, conf: 90,
  wind: 10, gust: 15, precip: 0.5, cloud: 80, opsStart: 8, opsEnd: 18, run: 2, daylight: 1,
  year: '', day: '', book: '', tz: 'local' };
const NUMERIC = ['flights', 'setup', 'turn', 'tear', 'conf', 'wind', 'gust', 'precip', 'cloud', 'opsStart', 'opsEnd', 'run', 'daylight'];
const TABS = ['planner', 'replay', 'ranges', 'schedule', 'method'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDays = (d) => (d === Infinity ? '∞' : String(d));
const pct = (x, digits = 0) => (Number.isFinite(x) ? (100 * x).toFixed(digits) + '%' : '–');

let META = null, RESULTS = null;
const SITES = new Map(); // slug -> Promise<site>
const cache = new Map();
let state = { tab: 'planner', ...DEF };
let schedule = [];

// ---------------- state <-> URL ----------------
function readHash() {
  const h = location.hash.replace(/^#/, '');
  const [tab, qs] = h.split('?');
  const p = new URLSearchParams(qs || '');
  const s = { ...DEF, tab: TABS.includes(tab) ? tab : 'planner' };
  for (const k of Object.keys(DEF)) if (p.has(k)) s[k] = NUMERIC.includes(k) ? Number(p.get(k)) : p.get(k);
  if (!META?.sites.some((x) => x.slug === s.site)) s.site = DEF.site;
  if (!parseStart(s.start)) s.start = DEF.start;
  return s;
}
function writeHash(push = false) {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEF)) if (String(state[k]) !== String(DEF[k]) && state[k] !== '') p.set(k, state[k]);
  const url = '#' + state.tab + (p.toString() ? '?' + p.toString() : '');
  if (url !== location.hash) history[push ? 'pushState' : 'replaceState'](null, '', url);
}
function set(patch, { push = false } = {}) {
  state = { ...state, ...patch };
  writeHash(push);
  render();
}

// ---------------- data ----------------
async function fetchJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); }
function loadSite(slug) {
  if (!SITES.has(slug)) {
    const sm = META.sites.find((x) => x.slug === slug);
    SITES.set(slug, fetch('data/' + slug + '.bin').then((r) => { if (!r.ok) throw new Error('data/' + slug + '.bin ' + r.status); return r.arrayBuffer(); })
      .then((buf) => C.makeSite(META, sm, new Uint8Array(buf))).catch((e) => { SITES.delete(slug); throw e; }));
  }
  return SITES.get(slug);
}
const lccOf = (s) => ({ maxWind: s.wind, maxGust: s.gust, maxPrecip: s.precip, maxCloud: s.cloud, opsStart: s.opsStart, opsEnd: s.opsEnd, minRun: s.run, daylight: !!s.daylight });
const specOf = (s) => ({ flights: s.flights, setup: s.setup, turnaround: s.turn, teardown: s.tear, horizon: 120 });
const alphaOf = (s) => 1 - s.conf / 100;
const isDefaultModel = (s) => ['flights', 'setup', 'turn', 'tear', 'conf', 'wind', 'gust', 'precip', 'cloud', 'opsStart', 'opsEnd', 'run', 'daylight'].every((k) => Number(s[k]) === Number(DEF[k]));
function memo(key, fn) { if (!cache.has(key)) { if (cache.size > 60) cache.clear(); cache.set(key, fn()); } return cache.get(key); }
function launchable(site, s) { const l = lccOf(s); return memo('L|' + site.slug + JSON.stringify(l), () => C.launchableDays(site, l)); }
function curveOf(site, s) {
  return memo('C|' + site.slug + JSON.stringify([lccOf(s), specOf(s), s.conf]), () => C.bookingCurve(site, launchable(site, s), specOf(s), alphaOf(s), { years: YEARS, jitter: JITTER }));
}
function backtestOf(site, s) {
  return memo('B|' + site.slug + JSON.stringify([lccOf(s), specOf(s), s.conf]), () => {
    const L = launchable(site, s);
    const bt = C.backtest(site, L, specOf(s), alphaOf(s), { calibYears: CALIB, testYears: TEST, jitter: JITTER });
    const flat = C.flatBooking(site, L, specOf(s), alphaOf(s), { years: CALIB, jitter: JITTER });
    const btFlat = C.backtest(site, L, specOf(s), alphaOf(s), { calibYears: CALIB, testYears: TEST, bookOf: () => flat });
    return { bt, flat, btFlat };
  });
}

// ---------------- dates ----------------
function parseStart(v) {
  if (!v) return null;
  v = String(v).trim();
  let m, d, r;
  if ((r = v.match(/^(\d{1,2})-(\d{1,2})$/))) { m = +r[1]; d = +r[2]; }
  else if ((r = v.match(/^(\d{1,2})[\s./]+([A-Za-z]{3,})\.?$/))) { d = +r[1]; m = MONTHS.findIndex((x) => r[2].toLowerCase().startsWith(x.toLowerCase())) + 1; }
  else if ((r = v.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})$/))) { d = +r[2]; m = MONTHS.findIndex((x) => r[1].toLowerCase().startsWith(x.toLowerCase())) + 1; }
  else if ((r = v.match(/^(\d{1,2})[./](\d{1,2})$/))) { d = +r[1]; m = +r[2]; }
  if (!m || !d || m < 1 || m > 12) return null;
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d < 1 || d > dim) return null;
  return [m, d];
}
const mdKey = (m, d) => String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
const fmtMD = (m, d) => d + ' ' + MONTHS[m - 1];
const doyOfStart = (s) => { const [m, d] = parseStart(s.start); return C.doyOf(m, d); };
const startOfDoy = (doy) => { const [m, d] = C.monthDayOfDoy(((doy - 1 + 365) % 365) + 1); return mdKey(m, d); };
function fmtDate(y, m, d, plus = 0) {
  const dt = new Date(Date.UTC(y, m - 1, d + plus));
  return dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
}

// ---------------- UI helpers ----------------
let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200); }
function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const ICON = {
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/></svg>',
  link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"/></svg>',
  arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
};
function loadingView(label) {
  return `<div class="section"><div class="section-head"><span>${esc(label)}</span><span class="muted">Loading range weather…</span></div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:18px">${'<div class="skeleton" style="height:72px"></div>'.repeat(4)}</div>
  <div class="skeleton" style="height:240px;margin-top:22px"></div></div>`;
}
function errorView(err) {
  return `<div class="state"><div class="big">Couldn't load the range weather record.</div><p class="muted">${esc(err.message || err)}</p><button class="btn" id="retry">Retry</button></div>`;
}

// ---------------- side panel ----------------
function syncInputs() {
  const s = state;
  $('site').value = s.site;
  const sm = META.sites.find((x) => x.slug === s.site);
  $('siteNote').textContent = sm.country + ' · ' + sm.lat.toFixed(2) + '°, ' + sm.lon.toFixed(2) + '° · ' + sm.note;
  const [m, d] = parseStart(s.start);
  if (document.activeElement !== $('start')) { $('start').value = fmtMD(m, d); $('start').removeAttribute('aria-invalid'); }
  for (const [id, k] of [['flights', 'flights'], ['setup', 'setup'], ['turn', 'turn'], ['tear', 'tear'], ['wind', 'wind'], ['gust', 'gust'], ['precip', 'precip'], ['cloud', 'cloud'], ['opsStart', 'opsStart'], ['opsEnd', 'opsEnd'], ['run', 'run']]) {
    if (document.activeElement !== $(id)) $(id).value = s[k];
  }
  $('daylight').checked = !!s.daylight;
  for (const b of $('conf').querySelectorAll('button')) b.setAttribute('aria-pressed', String(+b.dataset.v === s.conf));
  $('tzLocal').setAttribute('aria-pressed', String(s.tz === 'local'));
  $('tzUtc').setAttribute('aria-pressed', String(s.tz === 'utc'));
}
function bindInputs() {
  $('site').innerHTML = META.sites.map((x) => `<option value="${x.slug}">${esc(x.name)}</option>`).join('');
  $('site').addEventListener('change', (e) => set({ site: e.target.value, year: '', day: '', book: '' }));
  $('start').addEventListener('change', (e) => {
    const p = parseStart(e.target.value);
    if (!p) { e.target.setAttribute('aria-invalid', 'true'); toast('Use a date like 15 Feb'); return; }
    e.target.removeAttribute('aria-invalid');
    set({ start: mdKey(...p), day: '', book: '' });
  });
  const limits = { flights: [1, 6], setup: [0, 30], turn: [1, 30], tear: [0, 20], wind: [1, 40], gust: [1, 50], precip: [0, 20], cloud: [0, 100], opsStart: [6, 21], opsEnd: [7, 22], run: [1, 12] };
  for (const [id, [lo, hi]] of Object.entries(limits)) {
    $(id).addEventListener('change', (e) => {
      let v = Number(e.target.value);
      if (!Number.isFinite(v)) v = DEF[id];
      v = Math.min(hi, Math.max(lo, v));
      if (['flights', 'setup', 'turn', 'tear', 'opsStart', 'opsEnd', 'run', 'cloud'].includes(id)) v = Math.round(v);
      const patch = { [id]: v, book: '' };
      if (id === 'opsStart' && v >= state.opsEnd) patch.opsEnd = Math.min(22, v + 1);
      if (id === 'opsEnd' && v <= state.opsStart) patch.opsStart = Math.max(6, v - 1);
      e.target.value = v;
      set(patch);
    });
  }
  $('daylight').addEventListener('change', (e) => set({ daylight: e.target.checked ? 1 : 0, book: '' }));
  $('conf').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) set({ conf: +b.dataset.v, book: '' }); });
  $('reset').addEventListener('click', () => { set({ ...DEF, tab: state.tab }); toast('Inputs reset to defaults'); });
  $('tzLocal').addEventListener('click', () => set({ tz: 'local' }));
  $('tzUtc').addEventListener('click', () => set({ tz: 'utc' }));
  for (const a of document.querySelectorAll('[data-stub]')) a.addEventListener('click', (e) => { e.preventDefault(); toast(a.textContent + ' is outside this concept demo'); });
  for (const a of document.querySelectorAll('.tabs a')) a.addEventListener('click', (e) => { e.preventDefault(); set({ tab: a.dataset.tab }, { push: true }); });
  document.querySelector('.logo').addEventListener('click', (e) => { e.preventDefault(); set({ tab: 'planner' }, { push: true }); });
  $('helpBtn').addEventListener('click', () => $('help').classList.add('on'));
  $('help').addEventListener('click', (e) => { if (e.target.id === 'help') $('help').classList.remove('on'); });
}

// ---------------- render ----------------
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  syncInputs();
  for (const a of document.querySelectorAll('.tabs a')) a.setAttribute('aria-selected', String(a.dataset.tab === state.tab));
  $('schedCount').textContent = schedule.length ? schedule.length : '';
  const sm = META.sites.find((x) => x.slug === state.site);
  const [m, d] = parseStart(state.start);
  $('meta').textContent = sm.name + ' · arrive ' + fmtMD(m, d) + ' · ' + state.flights + (state.flights === 1 ? ' flight' : ' flights') + ' · ' + state.conf + '% confidence';
  const subs = { planner: 'Range window planner: how long to book, and when, so the campaign flies.', replay: 'Replay every past year of this window, day by day and hour by hour.',
    ranges: 'Compare ranges month by month under the same campaign and criteria.', schedule: 'Your requested range windows, and the year plan that books the fewest days.',
    method: 'How the booking length is computed and how well it held up.' };
  $('sub').textContent = subs[state.tab];
  document.title = ({ planner: 'Planner', replay: 'Replay', ranges: 'Ranges', schedule: 'Schedule', method: 'Method' })[state.tab] + ' · Campaigns · Hypersonica (concept)';
  const view = $('view');
  if (state.tab === 'schedule') { view.innerHTML = scheduleView(null); bindSchedule(); }
  let site;
  try {
    const p = loadSite(state.site);
    if (!cache.has('ready|' + state.site)) { if (state.tab !== 'schedule') view.innerHTML = loadingView(state.tab === 'ranges' ? 'Ranges' : 'Booking length by arrival date'); }
    site = await p;
    cache.set('ready|' + state.site, true);
  } catch (e) {
    if (seq !== renderSeq) return;
    view.innerHTML = errorView(e);
    $('retry').addEventListener('click', () => render());
    return;
  }
  if (seq !== renderSeq) return;
  try {
    if (state.tab === 'planner') { view.innerHTML = plannerView(site); bindPlanner(site); }
    else if (state.tab === 'replay') { view.innerHTML = replayView(site); bindReplay(site); }
    else if (state.tab === 'ranges') await rangesRender(seq);
    else if (state.tab === 'schedule') { view.innerHTML = scheduleView(site); bindSchedule(site); }
    else if (state.tab === 'method') { view.innerHTML = methodView(site); bindMethod(site); }
  } catch (e) {
    console.error(e);
    view.innerHTML = errorView(e);
    $('retry').addEventListener('click', () => render());
  }
}

// ---------------- planner (main view) ----------------
function plannerData(site) {
  const s = state;
  const curve = curveOf(site, s);
  const doy = doyOfStart(s);
  const c = curve[doy - 1];
  const [m, d] = parseStart(s.start);
  const L = launchable(site, s);
  const reps = C.startReplays(site, L, m, d, specOf(s), { years: YEARS, jitter: JITTER });
  const exact = C.startReplays(site, L, m, d, specOf(s), { years: YEARS, jitter: 0 });
  const userBook = s.book !== '' && Number.isFinite(+s.book) ? +s.book : (c.book === Infinity ? 30 : c.book);
  const pw = C.probWithin(reps, userBook, { B: 400, seed: 11 });
  const go = C.goRate(L, site, [m]);
  return { curve, doy, c, m, d, L, reps, exact, userBook, pw, go };
}

function plannerView(site) {
  const s = state;
  const P = plannerData(site);
  const { c, m, d, exact, userBook, pw, go } = P;
  const minNominal = s.setup + 1 + (s.flights - 1) * s.turn + s.tear;
  const best = P.curve.reduce((a, x) => (x.book < a.book ? x : a), P.curve[0]);
  const within = exact.filter((r) => r.days <= c.book).length;
  const showDays = Math.min(48, Math.max(minNominal + 4, Number.isFinite(c.book) ? c.book + 3 : 40, ...exact.filter((r) => r.days < Infinity).map((r) => r.days + 1)));
  const rows = exact.map((r) => {
    const last = r.launches.length ? r.launches[r.launches.length - 1] : -1;
    const cells = [];
    for (let t = 0; t < showDays; t++) {
      let cls = t < s.setup ? 'setup' : r.launches.includes(t) ? 'launch' : (r.days < Infinity && t > last && t <= last + s.tear) ? 'tear' : P.L[C.dayIndex(site, r.year, m, d) + t] ? 'go' : '';
      if (r.days < Infinity && t > last + s.tear) cls += ' out';
      if (Number.isFinite(c.book) && t === c.book - 1) cls += ' book';
      cells.push(`<i class="${cls.trim()}"></i>`);
    }
    const ok = r.days <= c.book;
    return `<tr class="click${String(r.year) === String(s.year) ? ' sel' : ''}" data-year="${r.year}" tabindex="0" aria-label="Open replay for ${r.year}">
      <td style="font-weight:500">${r.year}</td>
      <td>${r.launches.map((t) => fmtDate(r.year, m, d, t).replace(/ \d{4}$/, '')).join(', ') || '<span class="muted">none</span>'}</td>
      <td class="num">${fmtDays(r.days)}</td>
      <td>${ok ? '<span class="tag white">Within booking</span>' : '<span class="tag">Overran</span>'}</td>
      <td><div class="strip" aria-hidden="true">${cells.join('')}</div></td></tr>`;
  }).join('');
  const bookTxt = c.book === Infinity ? '∞' : c.book;
  return `
  <div class="section">
    <div class="section-head"><span>Booking length · arrive ${fmtMD(m, d)}</span><span class="muted">${P.reps.length} replays from ${new Set(P.reps.map((r) => r.year)).size} years · ±${JITTER} days around the arrival date</span></div>
    <div class="kpis">
      <div class="kpi"><div class="label">Book</div><div class="value">${bookTxt}<small>days</small></div><div class="note">to fly ${s.flights} of ${s.flights}, at least ${s.conf}% for a new year (conformal, 15 years). Nominal without weather: ${minNominal} days.</div></div>
      <div class="kpi"><div class="label">Median finish</div><div class="value">${fmtDays(c.median)}<small>days</small></div><div class="note">Half of past years were done by then. Best arrival this year: ${fmtMD(best.m, best.d)} (${fmtDays(best.book)} days).</div></div>
      <div class="kpi"><div class="label"><label for="userBook">If we book</label></div><div class="inline"><input class="input" id="userBook" type="number" min="1" max="120" value="${userBook}" aria-describedby="pwNote"><span class="muted">days</span></div><div class="value" style="font-size:32px;margin-top:8px">${pct(pw.p)}</div><div class="note" id="pwNote">chance to finish. 90% interval ${pct(pw.lo)} to ${pct(pw.hi)} (year bootstrap).</div></div>
      <div class="kpi"><div class="label">Launchable days, ${MONTHS[m - 1]}</div><div class="value">${pct(go)}</div><div class="note">Days with a ${s.run} h hold-free run inside ${String(s.opsStart).padStart(2, '0')}:00 to ${String(s.opsEnd).padStart(2, '0')}:00${s.daylight ? ', in daylight' : ''}.</div></div>
    </div>
  </div>
  <div class="section">
    <div class="section-head"><span>By arrival date</span><span class="legend"><span><i style="border-color:#fff"></i>Book (${s.conf}%)</span><span><i style="border-color:#7e7e7e"></i>Median</span><span><i style="border-color:#3341c2;border-top-width:2px"></i>Selected</span></span></div>
    <div class="chart-wrap" id="chartWrap"><svg class="chart" id="chart" role="img" aria-label="Booking length by arrival date across the year"></svg></div>
    <div class="actions" style="margin-top:12px">
      <button class="btn" id="add">${ICON.plus}Add to schedule<kbd style="border-color:rgba(0,0,0,.3)">A</kbd></button>
      <button class="btn ghost" id="exportCurve">${ICON.down}Export CSV</button>
      <button class="btn ghost" id="copyLink">${ICON.link}Copy link</button>
      <span class="muted" style="margin-left:8px">Click the chart to move the arrival date.</span>
    </div>
  </div>
  <div class="section">
    <div class="section-head"><span>Past years from ${fmtMD(m, d)}</span><span class="muted">${within} of ${exact.length} years finished inside a ${bookTxt}-day booking · open a year to replay it</span></div>
    <table><thead><tr><th style="width:70px">Year</th><th style="width:150px">Launch days</th><th class="num" style="width:90px">Days used</th><th style="width:130px">Booking</th><th>Day by day</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="keyrow" style="margin-top:10px"><span><i style="background:repeating-linear-gradient(135deg,#2c2c2c 0 2px,#1d1d1d 2px 4px)"></i>Setup</span><span><i style="background:#595959"></i>Launchable</span><span><i style="background:#262626"></i>No-go</span><span><i style="background:#3341c2"></i>Launch</span><span><i style="box-shadow:inset 0 0 0 1px #595959"></i>Pack-down</span><span><i style="box-shadow:2px 0 0 0 #fff;background:#262626"></i>End of booking</span></div>
  </div>`;
}

function drawChart(site) {
  const svg = $('chart'); if (!svg) return;
  const curve = curveOf(site, state);
  const W = svg.clientWidth || 900, H = 280, ml = 34, mr = 8, mt = 12, mb = 26;
  const finite = curve.map((c) => c.book).filter(Number.isFinite);
  const ymax = Math.max(10, Math.min(80, Math.ceil((Math.max(...finite, 10) + 2) / 5) * 5));
  const x = (doy) => ml + (doy - 1) / 364 * (W - ml - mr);
  const y = (v) => mt + (1 - Math.min(v, ymax) / ymax) * (H - mt - mb);
  let g = '';
  for (let v = 0; v <= ymax; v += ymax > 40 ? 10 : 5) g += `<line class="grid" x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${ml - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let mm = 1; mm <= 12; mm++) { const dx = x(C.doyOf(mm, 1)); g += `<line class="grid" x1="${dx}" x2="${dx}" y1="${mt}" y2="${H - mb}" stroke-dasharray="2 3"/><text class="tick" x="${dx + 4}" y="${H - 8}">${MONTHS[mm - 1]}</text>`; }
  // no-finish bands
  let band = '';
  for (let i = 0; i < curve.length;) {
    if (curve[i].book === Infinity) { let j = i; while (j < curve.length && curve[j].book === Infinity) j++; band += `<rect x="${x(i + 1)}" y="${mt}" width="${Math.max(1, x(j) - x(i + 1))}" height="${H - mt - mb}" fill="url(#hatch)"/>`; i = j; } else i++;
  }
  const path = (key) => { let p = '', on = false; for (const c of curve) { if (!Number.isFinite(c[key])) { on = false; continue; } p += (on ? 'L' : 'M') + x(c.doy).toFixed(1) + ' ' + y(c[key]).toFixed(1); on = true; } return p; };
  const doy = doyOfStart(state), c = curve[doy - 1];
  const sel = `<line x1="${x(doy)}" x2="${x(doy)}" y1="${mt}" y2="${H - mb}" stroke="#3341c2" stroke-width="2"/>` + (Number.isFinite(c.book) ? `<circle cx="${x(doy)}" cy="${y(c.book)}" r="4.5" fill="#3341c2" stroke="#fff" stroke-width="1.5"/>` : '');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#fff" stroke-opacity=".12" stroke-width="2"/></pattern></defs>
    ${band}${g}<line class="axis" x1="${ml}" x2="${W - mr}" y1="${H - mb}" y2="${H - mb}"/>
    <path d="${path('median')}" fill="none" stroke="#7e7e7e" stroke-width="1.25"/>
    <path d="${path('book')}" fill="none" stroke="#fff" stroke-width="1.5"/>${sel}
    <line id="hover" x1="0" x2="0" y1="${mt}" y2="${H - mb}" stroke="#fff" stroke-opacity=".5" style="display:none"/>
    <text class="tick" x="${ml - 8}" y="${mt - 2}" text-anchor="end" style="opacity:.0">days</text>`;
  const tip = $('tip');
  const toDoy = (ev) => { const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width); return Math.max(1, Math.min(365, Math.round((px - ml) / (W - ml - mr) * 364) + 1)); };
  svg.onmousemove = (ev) => {
    const dd = toDoy(ev), cc = curve[dd - 1];
    const hv = svg.querySelector('#hover'); hv.style.display = ''; hv.setAttribute('x1', x(dd)); hv.setAttribute('x2', x(dd));
    const r = svg.getBoundingClientRect();
    tip.innerHTML = `<b>Arrive ${fmtMD(cc.m, cc.d)}</b><br>Book ${fmtDays(cc.book)} days · median ${fmtDays(cc.median)}${cc.fail ? `<br>${cc.fail} of ${cc.n} replays never finished` : ''}`;
    tip.style.display = 'block';
    tip.style.left = (r.left + window.scrollX + x(dd) * r.width / W) + 'px';
    tip.style.top = (r.top + window.scrollY + y(Number.isFinite(cc.book) ? cc.book : ymax) * r.height / H - 10) + 'px';
  };
  svg.onmouseleave = () => { tip.style.display = 'none'; const hv = svg.querySelector('#hover'); if (hv) hv.style.display = 'none'; };
  svg.onclick = (ev) => { tip.style.display = 'none'; set({ start: startOfDoy(toDoy(ev)), book: '', day: '' }); };
}

function addToSchedule(site, fromPlan = null) {
  const s = state;
  const curve = curveOf(site, s);
  const items = (fromPlan || [doyOfStart(s)]).map((doy) => {
    const c = curve[doy - 1];
    return { id: Math.random().toString(36).slice(2, 9), site: s.site, start: mdKey(c.m, c.d), year: planYearValue(), flights: s.flights,
      book: c.book, median: c.median, conf: s.conf, status: 'Proposed', created: new Date().toISOString(), params: { ...lccOf(s), ...specOf(s) } };
  });
  if (items.some((i) => i.book === Infinity)) { toast('No finish within 120 days for that window; pick another date'); return false; }
  schedule = [...schedule, ...items].sort((a, b) => (a.year - b.year) || a.start.localeCompare(b.start));
  saveSchedule();
  toast(items.length === 1 ? `Added ${META.sites.find((x) => x.slug === s.site).name}, ${fmtMD(...parseStart(items[0].start))} (${items[0].book} days)` : `Added ${items.length} windows to the schedule`);
  $('schedCount').textContent = schedule.length;
  return true;
}

function bindPlanner(site) {
  drawChart(site);
  $('userBook').addEventListener('change', (e) => { const v = Math.max(1, Math.min(120, Math.round(+e.target.value || 1))); set({ book: v }); });
  $('add').addEventListener('click', () => addToSchedule(site));
  $('exportCurve').addEventListener('click', () => exportCurrent(site));
  $('copyLink').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast(location.href); } });
  for (const tr of document.querySelectorAll('tr[data-year]')) {
    const open = () => set({ tab: 'replay', year: tr.dataset.year, day: '' }, { push: true });
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  }
}

// ---------------- replay (drill-down) ----------------
function replayView(site) {
  const s = state;
  const [m, d] = parseStart(s.start);
  const curve = curveOf(site, s);
  const c = curve[doyOfStart(s) - 1];
  const L = launchable(site, s);
  const exact = C.startReplays(site, L, m, d, specOf(s), { years: YEARS, jitter: 0 });
  const worst = exact.reduce((a, r) => (r.days > a.days ? r : a), exact[0]);
  const year = exact.some((r) => String(r.year) === String(s.year)) ? +s.year : worst.year;
  const R = exact.find((r) => r.year === year);
  const nCols = Math.min(60, Math.max(Number.isFinite(c.book) ? c.book + 3 : 45, ...exact.filter((r) => r.days < Infinity).map((r) => r.days + 1)));
  const day = s.day !== '' && +s.day < nCols ? +s.day : (R.launches[0] ?? s.setup);
  let grid = `<div class="grid-days" style="grid-template-columns:44px repeat(${nCols},1fr)"><span></span>`;
  for (let t = 0; t < nCols; t++) grid += `<span class="muted" style="font-size:11px;text-align:center">${t % 5 === 0 ? t + 1 : ''}</span>`;
  for (const r of exact) {
    const last = r.launches.length ? r.launches[r.launches.length - 1] : -1;
    grid += `<span class="yr">${r.year}</span>`;
    for (let t = 0; t < nCols; t++) {
      let cls = t < s.setup ? 'setup' : r.launches.includes(t) ? 'launch' : (r.days < Infinity && t > last && t <= last + s.tear) ? 'tear' : L[C.dayIndex(site, r.year, m, d) + t] ? 'go' : '';
      if (Number.isFinite(c.book) && t === c.book - 1) cls += ' bookline';
      if (r.year === year && t === day) cls += ' sel';
      grid += `<button class="cell ${cls.trim()}" data-y="${r.year}" data-t="${t}" aria-label="${r.year}, day ${t + 1}, ${fmtDate(r.year, m, d, t)}${cls.includes('launch') ? ', launch' : ''}"></button>`;
    }
  }
  grid += '</div>';
  // hourly detail for the selected day
  const k = C.dayIndex(site, year, m, d) + day;
  const lcc = lccOf(s);
  let hours = '';
  for (let h = Math.max(6, s.opsStart - 1); h < Math.min(22, s.opsEnd + 1); h++) {
    const j = h - site.hour0;
    const v = C.hourValues(site, k, j);
    const reasons = C.hourReasons(site, k, j, lcc);
    const inOps = h >= s.opsStart && h < s.opsEnd;
    const utcMs = site.first + k * C.MS_DAY + (h + 0.5 - site.offsets[k]) * 3600000;
    const sun = C.solarElevation(site.lat, site.lon, utcMs);
    const label = s.tz === 'utc' ? String(((h - site.offsets[k]) % 24 + 24) % 24).padStart(2, '0') + ':00Z' : String(h).padStart(2, '0') + ':00';
    const bad = (r) => reasons.includes(r) ? ' class="bad"' : '';
    hours += `<tr class="${inOps && !reasons.length ? 'green' : ''}${inOps ? '' : ' muted'}"><td>${label}</td><td${bad('wind')}>${v ? v.wind.toFixed(1) : '–'}</td><td${bad('gust')}>${v ? v.gust.toFixed(1) : '–'}</td><td${bad('precip')}>${v ? v.precip.toFixed(1) : '–'}</td><td${bad('cloud')}>${v ? Math.round(v.cloud) : '–'}</td><td${lcc.daylight && sun <= 0 ? ' class="bad"' : ''}>${sun.toFixed(0)}°</td><td>${!inOps ? 'outside ops' : reasons.length ? reasons.map((x) => ({ wind: 'wind', gust: 'gust', precip: 'rain', cloud: 'cloud', dark: 'dark', missing: 'no data' })[x]).join(', ') : 'green'}</td></tr>`;
  }
  const run = C.longestGreenRun(site, k, lcc);
  const status = day < s.setup ? 'Setup day' : R.launches.includes(day) ? `Launch ${R.launches.indexOf(day) + 1} of ${s.flights}` : L[k] ? 'Launchable, vehicle not ready' : 'No-go';
  const doneTxt = R.days === Infinity ? 'did not finish within 120 days' : `finished in ${R.days} days`;
  return `
  <div class="section">
    <div class="section-head"><span>${esc(site.name)} · arrive ${fmtMD(m, d)} · every past year</span><span class="muted">Columns are days on range · white edge marks the ${fmtDays(c.book)}-day booking</span></div>
    <div style="margin-top:14px">${grid}</div>
    <div class="keyrow" style="margin-top:10px"><span><i style="background:repeating-linear-gradient(135deg,#2c2c2c 0 2px,#1d1d1d 2px 4px)"></i>Setup</span><span><i style="background:#595959"></i>Launchable</span><span><i style="background:#262626"></i>No-go</span><span><i style="background:#3341c2"></i>Launch</span><span><i style="box-shadow:inset 0 0 0 1px #595959"></i>Pack-down</span><span class="muted">Click any day for its hourly weather.</span></div>
  </div>
  <div class="section two">
    <div>
      <div class="section-head"><span>${fmtDate(year, m, d, day)} · day ${day + 1}</span><span class="muted">${status} · longest green run ${run} h</span></div>
      <table class="hours"><thead><tr><th>Hour (${s.tz === 'utc' ? 'UTC' : 'local'})</th><th>Wind m/s</th><th>Gust m/s</th><th>Rain mm/h</th><th>Low cloud %</th><th>Sun</th><th>Verdict</th></tr></thead><tbody>${hours}</tbody></table>
    </div>
    <div>
      <div class="section-head"><span>${year} campaign</span><span class="muted">${doneTxt}</span></div>
      <div class="panel" style="margin-top:14px">
        <h3>Launches</h3>
        <p style="margin:0 0 10px">${R.launches.map((t, i) => `Flight ${i + 1}: ${fmtDate(year, m, d, t)} (day ${t + 1})`).join('<br>') || 'None'}</p>
        <h3>Against the booking</h3>
        <p style="margin:0 0 12px">${R.days <= c.book ? `Inside the ${c.book}-day booking with ${c.book - R.days} day${c.book - R.days === 1 ? '' : 's'} spare.` : `Overran the ${fmtDays(c.book)}-day booking${R.days < Infinity ? ' by ' + (R.days - c.book) + (R.days - c.book === 1 ? ' day' : ' days') : ''}.`}</p>
        <div class="actions"><button class="btn ghost" id="prevYear" ${year === YEARS[0] ? 'disabled' : ''}>Previous year</button><button class="btn ghost" id="nextYear" ${year === YEARS[YEARS.length - 1] ? 'disabled' : ''}>Next year</button></div>
      </div>
      <div class="actions" style="margin-top:12px"><button class="btn ghost" id="exportReplay">${ICON.down}Export replays CSV</button><button class="btn ghost" id="backPlanner">${ICON.arrow}Planner</button></div>
    </div>
  </div>`;
}
function bindReplay(site) {
  for (const b of document.querySelectorAll('.cell')) b.addEventListener('click', () => set({ year: b.dataset.y, day: b.dataset.t }));
  const y = +document.querySelector('.cell.sel')?.dataset.y;
  $('prevYear').addEventListener('click', () => set({ year: String(y - 1), day: '' }));
  $('nextYear').addEventListener('click', () => set({ year: String(y + 1), day: '' }));
  $('exportReplay').addEventListener('click', () => exportCurrent(site));
  $('backPlanner').addEventListener('click', () => set({ tab: 'planner' }, { push: true }));
}

// ---------------- ranges ----------------
async function rangesRender(seq) {
  const view = $('view');
  const s = state;
  let table;
  if (isDefaultModel(s) && RESULTS) {
    table = META.sites.map((sm) => { const r = RESULTS.sites[sm.slug]; return { sm, monthly: r.monthly.map((x) => x.book), go: r.go_rate, cov: r.backtest.coverage, flat: r.flat.booking }; });
  } else {
    view.innerHTML = loadingView('Ranges');
    let sites;
    try { sites = await Promise.all(META.sites.map((sm) => loadSite(sm.slug))); } catch (e) { if (seq === renderSeq) { view.innerHTML = errorView(e); $('retry').addEventListener('click', () => render()); } return; }
    if (seq !== renderSeq) return;
    await new Promise((r) => setTimeout(r, 0));
    table = sites.map((site) => {
      const curve = curveOf(site, s);
      const bt = backtestOf(site, s);
      return { sm: META.sites.find((x) => x.slug === site.slug), monthly: C.monthlySummary(curve).map((x) => x.book), go: C.goRate(launchable(site, s), site), cov: bt.bt.coverage, flat: bt.flat };
    });
    if (seq !== renderSeq) return;
  }
  const finite = table.flatMap((t) => t.monthly).filter(Number.isFinite);
  const sorted = [...finite].sort((x, y) => x - y);
  const lo = sorted[0], hi = Math.max(lo + 5, sorted[Math.floor(0.9 * (sorted.length - 1))]);
  const [cm] = parseStart(s.start);
  const rows = table.map((t) => `<tr><td style="font-weight:500;white-space:nowrap">${esc(t.sm.name)}<div class="muted" style="font-weight:400;font-size:12px">${esc(t.sm.country)}</div></td>${t.monthly.map((v, i) => {
    const a = Number.isFinite(v) ? 0.08 + 0.87 * Math.pow(Math.max(0, 1 - (v - lo) / (hi - lo)), 1.6) : 0;
    const bg = Number.isFinite(v) ? `rgba(51,65,194,${a.toFixed(2)})` : 'repeating-linear-gradient(135deg,#262626 0 3px,#1d1d1d 3px 6px)';
    return `<td class="h${t.sm.slug === s.site && i + 1 === cm ? ' cur' : ''}" style="background:${bg}" data-site="${t.sm.slug}" data-m="${i + 1}" tabindex="0" aria-label="${esc(t.sm.name)} ${MONTHS[i]}: book ${fmtDays(v)} days">${fmtDays(v)}</td>`;
  }).join('')}<td class="num">${pct(t.go)}</td><td class="num">${fmtDays(t.flat)}</td><td class="num">${pct(t.cov, 1)}</td></tr>`).join('');
  view.innerHTML = `
  <div class="section">
    <div class="section-head"><span>Days to book for ${s.flights} flights at ${s.conf}% confidence · arrival in month</span><span class="muted">Median over arrival dates in the month · click a cell to plan it</span></div>
    <table class="heat"><thead><tr><th>Range</th>${MONTHS.map((x) => `<th class="m">${x}</th>`).join('')}<th class="num">Launchable days</th><th class="num" title="One booking length for every date, same rule, season ignored">Season-blind</th><th class="num" title="Calibrated on 2010-2019, tested on 2020-2024 campaigns">Held-out coverage</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="keyrow" style="margin-top:12px"><span><i style="background:rgba(51,65,194,.9)"></i>Shortest booking</span><span><i style="background:rgba(51,65,194,.1)"></i>${hi}+ days</span><span><i style="background:repeating-linear-gradient(135deg,#262626 0 3px,#1d1d1d 3px 6px)"></i>No finish within 120 days</span><span class="muted">Season-blind = one booking length for every date that meets the same ${s.conf}% target.</span></div>
    <div class="actions" style="margin-top:14px"><button class="btn ghost" id="exportRanges">${ICON.down}Export CSV</button></div>
  </div>`;
  for (const td of view.querySelectorAll('td.h')) {
    const go = () => set({ site: td.dataset.site, start: mdKey(+td.dataset.m, 15), tab: 'planner', book: '', year: '', day: '' }, { push: true });
    td.addEventListener('click', go);
    td.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  $('exportRanges').addEventListener('click', () => download('range-months.csv', C.toCSV(table.map((t) => ({ range: t.sm.name, ...Object.fromEntries(t.monthly.map((v, i) => [MONTHS[i], v])), launchable_days: t.go.toFixed(3), season_blind_days: t.flat, heldout_coverage: t.cov.toFixed(3) })))));
}

// ---------------- schedule (state-changing actions) ----------------
function planYearValue() { return +(localStorage.getItem(STORE + '/year') || 2027); }
function saveSchedule() { try { localStorage.setItem(STORE, JSON.stringify(schedule)); } catch { toast('Could not save to this browser'); } }
function loadSchedule() { try { const v = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(v) ? v.filter((x) => x && x.site && x.start) : []; } catch { return []; } }
let planUI = { K: 4, gap: 60, earliest: '01-15', latest: '12-15', result: null };

function scheduleView(site) {
  const yr = planYearValue();
  const rows = schedule.map((it) => {
    const sm = META.sites.find((x) => x.slug === it.site);
    const [m, d] = parseStart(it.start);
    return `<tr><td style="font-weight:500">${esc(sm ? sm.name : it.site)}</td><td>${fmtDate(it.year, m, d)}</td><td>${fmtDate(it.year, m, d, it.book - 1)}</td><td class="num">${it.book}</td><td class="num">${it.median}</td><td class="num">${it.flights}</td><td class="num">${it.conf}%</td>
      <td><button class="tag ${it.status === 'Confirmed' ? 'white' : it.status === 'Requested' ? 'blue' : ''}" data-status="${it.id}" style="cursor:pointer" title="Advance status">${it.status}</button></td>
      <td style="text-align:right"><button class="linkbtn muted" data-del="${it.id}" aria-label="Remove ${esc(sm ? sm.name : it.site)} ${fmtMD(m, d)}">Remove</button></td></tr>`;
  }).join('');
  const total = schedule.reduce((a, x) => a + x.book, 0);
  const pr = planUI.result;
  const planBlock = !site ? '<div class="skeleton" style="height:120px;margin-top:14px"></div>' : `
    <div class="fields" style="grid-template-columns:repeat(4,1fr) auto;align-items:end;margin-top:14px">
      <div class="field"><label for="pK">Campaigns</label><input class="input" id="pK" type="number" min="1" max="6" value="${planUI.K}"></div>
      <div class="field"><label for="pGap">Min. gap between arrivals</label><div class="unit"><input class="input" id="pGap" type="number" min="1" max="180" value="${planUI.gap}"><span>days</span></div></div>
      <div class="field"><label for="pE">Earliest arrival</label><input class="input" id="pE" value="${fmtMD(...parseStart(planUI.earliest))}"></div>
      <div class="field"><label for="pL">Latest arrival</label><input class="input" id="pL" value="${fmtMD(...parseStart(planUI.latest))}"></div>
      <button class="btn" id="optimise">Optimise</button>
    </div>
    ${pr ? `<table style="margin-top:14px"><thead><tr><th>Plan</th>${pr.opt.days.map((_, i) => `<th>Campaign ${i + 1}</th>`).join('')}<th class="num">Range days booked</th></tr></thead><tbody>
      <tr class="sel"><td style="font-weight:500">Optimal (exact DP)</td>${pr.opt.days.map((dd) => { const [m, d] = C.monthDayOfDoy(dd); return `<td>${fmtMD(m, d)} · ${pr.cost[dd - 1]} d</td>`; }).join('')}<td class="num">${fmtDays(pr.opt.total)}</td></tr>
      <tr><td style="font-weight:500">Evenly spaced from earliest</td>${pr.even.days.map((dd) => { if (dd > 365) return '<td class="muted">past year end</td>'; const [m, d] = C.monthDayOfDoy(dd); return `<td>${fmtMD(m, d)} · ${fmtDays(pr.cost[dd - 1])} d</td>`; }).join('')}<td class="num">${fmtDays(pr.even.total)}</td></tr></tbody></table>
      <div class="actions" style="margin-top:12px"><button class="btn" id="applyPlan" ${pr.opt.days.length ? '' : 'disabled'}>${ICON.plus}Apply optimal plan to schedule</button><span class="muted">${Number.isFinite(pr.even.total) && Number.isFinite(pr.opt.total) ? `Saves ${pr.even.total - pr.opt.total} range days (${pct((pr.even.total - pr.opt.total) / pr.even.total)}) at the same ${state.conf}% confidence per campaign.` : ''}</span></div>` : ''}`;
  return `
  <div class="section">
    <div class="section-head"><span>Requested range windows · ${yr}</span><span class="actions"><label class="muted" for="yearSel" style="font-weight:400">Year</label><select class="input" id="yearSel" style="width:90px;height:28px">${[2026, 2027, 2028].map((y) => `<option${y === yr ? ' selected' : ''}>${y}</option>`).join('')}</select><button class="btn ghost" id="expCsv" ${schedule.length ? '' : 'disabled'}>${ICON.down}CSV</button><button class="btn ghost" id="expJson" ${schedule.length ? '' : 'disabled'}>${ICON.down}JSON</button></span></div>
    ${schedule.length ? `<table><thead><tr><th>Range</th><th>Arrive</th><th>Booking ends</th><th class="num">Days</th><th class="num">Median</th><th class="num">Flights</th><th class="num">Conf.</th><th>Status</th><th></th></tr></thead><tbody>${rows}
      <tr><td style="font-weight:500">Total</td><td></td><td></td><td class="num" style="font-weight:500">${total}</td><td colspan="5"></td></tr></tbody></table>`
    : `<div class="state"><div class="big">No range windows yet.</div><p class="muted" style="margin:0">Add one from the Planner (<kbd>A</kbd>) or let the optimiser below pick a year's arrivals.</p></div>`}
  </div>
  <div class="section">
    <div class="section-head"><span>Optimise a year at ${site ? esc(site.name) : '…'}</span><span class="muted">Picks arrival dates that minimise total booked range days, each campaign at ${state.conf}% confidence</span></div>
    ${planBlock}
  </div>`;
}
function bindSchedule(site) {
  $('yearSel')?.addEventListener('change', (e) => { localStorage.setItem(STORE + '/year', e.target.value); schedule = schedule.map((x) => ({ ...x, year: +e.target.value })); saveSchedule(); render(); });
  for (const b of document.querySelectorAll('[data-status]')) b.addEventListener('click', () => {
    const order = ['Proposed', 'Requested', 'Confirmed'];
    schedule = schedule.map((x) => x.id === b.dataset.status ? { ...x, status: order[(order.indexOf(x.status) + 1) % 3] } : x);
    saveSchedule(); render();
  });
  for (const b of document.querySelectorAll('[data-del]')) b.addEventListener('click', () => { schedule = schedule.filter((x) => x.id !== b.dataset.del); saveSchedule(); toast('Removed'); render(); });
  $('expCsv')?.addEventListener('click', () => exportSchedule('csv'));
  $('expJson')?.addEventListener('click', () => exportSchedule('json'));
  if (!site) return;
  $('optimise').addEventListener('click', () => {
    const e = parseStart($('pE').value), l = parseStart($('pL').value);
    if (!e || !l) { toast('Use dates like 15 Jan'); return; }
    planUI = { K: Math.max(1, Math.min(6, Math.round(+$('pK').value || 1))), gap: Math.max(1, Math.min(180, Math.round(+$('pGap').value || 60))), earliest: mdKey(...e), latest: mdKey(...l), result: null };
    const cost = curveOf(site, state).map((c) => c.book);
    const E = C.doyOf(...e), Lt = C.doyOf(...l);
    if (Lt < E) { toast('Latest arrival must be after the earliest'); return; }
    planUI.result = { cost, opt: C.planYear(cost, planUI.K, planUI.gap, E, Lt), even: C.evenPlan(cost, planUI.K, planUI.gap, E) };
    if (!planUI.result.opt.days.length) toast('No feasible plan: widen the dates or shorten the gap');
    render();
  });
  $('applyPlan')?.addEventListener('click', () => { if (addToSchedule(site, planUI.result.opt.days)) render(); });
}
function scheduleRows() {
  return schedule.map((x) => { const [m, d] = parseStart(x.start); return { range: META.sites.find((s) => s.slug === x.site)?.name || x.site, arrive: fmtDate(x.year, m, d), booking_ends: fmtDate(x.year, m, d, x.book - 1), days: x.book, median_days: x.median, flights: x.flights, confidence: x.conf, status: x.status }; });
}
function exportSchedule(kind) {
  if (kind === 'json') download('range-windows.json', JSON.stringify({ exported: new Date().toISOString(), windows: schedule }, null, 2), 'application/json');
  else download('range-windows.csv', C.toCSV(scheduleRows()));
}

// ---------------- method ----------------
function methodView(site) {
  const s = state;
  const { bt, flat, btFlat } = backtestOf(site, s);
  return `
  <div class="section two">
    <div class="prose">
      <div class="section-head" style="margin-bottom:14px"><span>How the booking length is computed</span></div>
      <h3>1 · Launchable days</h3>
      <p>For each day from 2010 to 2024 we take the hourly ERA5 reanalysis at the range's grid cell and mark an hour green when wind, gusts, rain and low cloud are all under the limits on the left (and the sun is up, if daylight is required; NOAA solar-position equations). A day is launchable if it has ${s.run} or more consecutive green hours inside the ops window.</p>
      <h3>2 · Replay the campaign</h3>
      <p>Arrive on the date, spend ${s.setup} setup days, then fly on the first launchable day; after each flight the pad needs ${s.turn} days before the next. Flying at the first opportunity is provably the fastest way to finish (exchange argument; checked against brute force in the tests). Pack-down adds ${s.tear} days. We replay this for every year and for arrivals up to ${JITTER} days either side of the date.</p>
      <h3>3 · Book with a guarantee</h3>
      <p>Replays from the same year are correlated, so treating them as independent overstates confidence. The booking length is a hierarchical conformal bound (Lee, Barber &amp; Willett 2023): the smallest <i>t</i> with <code>Σ<sub>years</sub> F<sub>year</sub>(t) / (K + 1) ≥ ${(s.conf / 100).toFixed(2)}</code>, with K = 15 years. If years are exchangeable, a campaign in a new year finishes within the booking with probability at least ${s.conf}%.</p>
      <h3>4 · Plan the year</h3>
      <p>The Schedule tab picks K arrival dates at least G days apart that minimise total booked days, by exact dynamic programming over the 365 arrival dates (O(K·365)).</p>
      <h3>Limits</h3>
      <p>ERA5 is a ~30 km reanalysis: it smooths coastal gusts and has no visibility, upper-level wind or sea-state. The launch commit criteria here are assumptions, not Hypersonica's. Range availability, NOTAMs and hardware slips are not modelled. The guarantee is about weather given the criteria; 15 years is a small sample, so the backtest below matters more than the theorem.</p>
    </div>
    <div>
      <div class="section-head"><span>Backtest · ${esc(site.name)}</span><span class="muted">calibrate 2010–2019, test 2020–2024</span></div>
      <table style="margin-top:6px"><thead><tr><th>Rule</th><th class="num">Avg booked</th><th class="num">Finished</th><th class="num">Worst month</th></tr></thead><tbody>
        <tr class="sel"><td style="font-weight:500">Per date (this planner)</td><td class="num">${bt.meanBooked.toFixed(1)} d</td><td class="num">${pct(bt.coverage, 1)}</td><td class="num">${pct(Math.min(...bt.byMonth))}</td></tr>
        <tr><td style="font-weight:500">Season-blind</td><td class="num">${fmtDays(flat)} d</td><td class="num">${pct(btFlat.coverage, 1)}</td><td class="num">${pct(Math.min(...btFlat.byMonth))}</td></tr></tbody></table>
      <p class="muted" style="margin-top:10px">${bt.total} held-out campaigns (one per arrival date per test year). Target: ${s.conf}%.</p>
      <div class="section-head" style="margin-top:24px"><span>Held-out coverage by arrival month</span></div>
      <table><tbody>${bt.byMonth.map((v, i) => `<tr><td>${MONTHS[i]}</td><td class="num">${pct(v)}</td><td style="width:55%"><div style="height:6px;background:#262626;border-radius:1px"><div style="height:6px;width:${(100 * v).toFixed(0)}%;background:${v >= s.conf / 100 ? '#fff' : '#3341c2'};border-radius:1px"></div></div></td></tr>`).join('')}</tbody></table>
      <div class="actions" style="margin-top:12px"><button class="btn ghost" id="exportMethod">${ICON.down}Export backtest CSV</button></div>
    </div>
  </div>`;
}
function bindMethod(site) { $('exportMethod').addEventListener('click', () => exportCurrent(site)); }

function exportCurrent(site) {
  const s = state;
  if (s.tab === 'planner') {
    download(`booking-curve-${s.site}.csv`, C.toCSV(curveOf(site, s).map((c) => ({ arrive: fmtMD(c.m, c.d), book_days: c.book, median_days: c.median, replays: c.n, never_finished: c.fail }))));
  } else if (s.tab === 'replay') {
    const [m, d] = parseStart(s.start);
    download(`replays-${s.site}-${s.start}.csv`, C.toCSV(C.startReplays(site, launchable(site, s), m, d, specOf(s), { years: YEARS, jitter: 0 }).map((r) => ({ year: r.year, launch_days: r.launches.map((t) => t + 1).join(' '), days_used: r.days }))));
  } else if (s.tab === 'method') {
    const { bt } = backtestOf(site, s);
    download(`backtest-${s.site}.csv`, C.toCSV(bt.byMonth.map((v, i) => ({ month: MONTHS[i], heldout_coverage: v.toFixed(4) }))));
  } else if (s.tab === 'schedule') exportSchedule('csv');
  else if (s.tab === 'ranges') $('exportRanges')?.click();
}

// ---------------- keyboard ----------------
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('help').classList.remove('on'); return; }
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') { $('help').classList.toggle('on'); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!['planner', 'replay'].includes(state.tab)) return;
      e.preventDefault();
      const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1);
      set({ start: startOfDoy(doyOfStart(state) + step), book: '', day: '' });
    } else if (e.key === '[' || e.key === ']') {
      const i = META.sites.findIndex((x) => x.slug === state.site);
      const n = META.sites.length;
      set({ site: META.sites[(i + (e.key === ']' ? 1 : -1) + n) % n].slug, book: '', year: '', day: '' });
    } else if (/^[1-5]$/.test(e.key)) set({ tab: TABS[+e.key - 1] }, { push: true });
    else if (e.key === 'a' || e.key === 'A') { if (state.tab === 'planner') SITES.get(state.site)?.then((site) => addToSchedule(site)); }
    else if (e.key === 'e' || e.key === 'E') SITES.get(state.site)?.then((site) => exportCurrent(site));
  });
}

// ---------------- boot ----------------
async function boot() {
  const view = $('view');
  view.innerHTML = loadingView('Booking length by arrival date');
  try {
    [META, RESULTS] = await Promise.all([fetchJSON('data/sites.json'), fetchJSON('data/results.json').catch(() => null)]);
  } catch (e) {
    view.innerHTML = errorView(e);
    $('retry').addEventListener('click', () => location.reload());
    return;
  }
  schedule = loadSchedule();
  bindInputs();
  bindKeys();
  state = readHash();
  window.addEventListener('hashchange', () => { state = readHash(); render(); });
  window.addEventListener('popstate', () => { state = readHash(); render(); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.tab === 'planner') SITES.get(state.site)?.then(drawChart); }, 120); });
  await render();
  document.documentElement.dataset.ready = '1';
}
boot();
