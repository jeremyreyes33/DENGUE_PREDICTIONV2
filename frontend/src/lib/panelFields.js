/*
 * Field mapping between the live API panel and the synthetic DEMO FIXTURE CSV,
 * plus the small time-series helpers every lag-aware view needs.
 *
 * The two sources name the same quantities differently, and the API panel does
 * not (yet) serve lags, ONI, ovitrap or rainfall anomalies -- those columns
 * exist only in:
 *
 *   RESEARCH DATA SET/SYNTHETIC DEMO FIXTURE - DO NOT USE AS REAL DATA/
 *
 * Every consumer goes through FIELD_MAP so a future `/api/panel` extension
 * (lag columns, enso_index backfill, vector_data) lands in one place instead
 * of being re-discovered per page. `api: null` means "not servable today":
 * the UI must render those cells as missing, never as zero.
 */

export const FIELD_MAP = {
  cases: {
    api: 'confirmed_cases', csv: 'dengue_cases', label: 'Dengue cases', unit: 'cases',
  },
  deaths: {
    api: 'deaths', csv: 'dengue_deaths', label: 'Deaths', unit: 'deaths',
  },
  incidence: {
    api: 'incidence_per_100k', csv: 'incidence_per100k', label: 'Incidence', unit: 'per 100k',
  },
  temperature: {
    api: 'temperature', csv: 'mean_temp_C', label: 'Mean temperature', unit: '°C',
    bestLag: 3,
  },
  rainfall: {
    api: 'rainfall', csv: 'rainfall_mm', label: 'Mean precipitation', unit: 'mm',
    bestLag: 1,
  },
  humidity: {
    api: 'humidity', csv: 'humidity_pct', label: 'Mean relative humidity', unit: '%',
    bestLag: 1,
  },
  hotDays: {
    api: 'hot_days', csv: 'hot_days', label: 'Hot days (>35 °C)', unit: 'days',
    bestLag: 3,
  },
  rainfallAnomaly: {
    api: null, csv: 'rainfall_anomaly_mm', label: 'Rainfall anomaly', unit: 'mm',
    bestLag: 1,
    note: 'Observed minus the ERA5 month-normal: the decision variable. Raw mm punishes naturally-wet regions every month.',
  },
  oni: {
    api: null, csv: 'oni', label: 'ONI (El Niño index)', unit: '°C anomaly',
    bestLag: 3,
    note: 'Needs the climate_data.enso_index backfill from the NOAA ONI series.',
  },
  ovitrap: {
    api: null, csv: 'ovitrap_lag1', label: 'Ovitrap index', unit: '% traps positive',
    bestLag: 1,
    note: 'Needs vector_data (larval/adult surveillance); that table is empty in production.',
  },
  population: {
    api: 'population', csv: 'population', label: 'Population', unit: 'people',
  },
  density: {
    api: 'population_density', csv: 'pop_density_km2', label: 'Population density', unit: 'per km²',
    bestLag: null,
  },
}

/* Feature names as the importance endpoint spells them, for driver sentences. */
export const FEATURE_LABELS = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  rainfall: 'Rainfall',
  rainfall_anomaly: 'Rainfall anomaly',
  oni: 'ONI (El Niño)',
  ovitrap: 'Ovitrap index',
  cases_lag1: 'Last month’s cases',
  cases_lag12: 'Same month last year',
  population_density: 'Population density',
  population: 'Population',
  hot_days: 'Hot days',
}

export function featureLabel(feature, lagMonths) {
  const base = FEATURE_LABELS[feature] ?? String(feature).replace(/_/g, ' ')
  if (lagMonths === null || lagMonths === undefined) return `${base} (static)`
  return `${base} (lag ${lagMonths} mo)`;
}

/*
 * mysql2 returns a DATE as a JS Date at local midnight, which JSON-encodes to
 * the previous day in UTC+8 -- a forecast stored as 2019-08-01 arrives as
 * 2019-07-31T16:00:00.000Z. Shifting by +8h before slicing keys every row on
 * the Philippine calendar month deterministically, whatever zone views it.
 * The panel's `period` field is still preferred wherever it exists.
 */
export function periodFromDbDate(value) {
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return null;
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 7);
}

/*
 * Shift a monthly series back by k months. The leading k slots are null --
 * never zero: a zero would teach a reader (or a model) a case crash that
 * never happened. This mirrors the ETL's own rule for blank 2021 cells.
 */
export function lagValues(values, k) {
  if (k <= 0) return [...values];
  return [...Array(k).fill(null), ...values.slice(0, Math.max(0, values.length - k))];
}

export function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]])
    .filter(([x, y]) => x !== null && x !== undefined && y !== null && y !== undefined
      && Number.isFinite(Number(x)) && Number.isFinite(Number(y)));
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, [x]) => s + Number(x), 0) / n;
  const my = pairs.reduce((s, [, y]) => s + Number(y), 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (Number(x) - mx) * (Number(y) - my);
    sxx += (Number(x) - mx) ** 2;
    syy += (Number(y) - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/* Cross-correlation of cases against a climate series at lags 0..maxLag. */
export function ccfByLag(cases, climate, maxLag = 6) {
  return Array.from({ length: maxLag + 1 }, (_, lag) => ({
    lag,
    r: pearson(cases, lagValues(climate, lag)),
  }));
}

/*
 * Run pickers scoped by horizon. compare() exposes horizon_months (DECIMAL on
 * the wire, hence Number()), and NULL on pre-horizon seed rows reads as 1 --
 * the only horizon those runs could have produced. Pages that render monthly
 * one-step forecasts MUST filter horizon 1: without it, the newest run wins
 * regardless of regime, and a 6-row recursive run silently replaces a
 * 12-month forecast (which is exactly what happened when runs 14-16 landed).
 */
export function pickRun(runs, { hybridOnly = false, horizon = 1 } = {}) {
  const pool = (runs ?? []).filter((r) => (
    (!hybridOnly || /hybrid/i.test(r.model_type ?? ''))
    && Number(r.horizon_months ?? 1) === horizon
  ));
  pool.sort((a, b) => String(b.trained_at ?? '').localeCompare(String(a.trained_at ?? ''))
    || (b.id ?? 0) - (a.id ?? 0));
  return pool[0] ?? null;
}

/*
 * Latest trained run whose model_type names the hybrid -- the Drivers page
 * selects it the same way, so every page points at the same run. Newest
 * trained_at wins, id breaks ties (seeded runs share a timestamp).
 * Horizon defaults to 1: the Response page ranks one-step monthly forecasts,
 * and recursive runs are a different regime, not a newer version.
 */
export function pickHybridRun(runs) {
  return pickRun(runs, { hybridOnly: true, horizon: 1 });
}

/* Newest recursive run (horizon > 1), for the multi-step fan. Null when the
   harness has never run with --horizon > 1. */
export function pickLatestRecursiveRun(runs) {
  const pool = (runs ?? []).filter((r) => Number(r.horizon_months ?? 1) > 1);
  pool.sort((a, b) => String(b.trained_at ?? '').localeCompare(String(a.trained_at ?? ''))
    || (b.id ?? 0) - (a.id ?? 0));
  return pool[0] ?? null;
}

export function listRecursiveRuns(runs) {
  const pool = (runs ?? []).filter((r) => Number(r.horizon_months ?? 1) > 1);
  pool.sort((a, b) => String(b.trained_at ?? '').localeCompare(String(a.trained_at ?? ''))
    || (b.id ?? 0) - (a.id ?? 0));
  return pool;
}

export const MONTHS_2019 = Array.from({ length: 12 }, (_, i) => `2019-${String(i + 1).padStart(2, '0')}`);
export const MONTHS_2020 = Array.from({ length: 12 }, (_, i) => `2020-${String(i + 1).padStart(2, '0')}`);
export const INTERVAL_LEVELS = [50, 80, 95];

/*
 * Shift a 'YYYY-MM' period by dh months. Zero-padded months compare
 * lexicographically, so callers can filter series with plain >= on top.
 */
export function shiftMonth(period, dh) {
  const [y, m] = String(period).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  const total = y * 12 + (m - 1) + dh;
  const ry = Math.floor(total / 12);
  const rm = (total % 12) + 1;
  return `${ry}-${String(rm).padStart(2, '0')}`;
}

/*
 * Rainfall anomaly, client-side. The API panel serves raw monthly rainfall;
 * "wetter than usual" needs a baseline, and the honest local one is the
 * place-month mean across the panel window (2016-2020): the same calendar
 * month, the same region, five years. buildRainfallNormals keys that as
 * `${region_slug}|${month(1-12)}`; rainAnomaly sums observed-minus-normal
 * over any row set, so a single month and a whole year both work. Rows with
 * missing rainfall are skipped, never zero-filled. Municipal scope has no
 * climate columns at all, so both helpers return nothing usable there --
 * callers must render missing, not zero.
 */
export function buildRainfallNormals(panelRows) {
  const sums = new Map();
  for (const r of panelRows ?? []) {
    const rain = Number(r.rainfall);
    if (!Number.isFinite(rain)) continue;
    const key = `${r.region_slug}|${Number(r.month)}`;
    const cur = sums.get(key) ?? { total: 0, n: 0 };
    cur.total += rain;
    cur.n += 1;
    sums.set(key, cur);
  }
  const normals = new Map();
  for (const [key, { total, n }] of sums) {
    if (n > 0) normals.set(key, total / n);
  }
  return normals;
}

export function rainAnomaly(rows, normals) {
  let rain = 0;
  let anomaly = 0;
  let n = 0;
  for (const r of rows ?? []) {
    const observed = Number(r.rainfall ?? r.rain);
    if (!Number.isFinite(observed)) continue;
    const normal = normals.get(`${r.region_slug ?? r.slug}|${Number(r.month)}`);
    if (normal === undefined) continue;
    rain += observed;
    anomaly += observed - normal;
    n += 1;
  }
  if (n === 0) return { rain: null, anomaly: null, months: 0 };
  return { rain, anomaly, months: n };
}
