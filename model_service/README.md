# Model service (harness validation)

> **Status: plumbing validator, not the study model.** `validate_harness.py`
> fits three simple models on the **synthetic DEMO FIXTURE panel only** and
> writes the full `MODEL_SERVICE.md` §3 contract so the API pages
> (comparison, calibration, drivers, forecast) can be exercised end to end.
> Every run is stamped `DEMO FIXTURE` in `model_runs.notes`, which is what
> makes the UI render its not-model-output banner. Never cite these runs as
> results.

## Run

```bash
pip install -r requirements.txt
python validate_harness.py --dry-run        # fit + score + print, write nothing
python validate_harness.py                  # write 3 runs (naive, ridge, hybrid-lite)
python validate_harness.py --models hybrid  # subset
python validate_harness.py --clear-demo     # delete harness runs (cascades)
```

## Recursive multi-step mode (3–6 month forecasts)

```bash
python validate_harness.py --horizon 6 --origin 2019-06 --dry-run
python validate_harness.py --horizon 6 --origin 2019-06 --oni-scenario la_nina
```

- Models stay fitted on train (2016–2018); only *inputs* see history through
  `--origin`. Targets are scored where observed, written NULL beyond history.
- Future exogenous inputs come from `exog.py`: observed-while-covered, else
  train-window month-normals (rainfall anomaly ≡ 0: "typical season"), ONI
  persistence/scenarios, ovitrap carry-forward. Every assumed cell is
  provenance-tagged (`observed | normal | scenario | recursive-path`); the
  share prints on every run.
- `cases_lag1` is fed back **per path** (500 sampled trajectories), never
  median-plugged — the per-horizon table's relative-width column is the fan
  check (it must grow with h; raw widths track the seasonal target instead).
- Writes carry `horizon_months>1`, `-recursive` names, and the exog
  assumptions in `feature_set_json`. Permutation importance is skipped for
  recursive runs (no static lag1 column exists on paths) — stated, not silent.
- Validated backtest (origin 2019-06, H=6): 306 predictions / 918 intervals /
  54 metrics / 162 coverage / 30 PIT rows; relative fan 1.5 → 1.9.

DB credentials come from `../backend/.env` (overridable with
`--db-host/--db-port/--db-user/--db-password/--db-name`).
Split is fixed: train 2016–2018 (612), test 2019 (204), 2020 excluded.

## Runs

| model_type | What it is | Intervals |
|---|---|---|
| `Seasonal-Naive baseline` | pred = same month last year | empirical train residuals |
| `Ridge-Lag baseline` | RidgeCV on log1p, pooled + month Fourier | in-sample residual bootstrap |
| `Log-Linear Hybrid-lite` | RidgeCV on log1p + region dummies + month Fourier | in-sample residual bootstrap |

The hybrid-lite name contains "hybrid" on purpose: it is what the Drivers
page selects, so this validates that page too. Permutation importance
(20 reps, bootstrap CI, `method='permutation'`) is written for the
hybrid-lite run only.

## Replacing with the real models

Insert new `model_runs` rows per `MODEL_SERVICE.md` §3 (never overwrite),
then `python validate_harness.py --clear-demo` to remove these. No app code
changes — the database is the contract.
