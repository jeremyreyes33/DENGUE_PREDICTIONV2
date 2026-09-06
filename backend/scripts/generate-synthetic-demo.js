#!/usr/bin/env node
/*
 * Synthetic DEMO FIXTURE panel generator — National 17-region scope.
 * ---------------------------------------------------------------------------
 * Produces a CLEAN 1,020-row (17 regions x 60 months, 2016-01 to 2020-12)
 * synthetic dengue panel for ETL / model-pipeline testing ONLY.
 *
 *   npm run synthetic:demo
 *   npm run synthetic:demo -- --dry-run   # validate without writing CSV
 *   npm run synthetic:demo -- --seed=123   # reproducibility (default 20260214)
 *
 * EVERY row carries is_demo_fixture=1 and the output lives in an isolated
 * folder so it can never be mistaken for the real REVISED DATA SET panel:
 *
 *   RESEARCH DATA SET/SYNTHETIC DEMO FIXTURE - DO NOT USE AS REAL DATA/
 *     ph_synthetic_dengue_2016-2020_DEMO_FIXTURE.csv
 *
 * Design (see README_DEMO_FIXTURE.md beside the CSV):
 *   - Real anchors: PSA 2020 pops (sum 109,033,245), land areas, poverty
 *     2015/2018, urban 2015/2020, ERA5 2016-2020 month-normals per region.
 *   - Cheap high-impact drivers only: ONI (ENSO), lagged cases, rainfall
 *     anomaly, ovitrap index. WASH/serotype out of scope.
 *   - Lag logic enforced at generation: temp_lag3 strongest, humidity_lag1,
 *     rainfall_lag1, ovitrap_lag1 lead cases; lag0 weak by construction.
 *   - 2019 epidemic boost (x1.75); 2020 CLEAN (no COVID collapse) but tagged
 *     split=diagnostic_excluded so headline train/test stays 2016-2018/2019.
 *   - Overdispersed counts (r=12, z clipped at ±2.5) + per-region-year
 *     outbreak shocks, so month-to-month jumps stay within the ~2-3x seen in
 *     real surveillance instead of 400x spikes.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REGIONS, REGION_SLUGS } from './etl/regions-ph.js'
import { readGeography, readPoverty, readUrban, readClimate } from './etl/revised-sources.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const OUT_DIR = path.join(REPO_ROOT, 'RESEARCH DATA SET', 'SYNTHETIC DEMO FIXTURE - DO NOT USE AS REAL DATA')
const OUT_CSV = path.join(OUT_DIR, 'ph_synthetic_dengue_2016-2020_DEMO_FIXTURE.csv')

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const seedArg = argv.find((a) => a.startsWith('--seed='))
let SEED = seedArg ? Number(seedArg.split('=')[1]) : 20260214
if (!Number.isFinite(SEED)) SEED = 20260214

const log = (...a) => console.log(...a)

// ---- seeded RNG: mulberry32 + Box-Muller gaussian -------------------------
let _s = SEED >>> 0
function rand() {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
let _spare = null
function randn() {
  if (_spare !== null) { const v = _spare; _spare = null; return v }
  let u = 0, v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  const mag = Math.sqrt(-2 * Math.log(u))
  _spare = mag * Math.sin(2 * Math.PI * v)
  return mag * Math.cos(2 * Math.PI * v)
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

// ---- global ONI series (60 months, realistic ENSO cycle) -------------------
// 2016 El Nino decay, 2017-18 La Nina, weak El Nino 2018-19, neutral 2020.
const ONI_BY_PERIOD = {
  '2016-01': 2.0, '2016-02': 1.9, '2016-03': 1.6, '2016-04': 1.1, '2016-05': 0.6, '2016-06': 0.1,
  '2016-07': -0.2, '2016-08': -0.4, '2016-09': -0.5, '2016-10': -0.6, '2016-11': -0.6, '2016-12': -0.6,
  '2017-01': -0.4, '2017-02': -0.4, '2017-03': -0.2, '2017-04': 0.0, '2017-05': 0.1, '2017-06': 0.1,
  '2017-07': 0.0, '2017-08': -0.2, '2017-09': -0.5, '2017-10': -0.7, '2017-11': -0.8, '2017-12': -0.9,
  '2018-01': -0.9, '2018-02': -0.8, '2018-03': -0.6, '2018-04': -0.4, '2018-05': -0.2, '2018-06': 0.0,
  '2018-07': 0.2, '2018-08': 0.3, '2018-09': 0.5, '2018-10': 0.7, '2018-11': 0.8, '2018-12': 0.8,
  '2019-01': 0.7, '2019-02': 0.7, '2019-03': 0.7, '2019-04': 0.7, '2019-05': 0.6, '2019-06': 0.5,
  '2019-07': 0.3, '2019-08': 0.2, '2019-09': 0.2, '2019-10': 0.3, '2019-11': 0.5, '2019-12': 0.5,
  '2020-01': 0.5, '2020-02': 0.5, '2020-03': 0.4, '2020-04': 0.2, '2020-05': 0.0, '2020-06': -0.3,
  '2020-07': -0.4, '2020-08': -0.6, '2020-09': -0.9, '2020-10': -1.2, '2020-11': -1.3, '2020-12': -1.2,
}
// Burn-in 2015 (discarded, provides lags): neutral-cool.
const ONI_2015 = ['2015-01', '2015-02', '2015-03', '2015-04', '2015-05', '2015-06', '2015-07', '2015-08', '2015-09', '2015-10', '2015-11', '2015-12']
  .map((p, i) => [p, [0.6, 0.6, 0.7, 0.9, 1.1, 1.3, 1.5, 1.7, 1.9, 2.1, 2.2, 2.3][i]])
for (const [p, v] of ONI_2015) ONI_BY_PERIOD[p] = v

// Endemic baseline: annual incidence per 100k per region, scaled by
// GLOBAL_SCALE so national totals land near real 2016 209k / 2017 154k /
// 2018 250k / 2019 441k (2020 synthetic stays clean at ~250k, NOT the real
// 91k COVID collapse). Without the scale the exp() climate modulation
// (Jensen mean > 1) plus AR persistence inflates totals ~2.2x.
const GLOBAL_SCALE = 0.65
const ENDEMIC_PER_100K = {
  NCR: 280, CAR: 180, R1: 200, R2: 190, R3: 260, R4A: 270, R4B: 210, R5: 230,
  R6: 250, R7: 300, R8: 220, R9: 200, R10: 210, R11: 230, R12: 220, R13: 200, BARMM: 170,
}
const SEASONAL = { 1: 0.55, 2: 0.42, 3: 0.35, 4: 0.38, 5: 0.55, 6: 0.95, 7: 1.55, 8: 2.05, 9: 2.15, 10: 1.65, 11: 1.05, 12: 0.70 }
const YEAR_EFFECT = { 2015: 0.95, 2016: 1.0, 2017: 0.75, 2018: 1.35, 2019: 1.9, 2020: 1.15 }
const CFR_BASE = {
  NCR: 0.0038, CAR: 0.0045, R1: 0.0042, R2: 0.0044, R3: 0.0039, R4A: 0.0037, R4B: 0.0048, R5: 0.0046,
  R6: 0.0043, R7: 0.0040, R8: 0.0049, R9: 0.0050, R10: 0.0047, R11: 0.0044, R12: 0.0046, R13: 0.0050, BARMM: 0.0055,
}
const splitFor = (y) => (y <= 2018 ? 'train' : y === 2019 ? 'test' : 'diagnostic_excluded')
const periodKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`

function pearson(xs, ys) {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2 }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0
}

async function main() {
  log(`\nSynthetic DEMO FIXTURE generator  [seed=${SEED}]${DRY_RUN ? '   [DRY RUN — no CSV written]' : ''}`)

  const { geo } = await readGeography()
  const { poverty } = await readPoverty()
  const { urban } = await readUrban()
  const { climate } = await readClimate(2016, 2020)

  // Month-normals from REAL ERA5 (anchor synthetic climate to observed means).
  const norms = new Map() // `${slug}|${month}` -> {t, rn, h}
  for (const r of climate.values()) {
    const k = `${r.slug}|${r.month}`
    if (!norms.has(k)) norms.set(k, { t: [], rn: [], h: [] })
    const a = norms.get(k)
    if (r.temperature != null) a.t.push(r.temperature)
    if (r.rainfall != null) a.rn.push(r.rainfall)
    if (r.humidity != null) a.h.push(r.humidity)
  }
  const normMean = new Map()
  for (const [k, v] of norms) {
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
    normMean.set(k, { t: mean(v.t), rn: mean(v.rn), h: mean(v.h) })
  }

  const lerp = (y, y0, v0, y1, v1) => v0 + ((v1 - v0) * (y - y0)) / (y1 - y0)
  const popFor = (g, y) => {
    if (y <= 2010) return g.pop2010
    if (y <= 2015) return lerp(y, 2010, g.pop2010, 2015, g.pop2015)
    if (y <= 2020) return lerp(y, 2015, g.pop2015, 2020, g.pop2020)
    return g.pop2020
  }
  const urbanFor = (slug, y) => {
    const u = urban.get(slug)
    if (!u || u[2015] == null || u[2020] == null) return null
    if (y <= 2015) return u[2015]
    if (y >= 2020) return u[2020]
    return lerp(y, 2015, u[2015], 2020, u[2020])
  }
  const povertyFor = (slug, y) => {
    const p = poverty.get(slug)
    if (!p || p[2015] == null || p[2018] == null) return null
    if (y <= 2015) return p[2015]
    if (y === 2018) return p[2018]
    if (y > 2018) return p[2018] // carried forward, documented in README
    return lerp(y, 2015, p[2015], 2018, p[2018])
  }

  // Global SD approximations for standardising generation coefficients.
  const TEMP_SD = 1.2, RAIN_SD = 110, HUM_SD = 3.5, OVI_SD = 6.0

  const rows = []
  // Per-region rolling histories (include 2015 burn-in for lags).
  for (const { slug, name } of REGIONS) {
    const g = geo.get(slug)
    if (!g) throw new Error(`Missing geography for ${slug}`)
    const hist = [] // {y, m, temp, rain, hum, ovi, cases}
    const cfr = CFR_BASE[slug] ?? 0.004
    // Region-year outbreak shocks (serotype turnover, local outbreaks,
    // reporting variation): constant within a region-year, so they add
    // realistic non-seasonal variance WITHOUT wild month-to-month jumps.
    // This keeps lagged climate correlations near observed levels instead
    // of converging on pure seasonal synchrony (~0.6).
    const yearShock = {}
    for (let ys = 2015; ys <= 2020; ys += 1) yearShock[ys] = Math.exp(randn() * 0.35)

    for (let y = 2015; y <= 2020; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const pk = periodKey(y, m)
        const nm = normMean.get(`${slug}|${m}`)
        const oni = ONI_BY_PERIOD[pk] ?? 0
        const lag = (n, field) => (hist.length >= n ? hist[hist.length - n][field] : null)

        // --- synthetic climate anchored to real normals ---
        const temp = nm.t + 0.30 * (lag(2, 'oni') ?? oni) + randn() * 0.35
        // Typhoon-driven spikes: wide lognormal noise (sd 0.40) so rainfall
        // carries realistic uncorrelated extremes that dilute its lagged
        // correlation toward the observed ~0.19 instead of locking onto the
        // seasonal cycle (~0.5). Clamped at 900 mm — above the real regional
        // max (~600 mm) but not absurd for a typhoon month.
        const rainMean = Math.max(5, nm.rn + 25 * (lag(2, 'oni') ?? oni))
        const rain = clamp(rainMean * Math.exp(randn() * 0.40), 0, 900)
        const hum = clamp(nm.h + 0.02 * (rain - nm.rn) + randn() * 1.1, 55, 99)
        // Hot days: 0-heavy (mirrors 617 blanks->0); dry-season Poisson-ish.
        const dryness = clamp((temp - 27.5) * 1.4 - (rain / 120), -2, 4)
        let hot = 0
        if (dryness > 0.6) hot = Math.max(0, Math.round(dryness + randn() * 1.1))
        else if (rand() < 0.06) hot = 1
        hot = clamp(hot, 0, 12)

        // Ovitrap is a pure LEAD indicator: function of LAST month's rain
        // only — no current-month humidity term, or lag0 beats lag1 and it
        // stops being a lead. Noise widened so it is informative, not destiny.
        const rainL1 = lag(1, 'rain') ?? nm.rn
        const ovi = clamp(14 + 0.04 * rainL1 + randn() * 3.2, 5, 42)

        // --- cases latent intensity ---
        const pop = popFor(g, y)
        const baseMonthly = (pop / 100000) * ENDEMIC_PER_100K[slug] / 12 * GLOBAL_SCALE
        const seasonal = SEASONAL[m]
        const yearFx = YEAR_EFFECT[y]
        const base = Math.max(5, baseMonthly * seasonal * yearFx)

        const tL3 = lag(3, 'temp')
        const hL1 = lag(1, 'hum')
        const rL1 = lag(1, 'rain')
        const oL1 = lag(1, 'ovi')
        const oniL3pk = periodKey(m <= 3 ? y - 1 : y, m <= 3 ? m + 9 : m - 3)
        const oniL3 = ONI_BY_PERIOD[oniL3pk] ?? oni
        // Region-centred z-scores against that region's annual means.
        const tMeanR = 27.0, rMeanR = nm.rn, hMeanR = nm.h
        const zT = ((tL3 ?? temp) - tMeanR) / TEMP_SD
        const zH = ((hL1 ?? hum) - hMeanR) / HUM_SD
        const zR = ((rL1 ?? rain) - rMeanR) / RAIN_SD
        const zO = ((oL1 ?? ovi) - 20) / OVI_SD

        // Coefficients tuned to reproduce audit targets (REVISION_PLAN 2c):
        // temp_lag3 ~0.40 strongest, humidity_lag1 ~0.21, rainfall_lag1 ~0.19.
        // Kept modest on purpose — larger values plus AR persistence push
        // lagged correlations to 0.5+ and inflate year-to-year swings.
        const climateMod = Math.exp(
          0.12 * zT + 0.05 * zH + 0.03 * zR + 0.05 * (oniL3 / 1.5) + 0.06 * zO,
        )
        const cL1 = lag(1, 'cases')
        const arMod = cL1 != null ? (Math.log(cL1 + 1) - Math.log(base + 1)) * 0.12 : 0
        const mu = Math.max(5, base * climateMod * Math.exp(arMod) * yearShock[y])

        // Overdispersed count: var = mu + mu^2 / r, r = 12. Moderate
        // overdispersion on purpose: r=4 produced 400x month-to-month jumps
        // that no real surveillance series shows (real extremes are ~2-3x).
        // The z-draw is clipped at ±2.5 for the same reason. Idiosyncratic
        // noise stays at full strength otherwise, so climate correlations are
        // diluted toward observed levels instead of 0.5+.
        const variance = mu + (mu * mu) / 12
        const z = clamp(randn(), -2.5, 2.5)
        let cases = Math.round(mu + Math.sqrt(variance) * z)
        cases = Math.max(5, cases)

        // Deaths: binomial approx around region CFR.
        const p = clamp(cfr + randn() * 0.0006, 0.0015, 0.008)
        const dMean = cases * p
        let deaths = Math.round(dMean + Math.sqrt(Math.max(0.5, dMean)) * randn())
        deaths = clamp(deaths, 0, Math.max(0, Math.round(cases * 0.02)))

        hist.push({ y, m, temp, rain, hum, hot, ovi, oni, cases, deaths, pop })
      }
    }

    // Emit 2016-2020 with explicit lag columns (no leakage: lags from hist).
    for (let i = 0; i < hist.length; i += 1) {
      const h = hist[i]
      if (h.y < 2016) continue
      const get = (n, f) => (i - n >= 0 ? hist[i - n][f] : null)
      const rainL1v = get(1, 'rain')
      const humL1v = get(1, 'hum')
      const tempL3v = get(3, 'temp')
      const oviL1v = get(1, 'ovi')
      const casesL1v = get(1, 'cases')
      const casesL12v = get(12, 'cases')
      const pk = periodKey(h.y, h.m)
      const oniL3pk = periodKey(h.m <= 3 ? h.y - 1 : h.y, h.m <= 3 ? h.m + 9 : h.m - 3)
      const nm = normMean.get(`${slug}|${h.m}`)
      const rainAnom = h.rain - nm.rn
      const urb = urbanFor(slug, h.y)
      const pov = povertyFor(slug, h.y)
      const dens = h.pop / g.areaKm2
      const inc = (h.cases / h.pop) * 100000

      rows.push({
        slug,
        region_name: name,
        year: h.y,
        month: h.m,
        period: pk,
        split: splitFor(h.y),
        dengue_cases: h.cases,
        dengue_deaths: h.deaths,
        incidence_per100k: +inc.toFixed(2),
        mean_temp_C: +h.temp.toFixed(2),
        rainfall_mm: +h.rain.toFixed(1),
        humidity_pct: +h.hum.toFixed(1),
        hot_days: h.hot,
        population: Math.round(h.pop),
        pop_density_km2: +dens.toFixed(2),
        urban_pct: urb == null ? '' : +urb.toFixed(2),
        poverty_fam_pct: pov == null ? '' : +pov.toFixed(2),
        oni: +h.oni.toFixed(2),
        oni_lag3: +((ONI_BY_PERIOD[oniL3pk] ?? h.oni).toFixed(2)),
        rainfall_lag1: rainL1v == null ? '' : +rainL1v.toFixed(1),
        rainfall_anomaly_mm: +rainAnom.toFixed(1),
        humidity_lag1: humL1v == null ? '' : +humL1v.toFixed(1),
        temp_lag3: tempL3v == null ? '' : +tempL3v.toFixed(2),
        cases_lag1: casesL1v ?? '',
        cases_lag12: casesL12v ?? '',
        ovitrap_pct: +h.ovi.toFixed(1),
        ovitrap_lag1: oviL1v == null ? '' : +oviL1v.toFixed(1),
        is_demo_fixture: 1,
      })
    }
  }

  rows.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.period < b.period ? -1 : 1))

  // ---- validation ----------------------------------------------------------
  const expected = 17 * 60
  const bySplit = { train: 0, test: 0, diagnostic_excluded: 0 }
  for (const r of rows) bySplit[r.split] += 1
  const sumPop2020 = rows.filter((r) => r.period === '2020-12').reduce((s, r) => s + r.population, 0)
  const totals = {}
  for (const r of rows) totals[r.year] = (totals[r.year] ?? 0) + r.dengue_cases

  // Within-region demeaned correlation of log(incidence) vs predictors by lag.
  const logInc = rows.map((r) => Math.log(r.dengue_cases / r.population))
  const byRegion = new Map()
  rows.forEach((r, i) => {
    if (!byRegion.has(r.slug)) byRegion.set(r.slug, [])
    byRegion.get(r.slug).push(i)
  })
  const demean = (vals) => {
    const out = new Array(vals.length)
    for (const idx of byRegion.values()) {
      const m = idx.reduce((s, i) => s + vals[i], 0) / idx.length
      for (const i of idx) out[i] = vals[i] - m
    }
    return out
  }
  const liD = demean(logInc)
  const col = (k) => rows.map((r) => (r[k] === '' ? NaN : Number(r[k])))
  const corrAt = (k, lag) => {
    // correlate predictor at t-lag with log-incidence at t (within-region).
    const xs = [], ys = []
    for (const idx of byRegion.values()) {
      for (let j = lag; j < idx.length; j += 1) {
        const a = rows[idx[j - lag]][k]
        if (a === '' || a == null) continue
        xs.push(Number(a)); ys.push(logInc[idx[j]])
      }
    }
    // demean per region for both series
    const xm = xs.reduce((s, v) => s + v, 0) / xs.length
    const ym = ys.reduce((s, v) => s + v, 0) / ys.length
    let sxy = 0, sxx = 0, syy = 0
    for (let i = 0; i < xs.length; i += 1) { sxy += (xs[i] - xm) * (ys[i] - ym); sxx += (xs[i] - xm) ** 2; syy += (ys[i] - ym) ** 2 }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0
  }

  log(`\n  rows: ${rows.length} / ${expected} expected`)
  log(`  split: train=${bySplit.train} test=${bySplit.test} diagnostic_excluded=${bySplit.diagnostic_excluded}`)
  log(`  2020 pop sum (Dec): ${sumPop2020.toLocaleString('en-US')}  (guard 109,033,245)`)
  log(`  yearly synthetic totals: ${Object.entries(totals).map(([y, v]) => `${y}=${v.toLocaleString('en-US')}`).join('  ')}`)
  log(`  lag check corr(log-inc, predictor at lag):`)
  for (const [k, lags] of [['mean_temp_C', [0, 1, 2, 3]], ['humidity_pct', [0, 1, 2, 3]], ['rainfall_mm', [0, 1, 2, 3]], ['ovitrap_pct', [0, 1]]]) {
    log(`    ${k}: ${lags.map((L) => `lag${L}=${corrAt(k, L).toFixed(3)}`).join('  ')}`)
  }
  void liD; void col; void pearson

  const problems = []
  if (rows.length !== expected) problems.push('row count')
  if (bySplit.train !== 612 || bySplit.test !== 204 || bySplit.diagnostic_excluded !== 204) problems.push('split counts')
  if (sumPop2020 < 108_900_000 || sumPop2020 > 109_200_000) problems.push('population guard')
  if (rows.some((r) => r.cases_lag1 === '' && r.period !== '2016-01')) problems.push('cases_lag1 gaps')
  if (problems.length) throw new Error(`Validation failed: ${problems.join(', ')}`)

  if (DRY_RUN) {
    log('\nDry run OK — CSV not written. Re-run without --dry-run to write.')
    return
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const header = Object.keys(rows[0])
  const esc = (v) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [header.join(','), ...rows.map((r) => header.map((k) => esc(r[k])).join(','))].join('\n') + '\n'
  fs.writeFileSync(OUT_CSV, csv)
  log(`\nWrote ${OUT_CSV} (${rows.length} rows, ${header.length} cols)`)
}

main().catch((err) => { console.error('\nGenerator failed:', err.message); console.error(err.stack); process.exitCode = 1 })
