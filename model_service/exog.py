"""Future exogenous inputs for recursive forecasting (normals-first tier).

The one-step harness never needs this module: every lag it consumes is
observed history. A 3-6 month recursive forecast does, because from h=2 on
some lags reach past the last observed month. This module answers, per
feature and per horizon step, "history or assumption?" -- and tags every
assumed cell so no downstream reader can mistake it for a measurement
(the same provenance rule as demographic_data.source).

Tier order (first available wins):
  1. observed  -- the lag still reaches into history (e.g. cases_lag12 for all
     h<=12, temp_lag3 for h<=3, oni_lag3 for h<=3).
  2. normal    -- ERA5-style month-normal. Computed here from the TRAIN window
     of the panel (never from the future being forecast). A drop-in point
     exists for direct ERA5/PAGASA normals (see build_normals) and for live
     outlooks (see OniOutlook): same return shape, no caller changes.
  3. scenario  -- ONI persistence / El Nino / neutral / La Nina paths, and
     ovitrap carry-forward. Explicitly conditional forecasts.

Deliberate scope: rainfall_anomaly is 0 by construction under normals
(forecast rain == normal rain). That states "typical season" honestly --
a normals-based forecast cannot foresee a typhoon, and must not pretend to.
"""

import numpy as np
import pandas as pd

TAG_OBSERVED = "observed"
TAG_NORMAL = "normal"
TAG_SCENARIO = "scenario"


def build_normals(panel, value_cols=("mean_temp_C", "rainfall_mm", "humidity_pct")):
    """Month-normals per region: {(slug, month) -> {col: mean}}.

    `panel` is the engineered panel restricted to the TRAIN window --
    normals must not peek at the future being forecast. Column names follow
    the caller's frame; only numeric month means are taken. Missing cells are
    skipped (a normal over fewer years beats a zero-filled one).
    """
    cols = [c for c in value_cols if c in panel.columns]
    grouped = panel.groupby(["slug", "month"])[cols].mean(numeric_only=True)
    return {(slug, m): row.to_dict() for (slug, m), row in grouped.iterrows()}


class OniOutlook:
    """ONI future paths. Default is persistence (last observed ONI carried
    forward); named scenarios shift it. All scenario output is tagged
    TAG_SCENARIO so forecasts built on it are conditional by construction."""

    def __init__(self, last_observed, scenario="persistence"):
        self.last = float(last_observed)
        self.scenario = scenario

    def at(self, steps_ahead):
        if self.scenario == "persistence":
            return self.last, TAG_SCENARIO
        shifts = {"neutral": 0.0, "el_nino": 0.8, "la_nina": -0.8}
        if self.scenario not in shifts:
            raise ValueError(f"unknown ONI scenario: {self.scenario}")
        # Ease toward the scenario anomaly over ~3 months, not a step jump.
        w = min(1.0, steps_ahead / 3.0)
        return self.last * (1 - w) + shifts[self.scenario] * w, TAG_SCENARIO


def future_frame(history, origin_period, horizon, normals, oni=None,
                 oni_scenario="persistence"):
    """Inference rows for one origin: H steps x n regions.

    `history` is the full engineered panel (train + observed test rows, sorted
    by slug/period). `origin_period` is 'YYYY-MM' (inclusive: last observed
    month). Returns (frame, provenance) where frame has one row per
    (region, h) with every model feature filled, and provenance maps
    (slug, period, feature) -> tag. Target months with observed cases keep
    them in an `actual_cases` column for backtest scoring (NaN beyond history).
    """
    hist = history.copy()
    hist["period"] = hist["year"].astype(int).astype(str) + "-" + \
        hist["month"].astype(int).astype(str).str.zfill(2)
    oy, om = int(origin_period[:4]), int(origin_period[5:7])

    def shift_period(year, month, dh):
        m = month + dh
        y = year + (m - 1) // 12
        m = (m - 1) % 12 + 1
        return y, m

    slugs = sorted(hist["slug"].unique())
    last_oni = {s: float(hist.loc[hist.slug == s].sort_values(
        ["year", "month"]).iloc[-1]["oni"]) for s in slugs}
    outlooks = {s: OniOutlook(last_oni[s], oni_scenario) for s in slugs}
    last_ovi = {s: float(hist.loc[hist.slug == s].sort_values(
        ["year", "month"]).iloc[-1]["ovitrap_pct"]) for s in slugs}

    obs = hist.set_index(["slug", "year", "month"])
    pop_at_origin = hist.loc[(hist.year == oy)].set_index("slug")

    rows, prov = [], {}
    for slug in slugs:
        pop_row = pop_at_origin.loc[slug].iloc[0] if slug in pop_at_origin.index else None
        for h in range(1, horizon + 1):
            y, m = shift_period(oy, om, h)
            period = f"{y:04d}-{m:02d}"
            row = {"slug": slug, "year": y, "month": m, "period": period, "h": h}

            def take(col, lag, as_, normal_col=None, carry=None):
                """Value of `col` at (target - lag): observed history if the
                lag still reaches back to <= origin, else the normal fallback,
                else the scenario carry. Provenance recorded under `as_`."""
                ty, tm = shift_period(y, m, -lag)
                key = (slug, ty, tm)
                if (ty < oy or (ty == oy and tm <= om)) and key in obs.index:
                    v = obs.loc[key, col]
                    v = float(v.iloc[0]) if hasattr(v, "iloc") else float(v)
                    if np.isfinite(v):
                        prov[(slug, period, as_)] = TAG_OBSERVED
                        return v
                nkey = (slug, m)
                if normal_col is not None and nkey in normals \
                        and normal_col in normals[nkey] \
                        and np.isfinite(normals[nkey][normal_col]):
                    prov[(slug, period, as_)] = TAG_NORMAL
                    return float(normals[nkey][normal_col])
                prov[(slug, period, as_)] = TAG_SCENARIO
                return carry() if callable(carry) else carry

            def month_normal(col_substr):
                for c, v in normals.get((slug, m), {}).items():
                    if col_substr in c.lower() and np.isfinite(v):
                        return v
                return np.nan

            # Cases: lag12 always reaches history for h<=12; lag1 is filled by
            # the recursive driver per path (placeholder NaN here).
            row["cases_lag12"] = take("dengue_cases", 12, "cases_lag12")
            row["cases_lag1"] = np.nan
            prov[(slug, period, "cases_lag1")] = "recursive-path"

            row["temp_lag3"] = take("mean_temp_C", 3, "temp_lag3", "mean_temp_C")
            row["humidity_lag1"] = take("humidity_pct", 1, "humidity_lag1", "humidity_pct")
            row["rainfall_lag1"] = take("rainfall_mm", 1, "rainfall_lag1", "rainfall_mm")
            nval = month_normal("rain")
            if prov.get((slug, period, "rainfall_lag1")) == TAG_OBSERVED and np.isfinite(nval):
                row["rainfall_anomaly_mm"] = row["rainfall_lag1"] - nval
                prov[(slug, period, "rainfall_anomaly_mm")] = TAG_OBSERVED
            else:
                # Forecast rain == normal rain, so the anomaly is 0 exactly:
                # "typical season". A normals-based forecast cannot foresee a
                # typhoon and must not pretend to.
                row["rainfall_anomaly_mm"] = 0.0
                prov[(slug, period, "rainfall_anomaly_mm")] = TAG_NORMAL

            ty3, tm3 = shift_period(y, m, -3)
            if oni is not None:
                row["oni_lag3"], prov[(slug, period, "oni_lag3")] = float(oni), TAG_SCENARIO
            elif (ty3 < oy or (ty3 == oy and tm3 <= om)) and (slug, ty3, tm3) in obs.index:
                v = obs.loc[(slug, ty3, tm3), "oni"]
                v = float(v.iloc[0]) if hasattr(v, "iloc") else float(v)
                row["oni_lag3"], prov[(slug, period, "oni_lag3")] = v, TAG_OBSERVED
            else:
                row["oni_lag3"], prov[(slug, period, "oni_lag3")] = outlooks[slug].at(h)

            # Ovitrap: no future surveillance exists; carry the last observed
            # value from h=1 on. The tag keeps the forecast conditional on it.
            if h == 1:
                row["ovitrap_lag1"] = take("ovitrap_pct", 1, "ovitrap_lag1",
                                           carry=last_ovi[slug])
            else:
                row["ovitrap_lag1"] = last_ovi[slug]
                prov[(slug, period, "ovitrap_lag1")] = TAG_SCENARIO

            if pop_row is not None:
                row["population"] = int(pop_row["population"])
                row["pop_density_km2"] = float(pop_row["pop_density_km2"])
            else:
                row["population"], row["pop_density_km2"] = np.nan, np.nan
            row["month_sin"] = np.sin(2 * np.pi * m / 12)
            row["month_cos"] = np.cos(2 * np.pi * m / 12)

            try:
                row["actual_cases"] = float(obs.loc[(slug, y, m), "dengue_cases"])
            except KeyError:
                row["actual_cases"] = np.nan
            rows.append(row)

    frame = pd.DataFrame(rows)
    frame["cases_lag1_log"] = np.nan  # filled per recursive path
    frame["cases_lag12_log"] = np.log1p(frame["cases_lag12"].clip(lower=0))
    frame["log_pop"] = np.log(frame["population"])
    frame["log_density"] = np.log(frame["pop_density_km2"])
    return frame, prov


def provenance_summary(prov):
    """Share of assumed cells by tag -- the one-line honesty metric."""
    tags = list(prov.values())
    total = len(tags) or 1
    return {t: sum(1 for x in tags if x == t) / total
            for t in (TAG_OBSERVED, TAG_NORMAL, TAG_SCENARIO, "recursive-path")}
