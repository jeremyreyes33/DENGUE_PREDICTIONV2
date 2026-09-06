"""Harness-validation runs for the model-service write contract.

Trains three simple, honestly-labeled models on the SYNTHETIC DEMO FIXTURE
panel (train 2016-2018, test 2019, 2020 excluded) and writes the full
MODEL_SERVICE.md section 3 output: model_runs, predictions,
prediction_intervals (50/80/95), evaluation_metrics, interval_coverage,
calibration_bins and feature_importance.

These runs are PLUMBING CHECKS, not study results — every run is stamped
notes='DEMO FIXTURE ...' so the UI renders its not-model-output banner.
The real Bayesian-Neural Hybrid, SARIMA and LSTM replace them later by
inserting new model_runs rows; nothing here needs to change.
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
import pymysql
from exog import build_normals, future_frame, provenance_summary
from sklearn.linear_model import RidgeCV
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_DEFAULT = os.path.join(
    HERE, "..", "RESEARCH DATA SET",
    "SYNTHETIC DEMO FIXTURE - DO NOT USE AS REAL DATA",
    "ph_synthetic_dengue_2016-2020_DEMO_FIXTURE.csv",
)
ENV_DEFAULT = os.path.join(HERE, "..", "backend", ".env")

NOTES = "DEMO FIXTURE -- harness validation on synthetic panel, not a real fit"
LEVELS = [50.0, 80.0, 95.0]
K_SAMPLES = 500
K_CRPS = 200
rng = np.random.default_rng(20260214)

# feature -> (csv/engineered column, lag_months or None) for permutation importance
IMPORTANCE_FEATURES = [
    ("temperature", "temp_lag3", 3),
    ("humidity", "humidity_lag1", 1),
    ("rainfall", "rainfall_lag1", 1),
    ("rainfall_anomaly", "rainfall_anomaly_mm", None),
    ("oni", "oni_lag3", 3),
    ("ovitrap", "ovitrap_lag1", 1),
    ("cases_lag1", "cases_lag1_log", 1),
    ("cases_lag12", "cases_lag12_log", 12),
    ("population_density", "log_density", None),
]


def load_env(path):
    cfg = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    cfg[k.strip()] = v.strip()
    return cfg


def add_engineered(df):
    df = df.copy()
    df["cases_lag1_log"] = np.log1p(df["cases_lag1"])
    df["cases_lag12_log"] = np.log1p(df["cases_lag12"])
    df["log_pop"] = np.log(df["population"])
    df["log_density"] = np.log(df["pop_density_km2"])
    m = df["month"].to_numpy()
    df["month_sin"] = np.sin(2 * np.pi * m / 12)
    df["month_cos"] = np.cos(2 * np.pi * m / 12)
    return df


NUM_COLS = [
    "cases_lag1_log", "cases_lag12_log", "temp_lag3", "humidity_lag1",
    "rainfall_lag1", "rainfall_anomaly_mm", "oni_lag3", "ovitrap_lag1",
    "log_pop", "month_sin", "month_cos",
]


class SeasonalNaive:
    name = "Seasonal-Naive baseline"

    def fit(self, train):
        resid = (train["dengue_cases"] - train["cases_lag12"]).to_numpy(float)
        self.resid_ = resid
        return self

    def predict_mean(self, test):
        return test["cases_lag12"].to_numpy(float).clip(min=0)

    def sample(self, test, k=K_SAMPLES):
        mu = self.predict_mean(test)[:, None]
        draws = mu + rng.choice(self.resid_, size=(len(test), k))
        return np.clip(draws, 0, None)

    def forecast_paths(self, frame_region, hist_last, S=K_SAMPLES):
        """Recursive S-path forecast for ONE region's H-row future frame.

        Seasonal-naive needs no feedback: each horizon step reads the
        observed same-month-last-year value. hist_last is accepted for
        signature parity and ignored."""
        lag12 = frame_region["cases_lag12"].to_numpy(float)
        draws = lag12[None, :] + rng.choice(self.resid_, size=(S, len(frame_region)))
        return np.round(np.clip(draws, 0, None))


class RidgeModel:
    def __init__(self, name, with_regions):
        self.name = name
        self.with_regions = with_regions

    def _design(self, df, scaler=None, cols=None):
        X = df[NUM_COLS].to_numpy(float)
        if scaler is None:
            scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        if self.with_regions:
            d = pd.get_dummies(df["slug"], prefix="rg", dtype=float)
            if cols is None:
                cols = list(d.columns)
            d = d.reindex(columns=cols, fill_value=0.0)
            Xs = np.hstack([Xs, d.to_numpy()])
        else:
            cols = []
        return Xs, scaler, cols

    def fit(self, train):
        self.ylog_ = np.log1p(train["dengue_cases"].to_numpy(float))
        Xs, self.scaler_, self.region_cols_ = self._design(train)
        self.model_ = RidgeCV(alphas=np.logspace(-2, 4, 13)).fit(Xs, self.ylog_)
        # In-sample residuals: slightly optimistic intervals, stated in hyperparameters.
        self.resid_ = self.ylog_ - self.model_.predict(Xs)
        return self

    def predict_mean(self, test):
        Xs, _, _ = self._design(test, self.scaler_, self.region_cols_)
        log_pred = self.model_.predict(Xs)
        return np.expm1(log_pred + 0.5 * float(np.var(self.resid_))).clip(min=0)

    def sample(self, test, k=K_SAMPLES):
        Xs, _, _ = self._design(test, self.scaler_, self.region_cols_)
        log_pred = self.model_.predict(Xs)[:, None]
        draws = log_pred + rng.choice(self.resid_, size=(len(test), k))
        return np.clip(np.expm1(draws), 0, None)

    def forecast_paths(self, frame_region, hist_last, S=K_SAMPLES):
        """Recursive S-path forecast for ONE region's H-row future frame.

        Only cases_lag1 is fed back, per path: each path's own sampled count
        becomes its next step's lag1 (log1p-transformed). Plugging the median
        back instead would collapse the fan and understate uncertainty -- the
        per-horizon width check in main() exists to catch exactly that. All
        other features come from the exog frame (observed-while-covered, else
        normals/scenario-tagged assumptions). Returns (S, H) integer paths."""
        H = len(frame_region)
        num_base = frame_region[NUM_COLS].to_numpy(float)
        if not np.all(np.isfinite(np.delete(num_base, NUM_COLS.index("cases_lag1_log"), axis=1))):
            raise ValueError("non-finite exog values in future frame (region %s)"
                             % frame_region["slug"].iloc[0])
        i_lag1 = NUM_COLS.index("cases_lag1_log")
        if self.with_regions:
            dum = pd.get_dummies(frame_region["slug"], prefix="rg", dtype=float)
            dum = dum.reindex(columns=self.region_cols_, fill_value=0.0).to_numpy()
        else:
            dum = np.zeros((H, 0))
        paths = np.zeros((S, H))
        prev = np.full(S, float(hist_last))
        for hi in range(H):
            Xnum = np.repeat(num_base[hi:hi + 1], S, axis=0)
            Xnum[:, i_lag1] = np.log1p(np.clip(prev, 0, None))
            Xs = self.scaler_.transform(Xnum)
            if dum.shape[1]:
                Xs = np.hstack([Xs, np.repeat(dum[hi:hi + 1], S, axis=0)])
            logmu = self.model_.predict(Xs)
            prev = np.round(np.clip(np.expm1(logmu + rng.choice(self.resid_, size=S)), 0, None))
            paths[:, hi] = prev
        return paths


def quantiles(samples):
    qs = np.quantile(samples, [0.025, 0.10, 0.25, 0.75, 0.90, 0.975], axis=1)
    return {"95": (qs[0], qs[5]), "80": (qs[1], qs[4]), "50": (qs[2], qs[3])}


def crps_sample(y, x):
    xs = x[:K_CRPS]
    return float(np.mean(np.abs(x - y)) - 0.5 * np.mean(np.abs(xs[:, None] - xs[None, :])))


def randomized_pit(y, x):
    less = float(np.mean(x < y))
    eq = float(np.mean(x == y))
    return less + float(rng.random()) * eq


def group_metrics(y, mean, samples):
    lo95, hi95 = quantiles(samples)["95"]
    ape = np.abs(mean - y) / np.maximum(y, 1)
    return {
        "rmse": float(np.sqrt(np.mean((mean - y) ** 2))),
        "mae": float(np.mean(np.abs(mean - y))),
        "mape": float(min(np.mean(ape) * 100, 999.999)),
        "crps": float(np.mean([crps_sample(y[i], samples[i]) for i in range(len(y))])),
        "coverage95": float(np.mean((y >= lo95) & (y <= hi95)) * 100),
        "width95": float(np.mean(hi95 - lo95)),
        "n": int(len(y)),
    }


def permutation_importance(model, test, y, mean, n_rep=20):
    base = float(np.sqrt(np.mean((mean - y) ** 2)))
    rows = []
    for feat, col, lag in IMPORTANCE_FEATURES:
        lifts = []
        for _ in range(n_rep):
            Xp = test.copy()
            Xp[col] = rng.permutation(Xp[col].to_numpy())
            pm = model.predict_mean(Xp)
            lifts.append(float(np.sqrt(np.mean((pm - y) ** 2))) - base)
        lifts = np.array(lifts)
        rows.append({
            "feature": feat, "lag_months": lag,
            "importance": float(np.mean(lifts)),
            "ci_lower": float(np.quantile(lifts, 0.025)),
            "ci_upper": float(np.quantile(lifts, 0.975)),
        })
    rows.sort(key=lambda r: r["importance"], reverse=True)
    for i, r in enumerate(rows, 1):
        r["rank_in_scope"] = i
    return rows


def update_or_insert(cur, table, cols, row, match):
    """UPDATE-or-INSERT for tables whose unique key contains a NULL column
    (MySQL treats NULLs as distinct, so ON DUPLICATE KEY will not fire)."""
    set_clause = ", ".join(f"{c} = %s" for c in cols)
    where = " AND ".join(f"{c} IS NULL" if row[c] is None else f"{c} = %s" for c in match)
    params = [row[c] for c in cols] + [row[c] for c in match if row[c] is not None]
    cur.execute(f"UPDATE {table} SET {set_clause} WHERE {where}", params)
    if cur.rowcount == 0:
        names = ", ".join(cols)
        holders = ", ".join(["%s"] * len(cols))
        cur.execute(f"INSERT INTO {table} ({names}) VALUES ({holders})",
                    [row[c] for c in cols])


def write_run(conn, model, frame, region_id, feature_json, hyper, with_importance,
              horizon=1, run_suffix="", imp_frame=None,
              y_full=None, mean_full=None, samples_full=None,
              test_start="2019-01-01", test_end="2019-12-01"):
    """frame carries slug/year/month per predicted row. One-step callers omit
    the *_full arrays (fitted from `frame` via the model); recursive callers
    pass precomputed path-conditioned arrays, where y_full may hold NaN for
    genuinely unobserved targets (written as NULL, excluded from scoring)."""
    cur = conn.cursor()
    if samples_full is None:
        y_full = frame["dengue_cases"].to_numpy(float)
        mean_full = model.predict_mean(frame)
        samples_full = model.sample(frame)
    scored = np.isfinite(y_full)
    y, mean, samples = y_full[scored], mean_full[scored], samples_full[scored]
    slugs = frame["slug"].to_numpy()[scored]
    median_full = np.median(samples_full, axis=1)
    q_full = quantiles(samples_full)
    pits = np.array([randomized_pit(y[i], samples[i]) for i in range(len(y))])
    # Masked quantiles for the scored subset (coverage/metrics); the _full
    # versions above serve the per-row prediction writes.
    q = {k: (v[0][scored], v[1][scored]) for k, v in q_full.items()}

    cur.execute(
        """INSERT INTO model_runs
             (model_type, version, trained_at, hyperparameters_json,
              train_start, train_end, test_start, test_end,
              horizon_months, feature_set_json, notes)
           VALUES (%s, %s, NOW(), %s, %s, %s, %s, %s, %s, %s, %s)""",
        (model.name + run_suffix, "harness-1", json.dumps(hyper),
         "2016-01-01", "2018-12-01", test_start, test_end,
         horizon, json.dumps(feature_json), NOTES),
    )
    run_id = cur.lastrowid

    for i, (_, r) in enumerate(frame.iterrows()):
        rid = region_id[r["slug"]]
        date = f"{int(r['year']):04d}-{int(r['month']):02d}-01"
        actual = round(float(y_full[i]), 2) if np.isfinite(y_full[i]) else None
        cur.execute(
            """INSERT INTO predictions
                 (model_run_id, region_id, date, predicted_cases,
                  predicted_median, ci_lower, ci_upper, actual_cases)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE
                 id = LAST_INSERT_ID(id),
                 predicted_cases = VALUES(predicted_cases),
                 predicted_median = VALUES(predicted_median),
                 ci_lower = VALUES(ci_lower), ci_upper = VALUES(ci_upper),
                 actual_cases = VALUES(actual_cases)""",
            (run_id, rid, date, round(float(mean_full[i]), 2), round(float(median_full[i]), 2),
             round(float(q_full["95"][0][i]), 2), round(float(q_full["95"][1][i]), 2),
             actual),
        )
        pid = cur.lastrowid
        for lvl in LEVELS:
            key = str(int(lvl))
            cur.execute(
                """INSERT INTO prediction_intervals
                     (prediction_id, nominal_level, lower, upper)
                   VALUES (%s, %s, %s, %s)
                   ON DUPLICATE KEY UPDATE lower = VALUES(lower), upper = VALUES(upper)""",
                (pid, lvl, round(float(q[key][0][i]), 2), round(float(q[key][1][i]), 2)),
            )

    def coverage_rows(idx, rid_or_none):
        yy, ss = y[idx], samples[idx]
        out = []
        for lvl in LEVELS:
            key = str(int(lvl))
            lo, hi = q[key][0][idx], q[key][1][idx]
            out.append({
                "model_run_id": run_id, "region_id": rid_or_none,
                "nominal_level": lvl,
                "empirical_level": round(float(np.mean((yy >= lo) & (yy <= hi)) * 100), 2),
                "mean_width": round(float(np.mean(hi - lo)), 2),
                "n_obs": int(len(idx)),
            })
        return out

    all_idx = np.arange(len(y))
    for cov in coverage_rows(all_idx, None):
        update_or_insert(cur, "interval_coverage",
                         ["model_run_id", "region_id", "nominal_level",
                          "empirical_level", "mean_width", "n_obs"],
                         cov, ["model_run_id", "region_id", "nominal_level"])
    for slug, rid in region_id.items():
        idx = np.where(slugs == slug)[0]
        if len(idx) == 0:
            continue
        for cov in coverage_rows(idx, rid):
            cur.execute(
                """INSERT INTO interval_coverage
                     (model_run_id, region_id, nominal_level,
                      empirical_level, mean_width, n_obs)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON DUPLICATE KEY UPDATE
                     empirical_level = VALUES(empirical_level),
                     mean_width = VALUES(mean_width), n_obs = VALUES(n_obs)""",
                (cov["model_run_id"], cov["region_id"], cov["nominal_level"],
                 cov["empirical_level"], cov["mean_width"], cov["n_obs"]),
            )

    gm = group_metrics(y, mean, samples)
    update_or_insert(cur, "evaluation_metrics",
                     ["model_run_id", "scope", "region_id", "rmse", "mae", "mape",
                      "crps", "coverage", "mean_interval_width", "n_obs"],
                     {"model_run_id": run_id, "scope": "overall", "region_id": None,
                      "rmse": round(gm["rmse"], 3), "mae": round(gm["mae"], 3),
                      "mape": round(gm["mape"], 3), "crps": round(gm["crps"], 3),
                      "coverage": round(gm["coverage95"], 2),
                      "mean_interval_width": round(gm["width95"], 2), "n_obs": gm["n"]},
                     ["model_run_id", "scope", "region_id"])
    for slug, rid in region_id.items():
        idx = np.where(slugs == slug)[0]
        if len(idx) == 0:
            continue
        rm = group_metrics(y[idx], mean[idx], samples[idx])
        cur.execute(
            """INSERT INTO evaluation_metrics
                 (model_run_id, scope, region_id, rmse, mae, mape,
                  crps, coverage, mean_interval_width, n_obs)
               VALUES (%s, 'region', %s, %s, %s, %s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE
                 rmse = VALUES(rmse), mae = VALUES(mae), mape = VALUES(mape),
                 crps = VALUES(crps), coverage = VALUES(coverage),
                 mean_interval_width = VALUES(mean_interval_width),
                 n_obs = VALUES(n_obs)""",
            (run_id, rid, round(rm["rmse"], 3), round(rm["mae"], 3),
             round(rm["mape"], 3), round(rm["crps"], 3),
             round(rm["coverage95"], 2), round(rm["width95"], 2), rm["n"]),
        )

    for b in range(10):
        lo, hi = b / 10, (b + 1) / 10
        freq = float(np.mean((pits >= lo) & (pits < hi if hi < 1 else pits <= hi)))
        cur.execute(
            """INSERT INTO calibration_bins
                 (model_run_id, bin_lower, bin_upper, observed_freq, n_obs)
               VALUES (%s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE observed_freq = VALUES(observed_freq),
                 n_obs = VALUES(n_obs)""",
            (run_id, round(lo, 4), round(hi, 4), round(freq, 4), len(y)),
        )

    # Permutation importance needs a static feature frame (one-step test set).
    # Recursive paths have no fixed cases_lag1 column, so recursive runs skip
    # it: importance for multi-step horizons is future work, stated as such.
    if with_importance and imp_frame is not None:
        for imp in permutation_importance(model, imp_frame, y, mean):
            update_or_insert(cur, "feature_importance",
                             ["model_run_id", "region_id", "feature", "lag_months",
                              "importance", "ci_lower", "ci_upper", "method",
                              "rank_in_scope"],
                             {"model_run_id": run_id, "region_id": None,
                              "feature": imp["feature"], "lag_months": imp["lag_months"],
                              "importance": round(imp["importance"], 6),
                              "ci_lower": round(imp["ci_lower"], 6),
                              "ci_upper": round(imp["ci_upper"], 6),
                              "method": "permutation",
                              "rank_in_scope": imp["rank_in_scope"]},
                             ["model_run_id", "region_id", "feature",
                              "lag_months", "method"])
    return run_id, gm


def run_recursive(args, conn, region_id, df, train, models, feature_json):
    """Multi-step recursive forecasting from one origin month.

    Models stay fitted on train (2016-2018) -- refitting through the origin
    would leak the test window into training. Only the *inputs* (lags, exog)
    may see history through the origin; that is standard conditioning, not
    leakage, and the exog provenance tags record exactly which cells do.
    """
    H = args.horizon
    if not 1 <= H <= 12:
        raise SystemExit("--horizon must be 1..12 (cases_lag12 reaches 12 back)")

    def shift(year, month, dh):
        m = month + dh
        return year + (m - 1) // 12, (m - 1) % 12 + 1

    if args.origin:
        oy, om = int(args.origin[:4]), int(args.origin[5:7])
    else:  # latest origin whose H targets are all observed (<= 2020-12 here)
        oy, om = 2020, 12
        for _ in range(H):
            oy, om = shift(oy, om, -1)
    origin = f"{oy:04d}-{om:02d}"
    ty, tm = shift(oy, om, H)
    if (oy, om) < (2016, 12):
        raise SystemExit(f"origin {origin} too early: cases_lag12 needs history from 2016-01")
    if (ty, tm) > (2020, 12):
        raise SystemExit(f"origin {origin} + {H}mo runs past the panel (2020-12)")

    normals = build_normals(train)
    frame, prov = future_frame(df, origin, H, normals, oni_scenario=args.oni_scenario)
    frame = frame.sort_values(["slug", "h"]).reset_index(drop=True)
    share = provenance_summary(prov)
    print(f"origin={origin} horizon={H} oni={args.oni_scenario} "
          f"exog provenance: " + " ".join(f"{k}={v:.0%}" for k, v in share.items()))

    hist_tail = (df[(df.year * 12 + df.month) <= oy * 12 + om]
                 .sort_values(["slug", "year", "month"])
                 .groupby("slug").tail(1).set_index("slug")["dengue_cases"])

    fj = dict(feature_json)
    fj["recursive"] = True
    fj["origin"] = origin
    fj["horizon"] = H
    fj["exog_assumptions"] = {
        "temperature_lag3/humidity_lag1/rainfall_lag1":
            "observed while the lag reaches history, else train-window month-normals",
        "rainfall_anomaly": "0 under normals (typical season; cannot foresee extremes)",
        "oni_lag3": f"{args.oni_scenario} scenario past observed history",
        "ovitrap_lag1": "last observed value carried forward (conditional)",
        "cases_lag1": "own sampled paths per trajectory (never median-plugged)",
        "cases_lag12": "observed history (h<=12)",
    }

    for model, hyper, with_imp in models:
        model.fit(train)
        hyper = dict(hyper, mode="recursive", origin=origin, horizon=H,
                     paths=K_SAMPLES, oni_scenario=args.oni_scenario,
                     normals_from="train 2016-2018 month means")
        means, sims = [], []
        for slug, greg in frame.groupby("slug", sort=True):
            greg = greg.sort_values("h")
            paths = model.forecast_paths(greg, float(hist_tail.loc[slug]), K_SAMPLES)
            means.append(paths.mean(axis=0))
            sims.append(paths)
        mean_full = np.concatenate(means)
        samples_full = np.concatenate(sims, axis=1).T  # (N, S) in frame order
        y_full = frame["actual_cases"].to_numpy(float)
        scored = np.isfinite(y_full)
        print(f"\n{model.name} recursive (origin {origin}, H={H}): "
              f"scored {scored.sum()}/{len(y_full)} rows")
        print("  (targets span the seasonal cycle: read by-h error against target magnitude,")
        print("   not as pure horizon degradation. Relative width is the fan check.)")
        print(f"  {'h':>2} {'RMSE':>8} {'CRPS':>8} {'cov95':>7} {'width95':>8} {'relW':>6}")
        prev_rel = -1.0
        for h in range(1, H + 1):
            m = (frame["h"].to_numpy() == h) & scored
            gm = group_metrics(y_full[m], mean_full[m], samples_full[m])
            rel = gm["width95"] / max(np.mean(mean_full[m]), 1)
            flag = ""
            if rel < prev_rel:
                flag = "  <-- relative fan NARROWED (median-plugging or exog snap?)"
            prev_rel = rel
            print(f"  {h:>2} {gm['rmse']:>8.0f} {gm['crps']:>8.0f} "
                  f"{gm['coverage95']:>6.1f}% {gm['width95']:>8.0f} {rel:>6.2f}{flag}")
        if args.dry_run:
            continue
        try:
            run_id, gm = write_run(
                conn, model, frame, region_id, fj, hyper, False,
                horizon=H, run_suffix=" recursive",
                y_full=y_full, mean_full=mean_full, samples_full=samples_full,
                test_start=frame.sort_values(['year', 'month']).iloc[0]['period'] + "-01",
                test_end=frame.sort_values(['year', 'month']).iloc[-1]['period'] + "-01")
            conn.commit()
            print(f"{model.name}: run_id={run_id} RMSE={gm['rmse']:.1f} "
                  f"MAPE={gm['mape']:.1f}% CRPS={gm['crps']:.1f} "
                  f"cov95={gm['coverage95']:.1f}% width95={gm['width95']:.0f}")
        except Exception:
            conn.rollback()
            raise
    if not args.dry_run:
        print("\nCommitted. Recursive runs carry horizon_months>1 and '-recursive' names.")


def main():
    ap = argparse.ArgumentParser(description="Harness validation: synthetic panel -> write contract")
    ap.add_argument("--csv", default=CSV_DEFAULT)
    ap.add_argument("--env", default=ENV_DEFAULT)
    ap.add_argument("--db-host", default=None)
    ap.add_argument("--db-port", default=None, type=int)
    ap.add_argument("--db-user", default=None)
    ap.add_argument("--db-password", default=None)
    ap.add_argument("--db-name", default=None)
    ap.add_argument("--dry-run", action="store_true", help="fit + score + print, write nothing")
    ap.add_argument("--models", default="naive,ridge,hybrid",
                    help="comma subset of naive,ridge,hybrid")
    ap.add_argument("--horizon", type=int, default=1,
                    help="recursive forecast horizon in months, 1..12 (>1 enables roll-forward mode)")
    ap.add_argument("--origin", default=None,
                    help="YYYY-MM last observed month (default: latest origin with fully-observed targets)")
    ap.add_argument("--oni-scenario", default="persistence",
                    choices=["persistence", "neutral", "el_nino", "la_nina"],
                    help="ONI path beyond observed history")
    ap.add_argument("--clear-demo", action="store_true",
                    help="delete harness runs (notes marker) and exit")
    args = ap.parse_args()

    env = load_env(args.env)
    db = {
        "host": args.db_host or env.get("DB_HOST", "localhost"),
        "port": int(args.db_port or env.get("DB_PORT", 3306)),
        "user": args.db_user or env.get("DB_USER", "root"),
        "password": args.db_password if args.db_password is not None else env.get("DB_PASSWORD", ""),
        "database": args.db_name or env.get("DB_NAME", "dengue_hybrid"),
    }

    conn = pymysql.connect(**db, autocommit=False)
    with conn.cursor() as cur:
        if args.clear_demo:
            cur.execute("DELETE FROM model_runs WHERE notes LIKE 'DEMO FIXTURE -- harness%'")
            print(f"deleted {cur.rowcount} harness run(s) (dependents cascade).")
            conn.commit()
            conn.close()
            return
        cur.execute("SELECT id, slug FROM regions WHERE admin_level = 'region'")
        region_id = {slug: i for i, slug in cur.fetchall()}
        missing = [s for s in
                   ["NCR", "CAR", "R1", "R2", "R3", "R4A", "R4B", "R5", "R6", "R7",
                    "R8", "R9", "R10", "R11", "R12", "R13", "BARMM"] if s not in region_id]
        if missing:
            raise SystemExit(f"regions missing in DB: {missing} (run npm run etl:revised first)")

    df = add_engineered(pd.read_csv(args.csv))
    assert len(df) == 1020, f"expected 1020 rows, got {len(df)}"
    train = df[df["split"] == "train"].reset_index(drop=True)
    test = df[df["split"] == "test"].reset_index(drop=True)
    assert len(train) == 612 and len(test) == 204, "split counts wrong"
    print(f"panel: train={len(train)} test={len(test)} excluded={len(df) - len(train) - len(test)}")

    feature_json = {
        "target": "dengue_cases",
        "predictors": ["cases_lag1", "cases_lag12", "temperature_lag3",
                       "humidity_lag1", "rainfall_lag1", "rainfall_anomaly",
                       "oni_lag3", "ovitrap_lag1", "log_population_offset",
                       "month_fourier"],
        "excluded": {"2020": "COVID surveillance break (clean in fixture, still excluded)"},
    }
    wanted = {m.strip() for m in args.models.split(",")}
    models = [
        (SeasonalNaive(), {"estimator": "seasonal_naive_lag12",
                           "intervals": "empirical train residuals"}, False),
        (RidgeModel("Ridge-Lag baseline", False),
         {"estimator": "RidgeCV log1p, pooled, month fourier",
          "intervals": "in-sample residual bootstrap (slightly optimistic)"}, False),
        (RidgeModel("Log-Linear Hybrid-lite", True),
         {"estimator": "RidgeCV log1p, region dummies + month fourier",
          "intervals": "in-sample residual bootstrap (slightly optimistic)"}, True),
    ]
    keys = {"naive": 0, "ridge": 1, "hybrid": 2}
    models = [models[keys[k]] for k in sorted(wanted) if k in keys]

    if args.horizon > 1:
        run_recursive(args, conn, region_id, df, train, models, feature_json)
        conn.close()
        return

    for model, hyper, with_imp in models:
        model.fit(train)
        y = test["dengue_cases"].to_numpy(float)
        samples = model.sample(test)
        gm = group_metrics(y, model.predict_mean(test), samples)
        print(f"\n{model.name}: RMSE={gm['rmse']:.1f} MAE={gm['mae']:.1f} "
              f"MAPE={gm['mape']:.1f}% CRPS={gm['crps']:.1f} "
              f"cov95={gm['coverage95']:.1f}% width95={gm['width95']:.0f} (dry-run)" if args.dry_run else "")
        if args.dry_run:
            continue
        try:
            run_id, gm = write_run(conn, model, test, region_id, feature_json, hyper, with_imp,
                                   imp_frame=test if with_imp else None)
            conn.commit()
            print(f"{model.name}: run_id={run_id} RMSE={gm['rmse']:.1f} "
                  f"MAPE={gm['mape']:.1f}% CRPS={gm['crps']:.1f} "
                  f"cov95={gm['coverage95']:.1f}% width95={gm['width95']:.0f}")
        except Exception:
            conn.rollback()
            raise
    if not args.dry_run:
        print("\nCommitted. Validate with the MODEL_SERVICE.md section 5 query.")
    conn.close()


if __name__ == "__main__":
    main()
