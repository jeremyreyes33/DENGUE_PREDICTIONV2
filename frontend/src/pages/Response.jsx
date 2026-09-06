import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useFetch } from '../hooks/useFetch.js'
import { alertsApi, modelsApi, panelApi, predictionsApi, regionsApi } from '../services/api.js'
import { Card, CardBody, CardHead } from '../components/Card.jsx'
import { Notice, PageHeader, Select } from '../components/Controls.jsx'
import { AsyncSection, EmptyState, SkeletonRows } from '../components/States.jsx'
import DataTable from '../components/DataTable.jsx'
import EvaluationBanner from '../components/EvaluationBanner.jsx'
import RiskBadge from '../components/RiskBadge.jsx'
import Sparkline from '../components/Sparkline.jsx'
import StatCard from '../components/StatCard.jsx'
import { formatInt, riskRank, toNumber } from '../lib/format.js'
import {
  INTERVAL_LEVELS, MONTHS_2019, MONTHS_2020,
  featureLabel, periodFromDbDate, pickHybridRun,
} from '../lib/panelFields.js';

/*
 * Outbreak response: the resource-allocation view. One row per region joins
 * observed cases (panel) with the hybrid run's forecast band at the selected
 * interval level, sorted by worst case first. A row IS a deployment
 * recommendation; the table is the decision object, everything else supports it.
 *
 * Two honesties are load-bearing here:
 * - The 3-month horizon sums medians AND interval bounds, but a summed bound
 *   is a planning scenario, not a calibrated 3-month interval. It is labelled
 *   as such wherever it appears.
 * - The beds gap column renders an em dash until DOH capacity data lands. A
 *   zero would claim spare beds that were never counted.
 */

// Region slug -> staffed beds. Empty until DOH capacity data lands; the gap
// column keys off this and stays an em dash while it is.
const BED_CAPACITY = {};

function fmtCount(v) {
  return v === null || v === undefined ? '—' : formatInt(v);
}

function sumOrNull(values) {
  if (values.some((v) => v === null || v === undefined)) return null;
  return values.reduce((s, v) => s + v, 0);
}

export default function Response() {
  const [params, setParams] = useSearchParams();
  const show2020 = params.get('show2020') === '1';
  const monthOptions = show2020 ? [...MONTHS_2019, ...MONTHS_2020] : MONTHS_2019;
  const rawMonth = params.get('month');
  const month = monthOptions.includes(rawMonth) ? rawMonth : '2019-09';
  const rawLevel = params.get('level');
  const level = INTERVAL_LEVELS.map(String).includes(rawLevel) ? rawLevel : '95';
  const horizon = params.get('horizon') === '3' ? '3' : '1';

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value === null || value === undefined) next.delete(key);
    else next.set(key, value);
    // Leaving the 2020 view with a 2020 month selected would strand the page
    // on a month outside its options, so fall back to the epidemic peak.
    if (key === 'show2020' && value !== '1' && (next.get('month') ?? '').startsWith('2020')) {
      next.set('month', '2019-09');
    }
    setParams(next);
  };

  const { data: regions, loading: regionsLoading, error: regionsError, refetch: refetchRegions } =
    useFetch(() => regionsApi.list('region'), []);
  const { data: runs } = useFetch(() => modelsApi.compare(), []);
  const hybrid = useMemo(() => pickHybridRun(runs ?? []), [runs]);

  const panelTo = show2020 ? '2020-12' : '2019-12';
  const { data: panel, loading: panelLoading, error: panelError, refetch: refetchPanel } =
    useFetch(() => panelApi.get({ from: '2019-01', to: panelTo }), [panelTo]);

  const { data: risks } = useFetch(() => alertsApi.regions(), []);
  const riskBySlug = useMemo(() => {
    const map = {};
    for (const r of risks ?? []) map[r.region_slug] = r.risk_level ?? null;
    return map;
  }, [risks]);

  const { data: importance } = useFetch(
    () => (hybrid ? modelsApi.importance(hybrid.id, 'global') : Promise.resolve([])),
    [hybrid?.id],
  );
  const topDriver = useMemo(
    () => (importance ?? []).find((r) => Number(r.crosses_zero) === 0) ?? null,
    [importance],
  );

  // One request per region against the hybrid run at the selected interval
  // level. Failures resolve to [] so one bad region cannot blank the table;
  // its forecast cells correctly render as missing.
  const { data: forecasts, loading: fcLoading } = useFetch(() => {
    if (!regions?.length || !hybrid) return Promise.resolve({});
    return Promise.all(arraySafe(regions).map((r) => (
      predictionsApi.forRegion(r.id, hybrid.id, level)
        .then((rows) => [r.id, rows])
        .catch(() => [r.id, []])
    ))).then((pairs) => Object.fromEntries(pairs));
  }, [regions, hybrid?.id, level]);

  const panelBySlug = useMemo(() => {
    const map = {};
    for (const row of panel ?? []) {
      (map[row.region_slug] ??= []).push(row);
    }
    for (const rows of Object.values(map)) rows.sort((a, b) => (a.period < b.period ? -1 : 1));
    return map;
  }, [panel]);

  // The quarter under a 3-month horizon, clamped to months the page can show.
  const windowMonths = useMemo(() => {
    if (horizon !== '3') return [month];
    const i = monthOptions.indexOf(month);
    return monthOptions.slice(i, i + 3);
  }, [horizon, month, monthOptions]);
  const windowLabel = windowMonths.length > 1
    ? `${windowMonths[0]} → ${windowMonths[windowMonths.length - 1]}`
    : month;

  const rows = useMemo(() => {
    if (!regions?.length) return [];
    return regions.map((region) => {
      const obs = windowMonths.map((p) => {
        const hit = (panelBySlug[region.slug] ?? []).find((r) => r.period === p);
        return hit ? toNumber(hit.confirmed_cases) : null;
      });
      const fcRows = forecasts?.[region.id] ?? [];
      const fcByPeriod = {};
      for (const f of fcRows) {
        const p = periodFromDbDate(f.date);
        if (p) fcByPeriod[p] = f;
      }
      const med = windowMonths.map((p) => {
        const f = fcByPeriod[p];
        const v = f ? toNumber(f.predicted_median ?? f.predicted_cases) : null;
        return v;
      });
      const upp = windowMonths.map((p) => {
        const f = fcByPeriod[p];
        return f ? toNumber(f.ci_upper) : null;
      });
      const history = (panelBySlug[region.slug] ?? [])
        .filter((r) => r.period <= month)
        .slice(-6)
        .map((r) => toNumber(r.confirmed_cases))
        .filter((v) => v !== null);
      const beds = BED_CAPACITY[region.slug];
      const worst = sumOrNull(upp);
      return {
        slug: region.slug,
        name: region.name,
        observed: sumOrNull(obs),
        median: sumOrNull(med),
        worst,
        gap: beds === undefined || worst === null ? null : beds - worst,
        trend: history,
        risk: riskBySlug[region.slug] ?? null,
      };
    }).sort((a, b) => (b.worst ?? -1) - (a.worst ?? -1) || (b.observed ?? -1) - (a.observed ?? -1));
  }, [regions, panelBySlug, forecasts, riskBySlug, windowMonths, month]);

  const monthlyTotals = useMemo(() => {
    const sum = (period, pick) => (regions ?? []).reduce((s, region) => {
      const hit = (panelBySlug[region.slug] ?? []).find((r) => r.period === period);
      const v = hit ? toNumber(pick(hit)) : null;
      return v === null ? s : s + v;
    }, 0);
    return {
      observed: monthOptions.filter((p) => p <= month).map((p) => sum(p, (r) => r.confirmed_cases)),
    };
  }, [regions, panelBySlug, monthOptions, month]);

  const sumCol = (key) => rows.reduce((s, r) => (r[key] === null ? s : s + r[key]), 0);
  const highCount = rows.filter((r) => r.risk && riskRank(r.risk) >= riskRank('high')).length;
  const cards = rows.filter((r) => r.worst !== null).slice(0, 3);
  const is2020 = month.startsWith('2020');

  const loading = regionsLoading || panelLoading || fcLoading;
  const error = regionsError ?? panelError;
  const refetch = () => { refetchRegions(); refetchPanel(); };

  return (
    <>
      <PageHeader
        title="Outbreak response"
        description={`Where to send teams ${horizon === '3' ? `for ${windowLabel}` : `in ${month}`} — observed cases against the hybrid run's forecast at the ${level}% interval, worst case first.`}
      />
      {hybrid && <EvaluationBanner run={hybrid} />}

      <Card>
        <CardBody>
          <div className="filter-bar">
            <Select
              label="Month"
              value={month}
              onChange={(v) => setParam('month', v)}
              options={monthOptions.map((p) => ({ value: p, label: p }))}
            />
            <div className="segmented" role="group" aria-label="Forecast horizon">
              <button type="button" aria-pressed={horizon === '1'} onClick={() => setParam('horizon', '1')}>1-month</button>
              <button type="button" aria-pressed={horizon === '3'} onClick={() => setParam('horizon', '3')}>3-month</button>
            </div>
            <div className="segmented" role="group" aria-label="Credible interval level">
              {INTERVAL_LEVELS.map((l) => (
                <button key={l} type="button" aria-pressed={level === String(l)} onClick={() => setParam('level', String(l))}>
                  {l}%
                </button>
              ))}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={show2020}
                onChange={(e) => setParam('show2020', e.target.checked ? '1' : null)}
              />
              Show 2020 anomaly
            </label>
          </div>
          {horizon === '3' && (
            <Notice tone="info">
              The 3-month upper bound sums three monthly bounds: a planning scenario, not a calibrated
              3-month interval. Read it as “how bad could the quarter get”, not as coverage evidence.
              How the monthly intervals are built: <Link to="/forecast">Forecast › How this forecast is computed</Link>.
            </Notice>
          )}
          {is2020 && (
            <Notice tone="warning">
              2020 is the COVID surveillance break — the model was never scored on it and holds no
              forecasts for it. Observed counts below are shown for anomaly inspection only.
            </Notice>
          )}
        </CardBody>
      </Card>

      <AsyncSection
        loading={loading}
        error={error}
        isEmpty={!loading && !error && rows.length === 0}
        onRetry={refetch}
        skeleton={<SkeletonRows rows={8} />}
        empty={(
          <EmptyState
            icon="shield"
            title={hybrid ? 'No regions to rank' : 'No hybrid model run found'}
            body={hybrid
              ? 'The region list came back empty.'
              : 'Response ranks the hybrid run’s forecasts. Train the model service first, then reload.'}
          />
        )}
      >
        <div className="grid grid-4">
          <StatCard
            label="Regions high risk or above"
            value={formatInt(highCount)}
            sublabel={`${rows.length} regions ranked · ${windowLabel}`}
          />
          <StatCard
            label={`Forecast caseload${horizon === '3' ? ' (quarter)' : ''}`}
            value={fmtCount(sumCol('median'))}
            sublabel={`Hybrid median · ${windowLabel}`}
          />
          <StatCard
            label="Worst-case caseload"
            value={fmtCount(sumCol('worst'))}
            sublabel={`${level}% upper bound · ${windowLabel}`}
            trend={monthlyTotals.observed}
          />
          <StatCard
            label="Observed cases"
            value={fmtCount(sumCol('observed'))}
            sublabel={`Surveillance · ${windowLabel}`}
            trend={monthlyTotals.observed}
          />
        </div>

        <Card>
          <CardHead
            title="Regional allocation ranking"
            description="Worst case first. The beds gap stays blank until DOH capacity data lands — a dash is honest, a zero would be a lie."
          />
          <CardBody flush>
            <DataTable
              caption={`Regional dengue allocation ranking for ${windowLabel}`}
              getRowKey={(r) => r.slug}
              rows={rows}
              columns={[
                { key: 'name', header: 'Region' },
                {
                  key: 'risk', header: 'Risk',
                  render: (r) => <RiskBadge level={r.risk ?? 'unknown'} />,
                },
                { key: 'observed', header: 'Observed', align: 'right', render: (r) => fmtCount(r.observed) },
                { key: 'median', header: 'Forecast', align: 'right', render: (r) => fmtCount(r.median) },
                { key: 'worst', header: `Worst case (${level}%)`, align: 'right', render: (r) => fmtCount(r.worst) },
                { key: 'gap', header: 'Beds gap', align: 'right', render: (r) => fmtCount(r.gap) },
                {
                  key: 'trend', header: 'Trend',
                  render: (r) => (r.trend.length > 1 ? <Sparkline values={r.trend} /> : '—'),
                },
              ]}
            />
          </CardBody>
        </Card>

        {cards.length > 0 && (
          <Card>
            <CardHead
              title="Deploy first"
              description={topDriver
                ? `Leading signal: ${featureLabel(topDriver.feature, topDriver.lag_months)}. Per-region drivers live on the Drivers page.`
                : 'Per-region drivers live on the Drivers page.'}
            />
            <CardBody>
              {/* Top-3 as rank rows, not custom cards: the rank-list pattern is
                  already responsive and already pairs every value with text. */}
              <div className="rank-list">
                {cards.map((r, i) => {
                  const top = cards[0]?.worst || 1;
                  return (
                    <div className="rank-row" key={r.slug}>
                      <span className="rank-index">{i + 1}</span>
                      <span className="rank-body">
                        <span className="rank-head">
                          <span className="rank-name">{r.name}</span>
                          <RiskBadge level={r.risk ?? 'unknown'} />
                          <span className="rank-value">{fmtCount(r.worst)} worst case</span>
                        </span>
                        <span className="bar-track" style={{ height: 6 }}>
                          <span
                            className="bar-fill"
                            style={{ height: 6, width: `${Math.max(((r.worst ?? 0) / top) * 100, 2)}%`, background: 'var(--seq-500)' }}
                          />
                        </span>
                        <span className="rank-meta">
                          Forecast {fmtCount(r.median)} · observed {fmtCount(r.observed)} ·{' '}
                          <Link to="/forecast">Open forecast</Link>
                          {' · '}
                          <Link to="/drivers">Why this region</Link>
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        )}

        <Notice tone="info">
          Bed-capacity data is pending — the gap column activates when DOH figures land in
          <code className="mono"> BED_CAPACITY </code>
          in <code className="mono">pages/Response.jsx</code>.
        </Notice>
      </AsyncSection>
    </>
  );
}

/* Array guard: regions is expected to be an array, but a malformed payload
   must degrade to an empty table, not a thrown TypeError inside Promise.all. */
function arraySafe(value) {
  return Array.isArray(value) ? value : [];
}
