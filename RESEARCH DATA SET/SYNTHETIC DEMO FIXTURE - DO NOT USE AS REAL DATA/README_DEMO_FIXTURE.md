# SYNTHETIC DEMO FIXTURE — DO NOT USE AS REAL DATA

> **Every number in `ph_synthetic_dengue_2016-2020_DEMO_FIXTURE.csv` is
> invented by `backend/scripts/generate-synthetic-demo.js` (seed `20260214`).
> It exists ONLY to test ETL joins, lag features, train/test splits and the
> model-service write contract. Never mix it with the real panel in
> `REVISED DATA SET/`, never publish metrics computed from it, and never load
> it into `case_data` / `climate_data` without the `--allow-demo` guard in
> `backend/scripts/import-synthetic-demo.js` (which tags everything it touches
> as synthetic).**

## What it is

* **Scope:** National, 17 administrative regions × 60 months
  (`2016-01` → `2020-12`) = **1,020 rows, 28 columns, zero missing.**
  A 2015 burn-in year is generated internally and discarded, so even the
  2016-01 lags (`cases_lag1`, `cases_lag12`, climate lags) are genuine
  history — no blank cells, no zero-filled lags, no leakage from the future.
* **Clean 2020:** 2020 follows normal transmission (~192k cases). The real
  2020 COVID surveillance collapse (~91k, 6–9% of 2019 in Jul–Oct) is
  deliberately NOT reproduced. Use the `split` column to honour the study
  design: `train` = 2016–2018 (612 rows), `test` = 2019 (204 rows),
  `diagnostic_excluded` = 2020 (204 rows).
* **Variables:** all original REVISED features (cases, deaths, temperature,
  rainfall, humidity, hot days, population, density, urban %, poverty %) PLUS
  the cheap high-impact additions: `oni` + `oni_lag3` (ENSO), `cases_lag1` +
  `cases_lag12`, `rainfall_lag1` + `rainfall_anomaly_mm`, `temp_lag3`,
  `humidity_lag1`, `ovitrap_pct` + `ovitrap_lag1` (vector). WASH/serotype are
  out of scope for this iteration by design.

## Real anchors (not invented)

* PSA 2020 regional populations (sum **109,033,245**, reconciles exactly) and
  land areas → density; December-2020 synthetic pop sums to the same total.
* PSA poverty incidence among families (2015/2018; 2016–2017 interpolated,
  2019–2020 carried forward) and urban share (2015/2020, interpolated).
* ERA5 2016–2020 per-region-per-month climate normals — synthetic weather is
  noise around observed means, so NCR is hot/dry-seasonal, CAR is cool,
  eastern seaboard is wet.
* Realistic ONI cycle: 2016 El Niño decay → 2017–18 La Niña → weak 2018–19
  El Niño → neutral/late-2020 La Niña.

## Generation logic (seeded, reproducible)

```
log(mu) = log(base × seasonal × year_effect × year_shock)
        + 0.12·z(temp_lag3) + 0.05·z(humidity_lag1) + 0.03·z(rainfall_lag1)
        + 0.05·(ONI_lag3/1.5) + 0.06·z(ovitrap_lag1)
        + 0.12·(log(cases_lag1+1) − log(base+1))
cases ~ overdispersed(mu, r=12, z clipped ±2.5)
deaths ~ Binomial(cases, CFR_region)
ovitrap(t) = 14 + 0.04·rainfall(t−1) + noise   (pure lead, no coincident term)
rainfall ~ lognormal around ERA5 normal (sd 0.40, typhoon spikes, max 900 mm)
year_shock ~ lognormal(0, 0.35) per region-year (serotype/outbreak variance)
```

Seasonality peaks Aug–Sep (×2.05–2.15), troughs Mar (×0.35). 2019 carries an
epidemic boost (×1.9). A 2015 burn-in year is generated internally and
discarded so every emitted row's lags are genuine history — no leakage.

## Measured properties of the committed file (seed 20260214)

* Yearly totals: 2016=209,665 · 2017=159,628 · 2018=238,758 · 2019=548,706 ·
  2020=282,127 (real: 209,544 / 154,155 / 250,783 / 441,902 / 91,041-collapsed).
  Same order of magnitude, 2019 epidemic preserved, 2020 clean by design.
* Within-region corr(log-incidence, predictor at lag) — gradient matches the
  real panel (REVISION_PLAN §2c: temp_lag3 0.398 strongest; humidity_lag1
  0.213; rainfall_lag1 0.191). Synthetic runs stronger because shared
  seasonality flows through both direct and ovitrap paths even after
  typhoon noise + outbreak shocks dilute it — the lag STRUCTURE (which lag
  peaks) is what the fixture guarantees, not the exact magnitudes:

| predictor | lag0 | lag1 | lag2 | lag3 |
|---|---|---|---|---|
| temperature | 0.129 | 0.278 | 0.424 | **0.509** |
| humidity | 0.304 | **0.332** | 0.191 | −0.068 |
| rainfall | 0.310 | **0.426** | 0.349 | 0.129 |
| ovitrap | 0.395 | 0.334 | — | — |

* Known limitation: ovitrap lag0 ≥ lag1 (common-cause via rainfall(t−1));
  acceptable for a pipeline fixture — the variable has no observed counterpart
  (`vector_data` is empty in the real schema) and the lead construction
  (`ovitrap(t)` sees only `rainfall(t−1)`) is preserved.
* Smallest regional month: ≥5 cases; deaths ≤2% of cases; CFR ≈0.15–0.8%.

## Column reference

`slug, region_name, year, month, period, split, dengue_cases, dengue_deaths,
incidence_per100k, mean_temp_C, rainfall_mm, humidity_pct, hot_days,
population, pop_density_km2, urban_pct, poverty_fam_pct, oni, oni_lag3,
rainfall_lag1, rainfall_anomaly_mm, humidity_lag1, temp_lag3, cases_lag1,
cases_lag12, ovitrap_pct, ovitrap_lag1, is_demo_fixture(=1 always)`

`rainfall_anomaly_mm` = synthetic rainfall minus the REAL ERA5 month-normal
for that region — positive = wetter than usual, the feature to prefer over raw
mm. `poverty_fam_pct` is incidence among FAMILIES (PSA definition), not
individuals.

## Regenerating / validating

```bash
cd backend
npm run synthetic:demo -- --dry-run   # recompute + print checks, write nothing
npm run synthetic:demo                # rewrite the CSV (seed 20260214)
npm run synthetic:demo -- --seed=7    # alternate realisation
npm run etl:synthetic -- --dry-run   # preview guarded load, write nothing
```

## What NOT to do

1. Do not copy this file into `REVISED DATA SET/` — the real ETL discovers
   files by folder prefix and must never see it.
2. Do not `INSERT` it into production tables except via `import-synthetic-demo.js`
   with `--allow-demo` on a scratch database; it refuses the live path by
   default and stamps `source='synthetic_demo_fixture'`.
3. Do not report RMSE/MAPE/CRPS from it as study results. It is a plumbing
   test with a known answer, not evidence about dengue.
