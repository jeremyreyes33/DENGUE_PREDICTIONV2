#!/usr/bin/env node
/*
 * DEMO FIXTURES for the model-output tables added by migration 002.
 *
 *   npm run seed:fixtures
 *   npm run seed:fixtures -- --clear
 *
 * --clear DELETES exactly the runs stamped with NOTE below (em-dash text
 * matched byte-for-byte) and relies on ON DELETE CASCADE for their
 * predictions, intervals, metrics, coverage, PIT bins and effects; alerts
 * referencing them keep their rows with triggered_by set NULL. Anything with
 * different notes -- harness validation runs, real model output -- is never
 * touched. Never broaden the match (no LIKE, no substring): a loose match is
 * how a cleanup script eats real results.
 *
 * ---------------------------------------------------------------------------
 * THESE NUMBERS ARE NOT MODEL OUTPUT. They exist so the Calibration and
 * Drivers pages can be built and reviewed before the Python service exists.
 * Every run this touches is stamped:
 *
 *     model_runs.notes = 'DEMO FIXTURE — illustrative values, not a real fit'
 *
 * and the UI is expected to surface that. When the real service writes to
 * these tables, run with --clear first.
 * ---------------------------------------------------------------------------
 *
 * The shapes are chosen to be *pedagogically* honest even though the values
 * are invented — each model demonstrates a different calibration failure the
 * pages have to be able to render:
 *
 *   SARIMA   overconfident   intervals too narrow, empirical < nominal
 *   LSTM     overconfident   worse, and no real interval machinery
 *   Hybrid   well calibrated empirical ~= nominal at every level
 *
 * Feature effects use the lag structure actually measured in the panel (see
 * markdown/REVISION_PLAN.md section 2c): temperature at lag 3 strongest,
 * humidity and rainfall at lag 1, and population density indistinguishable
 * from zero — because with 17 regions it genuinely is.
 */

import { pool } from '../src/config/db.js'

const CLEAR = process.argv.includes('--clear')
const NOTE = 'DEMO FIXTURE — illustrative values, not a real fit'
const log = (...a) => console.log(...a)

const NOMINAL_LEVELS = [50, 80, 95]

/** empirical coverage per model, by nominal level */
const COVERAGE = {
  SARIMA: { 50: 34.8, 80: 61.2, 95: 78.4, width: 41.7 },
  LSTM: { 50: 31.5, 80: 57.9, 95: 74.1, width: 38.2 },
  'Bayesian-Neural Hybrid': { 50: 49.1, 80: 79.3, 95: 94.2, width: 63.5 },
}

/** PIT bins — flat = calibrated, U = overconfident */
const PIT = {
  SARIMA: [0.19, 0.11, 0.08, 0.07, 0.06, 0.06, 0.07, 0.08, 0.12, 0.16],
  LSTM: [0.22, 0.12, 0.08, 0.06, 0.05, 0.05, 0.06, 0.09, 0.13, 0.14],
  'Bayesian-Neural Hybrid': [0.11, 0.10, 0.09, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10],
}

/**
 * Global effects for the hybrid. `lo`/`hi` are the 95% credible bounds; where
 * they straddle zero the API's `crosses_zero` flag fires and the UI must show
 * the effect as not distinguishable from none.
 */
const EFFECTS = [
  { feature: 'temperature', lag: 3, mean: 0.412, lo: 0.243, hi: 0.585 },
  { feature: 'humidity', lag: 1, mean: 0.221, lo: 0.078, hi: 0.366 },
  { feature: 'rainfall', lag: 1, mean: 0.196, lo: 0.051, hi: 0.339 },
  { feature: 'cases_lag1', lag: 1, mean: 0.634, lo: 0.512, hi: 0.759 },
  { feature: 'cases_lag12', lag: 12, mean: 0.188, lo: 0.041, hi: 0.334 },
  { feature: 'hot_days', lag: 3, mean: 0.147, lo: -0.019, hi: 0.311 },
  { feature: 'population_density', lag: null, mean: -0.022, lo: -0.191, hi: 0.148 },
  { feature: 'population', lag: null, mean: -0.048, lo: -0.213, hi: 0.119 },
]

async function main() {
  log(`\nModel-output demo fixtures${CLEAR ? '  [--clear: removing, not writing]' : ''}`)
  log(`  ${NOTE}`)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // --clear deletes ONLY exact-notes fixtures (cascade handles dependents;
    // alerts keep their rows with triggered_by set NULL). Harness and real
    // runs carry different notes and are never matched: no LIKE, no substring.
    if (CLEAR) {
      const [fixtures] = await conn.query(
        'SELECT id, model_type FROM model_runs WHERE notes = ? ORDER BY id',
        [NOTE],
      )
      if (!fixtures.length) {
        await conn.commit()
        log('\n  No fixture runs found (exact notes match). Nothing removed; '
          + 'harness and real runs are never matched by --clear.')
        return
      }
      const ids = fixtures.map((r) => r.id)
      log(`\n  fixture runs to delete: ${ids.map((id, i) => `${id} (${fixtures[i].model_type})`).join(', ')}`)
      const [r] = await conn.query('DELETE FROM model_runs WHERE id IN (?)', [ids])
      await conn.commit()
      log(`\n  Deleted ${r.affectedRows} fixture run(s); dependents cascaded, `
        + 'referencing alerts kept with triggered_by set NULL.')
      return
    }

    /*
     * Seeding guard: stamp ONLY fixture-eligible runs --
     *   (a) already stamped (notes = NOTE, so re-runs are idempotent), or
     *   (b) fresh from `npm run seed` (notes NULL, one of the three seed
     *       model_types, version v1).
     * Harness runs carry their own notes; real model output carries its own
     * version and feature set. Residual risk, stated plainly: a production
     * run literally named Bayesian-Neural Hybrid / v1 / NULL-notes matches
     * (b) -- delete fixtures (now safe via --clear) before real fits land,
     * and read the stamped-ids log line below on every run.
     */
    const [runs] = await conn.query(
      'SELECT id, model_type, version, notes FROM model_runs ORDER BY id',
    )
    if (!runs.length) {
      log('\n  No model_runs found. Run `npm run seed` first.')
      return
    }

    const eligible = runs.filter((r) => r.notes === NOTE
      || (r.notes === null
        && ['SARIMA', 'LSTM', 'Bayesian-Neural Hybrid'].includes(r.model_type)
        && r.version === 'v1'))
    const skipped = runs.filter((r) => !eligible.includes(r))
    if (skipped.length) {
      log(`\n  protected ${skipped.length} non-fixture run(s), left untouched: `
        + skipped.map((r) => `${r.id} (${r.model_type})`).join(', '))
    }
    if (!eligible.length) {
      await conn.commit()
      log('\n  No fixture-eligible runs. Nothing stamped.')
      return
    }

    const ids = eligible.map((r) => r.id)
    for (const table of ['interval_coverage', 'calibration_bins', 'feature_importance']) {
      const [r] = await conn.query(`DELETE FROM ${table} WHERE model_run_id IN (?)`, [ids])
      if (r.affectedRows) log(`  cleared ${r.affectedRows} rows from ${table}`)
    }

    // The study's evaluation split, recorded on every run so the comparison is
    // reproducible — see markdown/REVISION_PLAN.md section 2b for why 2020 is out.
    await conn.query(
      `UPDATE model_runs
          SET train_start = '2016-01-01', train_end = '2018-12-01',
              test_start  = '2019-01-01', test_end  = '2019-12-01',
              horizon_months = 1,
              feature_set_json = ?,
              notes = ?
        WHERE id IN (?)`,
      [
        JSON.stringify({
          target: 'confirmed_cases',
          predictors: ['cases_lag1', 'cases_lag12', 'temperature_lag3',
            'humidity_lag1', 'rainfall_lag1', 'hot_days_lag3',
            'log_population_offset', 'population_density'],
          excluded: { '2020': 'COVID surveillance break' },
        }),
        NOTE,
        ids,
      ],
    )
    log(`\n  stamped ${ids.length} model run(s) with the 2016-2018 / 2019 split`)

    const [regions] = await conn.query(
      "SELECT id, slug FROM regions WHERE admin_level = 'region' ORDER BY slug LIMIT 6",
    )

    let cov = 0
    let pit = 0
    let fi = 0

    for (const run of eligible) {
      const c = COVERAGE[run.model_type]
      const p = PIT[run.model_type]
      if (!c || !p) continue

      for (const level of NOMINAL_LEVELS) {
        await conn.execute(
          `INSERT INTO interval_coverage
             (model_run_id, region_id, nominal_level, empirical_level, mean_width, n_obs)
           VALUES (:run, NULL, :level, :emp, :width, 204)
           ON DUPLICATE KEY UPDATE
             empirical_level = VALUES(empirical_level), mean_width = VALUES(mean_width)`,
          {
            run: run.id,
            level,
            emp: c[level],
            width: Number((c.width * (level / 95)).toFixed(2)),
          },
        )
        cov += 1

        // A few per-region rows so the UI's region breakdown has something real
        // to iterate; jittered deterministically so they are not all identical.
        for (const [i, region] of regions.entries()) {
          const jitter = ((i * 7) % 11) - 5
          await conn.execute(
            `INSERT INTO interval_coverage
               (model_run_id, region_id, nominal_level, empirical_level, mean_width, n_obs)
             VALUES (:run, :region, :level, :emp, :width, 12)
             ON DUPLICATE KEY UPDATE
               empirical_level = VALUES(empirical_level), mean_width = VALUES(mean_width)`,
            {
              run: run.id,
              region: region.id,
              level,
              emp: Math.max(0, Math.min(100, Number((c[level] + jitter).toFixed(2)))),
              width: Number((c.width * (level / 95)).toFixed(2)),
            },
          )
          cov += 1
        }
      }

      for (const [i, freq] of p.entries()) {
        await conn.execute(
          `INSERT INTO calibration_bins
             (model_run_id, bin_lower, bin_upper, observed_freq, n_obs)
           VALUES (:run, :lo, :hi, :freq, 204)
           ON DUPLICATE KEY UPDATE observed_freq = VALUES(observed_freq)`,
          { run: run.id, lo: (i / 10).toFixed(4), hi: ((i + 1) / 10).toFixed(4), freq },
        )
        pit += 1
      }

      // Feature effects only for the hybrid — it is the only model in the
      // study that produces them, which is the interpretability claim.
      if (!/hybrid/i.test(run.model_type)) continue

      for (const [rank, e] of EFFECTS.entries()) {
        await conn.execute(
          `INSERT INTO feature_importance
             (model_run_id, region_id, feature, lag_months, importance,
              ci_lower, ci_upper, method, rank_in_scope)
           VALUES (:run, NULL, :feature, :lag, :mean, :lo, :hi, 'posterior', :rank)
           ON DUPLICATE KEY UPDATE
             importance = VALUES(importance), ci_lower = VALUES(ci_lower),
             ci_upper = VALUES(ci_upper), rank_in_scope = VALUES(rank_in_scope)`,
          { run: run.id, feature: e.feature, lag: e.lag, mean: e.mean, lo: e.lo, hi: e.hi, rank: rank + 1 },
        )
        fi += 1

        for (const [i, region] of regions.entries()) {
          const shift = (((i * 13) % 17) - 8) / 100
          const mean = Number((e.mean + shift).toFixed(6))
          const half = (e.hi - e.lo) / 2
          await conn.execute(
            `INSERT INTO feature_importance
               (model_run_id, region_id, feature, lag_months, importance,
                ci_lower, ci_upper, method, rank_in_scope)
             VALUES (:run, :region, :feature, :lag, :mean, :lo, :hi, 'posterior', :rank)
             ON DUPLICATE KEY UPDATE
               importance = VALUES(importance), ci_lower = VALUES(ci_lower),
               ci_upper = VALUES(ci_upper)`,
            {
              run: run.id,
              region: region.id,
              feature: e.feature,
              lag: e.lag,
              mean,
              lo: Number((mean - half).toFixed(6)),
              hi: Number((mean + half).toFixed(6)),
              rank: rank + 1,
            },
          )
          fi += 1
        }
      }
    }

    /*
     * Alerts for the 17 study regions.
     *
     * The seeded alerts point at demo MUNICIPALITY rows, so the risk map on the
     * Alerts page had nothing to colour. These are placed by quantile of real
     * 2019 incidence per 100k — the shape is therefore true to the data even
     * though a real alert would come from the model's forecast, not from
     * history. They are attributed to the hybrid run so the page's fixture
     * banner fires.
     */
    const hybridRun = runs.find((r) => /hybrid/i.test(r.model_type))
    let alerts = 0
    if (hybridRun) {
      const [inc] = await conn.query(`
        SELECT r.id, r.slug,
               SUM(c.confirmed_cases) / MAX(d.population) * 100000 AS per100k
        FROM case_data c
        JOIN regions r          ON r.id = c.region_id AND r.admin_level = 'region'
        JOIN demographic_data d ON d.region_id = r.id AND d.year = 2019
        WHERE c.period_type = 'month' AND YEAR(c.date) = 2019
        GROUP BY r.id, r.slug
        ORDER BY per100k DESC
      `)

      await conn.query(
        'DELETE FROM alerts WHERE region_id IN (SELECT id FROM regions WHERE admin_level = \'region\')',
      )

      // Quartiles of the 17: top 4 severe, next 4 high, next 4 moderate, rest low.
      for (const [i, row] of inc.entries()) {
        const level = i < 4 ? 'severe' : i < 8 ? 'high' : i < 12 ? 'moderate' : 'low'
        await conn.execute(
          `INSERT INTO alerts (region_id, date, risk_level, triggered_by_model_run_id)
           VALUES (:id, '2019-12-01', :level, :run)`,
          { id: row.id, level, run: hybridRun.id },
        )
        alerts += 1
      }
    }

    /*
     * Demo forecasts for the 17 study regions over the 2019 test window.
     *
     * Without these the Forecast page has nothing for the study unit — the only
     * real predictions point at a demo municipality — so its region selector
     * could not be moved onto the 17 regions that the rest of the app uses.
     *
     * They are derived from the observed series with a deterministic wobble, so
     * the shape is plausible and the intervals are visibly wider in the peak
     * months. That is enough to build and review the page; it is not a model.
     */
    let preds = 0
    let ivals = 0
    if (hybridRun) {
      const [obs] = await conn.query(`
        SELECT c.region_id, c.date, c.confirmed_cases
        FROM case_data c
        JOIN regions r ON r.id = c.region_id AND r.admin_level = 'region'
        WHERE c.period_type = 'month' AND YEAR(c.date) = 2019
        ORDER BY c.region_id, c.date
      `)

      for (const [i, o] of obs.entries()) {
        const actual = Number(o.confirmed_cases)
        // deterministic ±12% wobble so a refit reproduces the same fixture
        const bias = 1 + (((i * 37) % 25) - 12) / 100
        const mean = Math.max(1, Math.round(actual * bias))
        // Uncertainty grows with the count, as a count model's would.
        const halfWidth = Math.round(Math.max(8, mean * 0.42))

        await conn.execute(
          `INSERT INTO predictions
             (model_run_id, region_id, date, predicted_cases, predicted_median,
              ci_lower, ci_upper, actual_cases)
           VALUES (:run, :region, :date, :mean, :mean, :lo, :hi, :actual)
           ON DUPLICATE KEY UPDATE
             predicted_cases = VALUES(predicted_cases),
             predicted_median = VALUES(predicted_median),
             ci_lower = VALUES(ci_lower), ci_upper = VALUES(ci_upper),
             actual_cases = VALUES(actual_cases)`,
          {
            run: hybridRun.id,
            region: o.region_id,
            date: o.date,
            mean,
            lo: Math.max(0, mean - halfWidth),
            hi: mean + halfWidth,
            actual,
          },
        )
        preds += 1

        const [[row]] = await conn.query(
          'SELECT id FROM predictions WHERE model_run_id=? AND region_id=? AND date=?',
          [hybridRun.id, o.region_id, o.date],
        )
        for (const [level, frac] of [[50, 0.34], [80, 0.70], [95, 1.0]]) {
          await conn.execute(
            `INSERT INTO prediction_intervals (prediction_id, nominal_level, lower, upper)
             VALUES (:pid, :level, :lo, :hi)
             ON DUPLICATE KEY UPDATE lower = VALUES(lower), upper = VALUES(upper)`,
            {
              pid: row.id,
              level,
              lo: Math.max(0, Math.round(mean - halfWidth * frac)),
              hi: Math.round(mean + halfWidth * frac),
            },
          )
          ivals += 1
        }
      }
    }

    await conn.commit()
    log(`  predictions         ${preds} rows (17 regions x 2019, with actuals)`)
    log(`  prediction_intervals ${ivals} rows (50/80/95% per prediction)`)
    log(`  alerts              ${alerts} rows (one per study region, by 2019 incidence quartile)`)
    log(`  interval_coverage   ${cov} rows (${NOMINAL_LEVELS.join('/')}% nominal, overall + ${regions.length} regions)`)
    log(`  calibration_bins    ${pit} rows (10 PIT bins per model)`)
    log(`  feature_importance  ${fi} rows (hybrid only, global + ${regions.length} regions)`)
    log(`\n  Remember: these are fixtures. Run with --clear before loading real output.`)
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('\nFixture seed failed:', err.message)
    await pool.end()
    process.exitCode = 1
  })
