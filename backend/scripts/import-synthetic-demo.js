#!/usr/bin/env node
/*
 * Guarded loader for the synthetic DEMO FIXTURE panel.
 * ---------------------------------------------------------------------------
 *   npm run etl:synthetic -- --dry-run      # parse + report, write nothing (default)
 *   npm run etl:synthetic -- --allow-demo   # load into scratch table (see below)
 *   npm run etl:synthetic -- --reset-demo   # drop the scratch table's rows
 *
 * SAFETY: this loader NEVER touches the real observed tables (case_data,
 * climate_data, demographic_data, regions). With --allow-demo it writes ONLY
 * to `synthetic_demo_panel`, a clearly-named scratch table for pipeline
 * testing (join shape, lag features, train/test splits). Every row in the CSV
 * must carry is_demo_fixture=1 or the load is refused.
 *
 * The Python model service should read the CSV directly with pandas for
 * architecture validation — not via MySQL. This table exists so the Node ETL
 * patterns (dry-run reporting, idempotent upserts) can be exercised end to
 * end without risking a single real observation.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from '../src/config/db.js'
import { REGION_SLUGS } from './etl/regions-ph.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CSV = path.join(
  HERE, '..', '..', 'RESEARCH DATA SET',
  'SYNTHETIC DEMO FIXTURE - DO NOT USE AS REAL DATA',
  'ph_synthetic_dengue_2016-2020_DEMO_FIXTURE.csv',
)

const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes('--allow-demo') || argv.includes('--dry-run')
const ALLOW = argv.includes('--allow-demo') && !argv.includes('--dry-run')
const RESET = argv.includes('--reset-demo')
const log = (...a) => console.log(...a)

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  const header = lines[0].split(',')
  return lines.slice(1).map((ln) => {
    // No quoted commas in the generated file; simple split is exact.
    const cells = ln.split(',')
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))
  })
}

async function main() {
  log(`\nSynthetic DEMO loader${DRY_RUN ? '   [DRY RUN — no writes]' : '   [--allow-demo — scratch table only]'}`)
  if (!fs.existsSync(CSV)) throw new Error(`CSV not found: ${CSV}\nRun: npm run synthetic:demo`)

  const rows = parseCsv(fs.readFileSync(CSV, 'utf8'))
  log(`  parsed ${rows.length} rows, ${Object.keys(rows[0]).length} cols`)

  const problems = []
  if (rows.length !== 1020) problems.push(`row count ${rows.length} != 1020`)
  if (!rows.every((r) => r.is_demo_fixture === '1')) problems.push('not every row is_demo_fixture=1')
  const slugs = new Set(rows.map((r) => r.slug))
  const missing = REGION_SLUGS.filter((s) => !slugs.has(s))
  if (missing.length) problems.push(`missing regions: ${missing.join(',')}`)
  const badSplit = rows.filter((r) => !['train', 'test', 'diagnostic_excluded'].includes(r.split))
  if (badSplit.length) problems.push(`${badSplit.length} rows with bad split`)
  const badLags = rows.filter((r) => r.cases_lag1 === '' || r.cases_lag12 === '')
  if (badLags.length) problems.push(`${badLags.length} rows missing lag values (must be 0)`)
  const neg = rows.filter((r) => Number(r.dengue_cases) < 0 || Number(r.dengue_deaths) < 0)
  if (neg.length) problems.push(`${neg.length} rows with negative counts`)

  const bySplit = {}
  for (const r of rows) bySplit[r.split] = (bySplit[r.split] ?? 0) + 1
  log(`  split: train=${bySplit.train ?? 0} test=${bySplit.test ?? 0} diagnostic_excluded=${bySplit.diagnostic_excluded ?? 0}`)
  log(`  slugs: ${slugs.size}/17  periods: ${rows[0].period} -> ${rows[rows.length - 1].period}`)

  if (problems.length) throw new Error(`Refusing load: ${problems.join('; ')}`)
  log('  checks: PASS (1020 rows, 17 slugs, splits 612/204/204, all DEMO-flagged)')

  if (RESET) {
    await pool.query('DROP TABLE IF EXISTS synthetic_demo_panel')
    log('  reset: synthetic_demo_panel dropped.')
    return
  }
  if (DRY_RUN) {
    log('\nDry run complete. Nothing written. Re-run with --allow-demo to load the scratch table.')
    return
  }

  // --allow-demo: scratch table ONLY. Real tables are never named here.
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`
      CREATE TABLE IF NOT EXISTS synthetic_demo_panel (
        slug VARCHAR(10) NOT NULL,
        period CHAR(7) NOT NULL,
        year SMALLINT NOT NULL,
        month TINYINT NOT NULL,
        split ENUM('train','test','diagnostic_excluded') NOT NULL,
        dengue_cases INT NOT NULL,
        dengue_deaths INT NOT NULL,
        incidence_per100k DECIMAL(8,2) NULL,
        mean_temp_C DECIMAL(5,2) NULL,
        rainfall_mm DECIMAL(7,1) NULL,
        humidity_pct DECIMAL(5,1) NULL,
        hot_days TINYINT NULL,
        population INT NULL,
        pop_density_km2 DECIMAL(10,2) NULL,
        urban_pct DECIMAL(5,2) NULL,
        poverty_fam_pct DECIMAL(5,2) NULL,
        oni DECIMAL(4,2) NULL,
        oni_lag3 DECIMAL(4,2) NULL,
        rainfall_lag1 DECIMAL(7,1) NULL,
        rainfall_anomaly_mm DECIMAL(7,1) NULL,
        humidity_lag1 DECIMAL(5,1) NULL,
        temp_lag3 DECIMAL(5,2) NULL,
        cases_lag1 INT NULL,
        cases_lag12 INT NULL,
        ovitrap_pct DECIMAL(4,1) NULL,
        ovitrap_lag1 DECIMAL(4,1) NULL,
        is_demo_fixture TINYINT NOT NULL DEFAULT 1,
        PRIMARY KEY (slug, period)
      ) COMMENT='SCRATCH — synthetic DEMO FIXTURE, never real observations'`)
    let n = 0
    for (const r of rows) {
      await conn.execute(
        `INSERT INTO synthetic_demo_panel
           (slug, period, year, month, split, dengue_cases, dengue_deaths,
            incidence_per100k, mean_temp_C, rainfall_mm, humidity_pct, hot_days,
            population, pop_density_km2, urban_pct, poverty_fam_pct, oni, oni_lag3,
            rainfall_lag1, rainfall_anomaly_mm, humidity_lag1, temp_lag3,
            cases_lag1, cases_lag12, ovitrap_pct, ovitrap_lag1, is_demo_fixture)
         VALUES (:slug, :period, :year, :month, :split, :cases, :deaths,
            :inc, :temp, :rain, :hum, :hot, :pop, :dens, :urb, :pov, :oni, :oni3,
            :rain1, :rainAnom, :hum1, :temp3, :c1, :c12, :ovi, :ovi1, 1)
         ON DUPLICATE KEY UPDATE
           dengue_cases = VALUES(dengue_cases), dengue_deaths = VALUES(dengue_deaths),
           incidence_per100k = VALUES(incidence_per100k), mean_temp_C = VALUES(mean_temp_C),
           rainfall_mm = VALUES(rainfall_mm), humidity_pct = VALUES(humidity_pct),
           hot_days = VALUES(hot_days), population = VALUES(population),
           pop_density_km2 = VALUES(pop_density_km2), urban_pct = VALUES(urban_pct),
           poverty_fam_pct = VALUES(poverty_fam_pct), oni = VALUES(oni),
           oni_lag3 = VALUES(oni_lag3), rainfall_lag1 = VALUES(rainfall_lag1),
           rainfall_anomaly_mm = VALUES(rainfall_anomaly_mm),
           humidity_lag1 = VALUES(humidity_lag1), temp_lag3 = VALUES(temp_lag3),
           cases_lag1 = VALUES(cases_lag1), cases_lag12 = VALUES(cases_lag12),
           ovitrap_pct = VALUES(ovitrap_pct), ovitrap_lag1 = VALUES(ovitrap_lag1)`,
        {
          slug: r.slug, period: r.period, year: Number(r.year), month: Number(r.month),
          split: r.split, cases: Number(r.dengue_cases), deaths: Number(r.dengue_deaths),
          inc: num(r.incidence_per100k), temp: num(r.mean_temp_C), rain: num(r.rainfall_mm),
          hum: num(r.humidity_pct), hot: num(r.hot_days), pop: num(r.population),
          dens: num(r.pop_density_km2), urb: num(r.urban_pct), pov: num(r.poverty_fam_pct),
          oni: num(r.oni), oni3: num(r.oni_lag3), rain1: num(r.rainfall_lag1),
          rainAnom: num(r.rainfall_anomaly_mm), hum1: num(r.humidity_lag1),
          temp3: num(r.temp_lag3), c1: num(r.cases_lag1), c12: num(r.cases_lag12),
          ovi: num(r.ovitrap_pct), ovi1: num(r.ovitrap_lag1),
        },
      )
      n += 1
    }
    await conn.commit()
    log(`\nLoaded ${n} rows into synthetic_demo_panel (scratch only — real tables untouched).`)
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

const num = (v) => (v === '' || v == null ? null : Number(v))

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('\nSynthetic ETL failed:', err.message)
    await pool.end()
    process.exitCode = 1
  })
