import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useFetch } from '../hooks/useFetch.js'
import { alertsApi, casesApi, modelsApi, panelApi, predictionsApi, regionsApi } from '../services/api.js'
import { Card, CardBody, CardHead } from '../components/Card.jsx'
import { LegendItem, PageHeader, Select, ViewToggle } from '../components/Controls.jsx'
import { AsyncSection, EmptyState, SkeletonBlock } from '../components/States.jsx'
import ChartTooltip from '../components/ChartTooltip.jsx'
import DataTable from '../components/DataTable.jsx'
import StatCard from '../components/StatCard.jsx'
import CorrelationPanel from '../components/CorrelationPanel.jsx'
import LagExplorer from '../components/LagExplorer.jsx'
import Icon from '../components/Icon.jsx'
import { useChartTheme } from '../lib/useChartTheme.js'
import { pickRun, pickLatestRecursiveRun, listRecursiveRuns, periodFromDbDate, shiftMonth } from '../lib/panelFields.js'
import EvaluationBanner from '../components/EvaluationBanner.jsx'
import { dayKey, formatDate, formatInt, formatNumber, riskRank, toNumber } from '../lib/format.js'

/*
 * Observed history and the model's forecast are two series on ONE axis (both
 * are weekly case counts), plus the Bayesian credible interval drawn as a
 * range band -- Recharts renders a band when the dataKey resolves to a
 * [lo, hi] pair. That replaces the previous trick of painting a
 * background-coloured area over the lower bound, which only ever worked while
 * the page behind the chart was one opaque colour.
 */
function mergeSeries(cases, predictions) {
  const byDay = new Map()

  const touch = (date) => {
    const key = dayKey(date)
    if (!byDay.has(key)) {
      byDay.set(key, { key, date, observed: null, forecast: null, lower: null, upper: null, band: null })
    }
    return byDay.get(key)
  }

  for (const row of cases ?? []) {
    touch(row.date).observed = toNumber(row.confirmed_cases)
  }

  for (const row of predictions ?? []) {
    const point = touch(row.date)
    point.forecast = toNumber(row.predicted_cases)
    point.lower = toNumber(row.ci_lower)
    point.upper = toNumber(row.ci_upper)
    // Only a complete pair can be drawn as a band.
    point.band = point.lower !== null && point.upper !== null ? [point.lower, point.upper] : null
  }

  return [...byDay.values()].sort((a, b) => new Date(a.date) - new Date(b.date))
}

/*
 * Fan merge: observed history keyed by calendar month (periodFromDbDate
 * neutralises the DATE-serialisation quirk deterministically) plus the
 * median and the three stored interval levels. Levels arrive as three
 * separate fetches and are joined here; a missing level degrades its band
 * to null rather than shifting the others.
 */
function mergeFanSeries(cases, byLevel) {
  const byPeriod = new Map()
  const touch = (period) => {
    if (!byPeriod.has(period)) {
      byPeriod.set(period, {
        period, observed: null, median: null,
        lo95: null, hi95: null, lo80: null, hi80: null, lo50: null, hi50: null,
        band95: null, band80: null, band50: null,
      })
    }
    return byPeriod.get(period)
  }

  for (const row of cases ?? []) {
    const period = periodFromDbDate(row.date)
    if (period) touch(period).observed = toNumber(row.confirmed_cases)
  }

  for (const level of [95, 80, 50]) {
    for (const row of byLevel?.[level] ?? []) {
      const period = periodFromDbDate(row.date)
      if (!period) continue
      const point = touch(period)
      if (level === 95) point.median = toNumber(row.predicted_median ?? row.predicted_cases)
      const lo = toNumber(row.ci_lower)
      const hi = toNumber(row.ci_upper)
      point[`lo${level}`] = lo
      point[`hi${level}`] = hi
      point[`band${level}`] = lo !== null && hi !== null ? [lo, hi] : null
    }
  }

  return [...byPeriod.values()].sort((a, b) => (a.period < b.period ? -1 : 1))
}

function bandCell(lo, hi) {
  if (lo === null || hi === null) return <span className="cell-quiet">—</span>
  return `${formatInt(lo)} – ${formatInt(hi)}`
}

/*
 * Multi-step fan: one recursive origin, nested 50/80/95 bands, and the
 * origin line where history ends and sampling begins. Pure presentational --
 * every number arrives via props, so the tab cannot pick a different run
 * than its selector states.
 */
function FanTab({
  t, regionName, recursiveRuns, activeFanRun, activeFanRunId, onRunChange,
  fanSeries, fanPoints, fanGrowth, fanOrigin, fanExog,
  fanView, onViewChange, loading, error, onRetry,
}) {
  if (!recursiveRuns.length && !loading) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon="models"
            title="No recursive runs stored"
            body="Multi-step fans are written by the model service with --horizon greater than 1 (for example: python validate_harness.py --horizon 6 --origin 2019-06). Once such a run exists it appears in the selector above."
          />
        </CardBody>
      </Card>
    )
  }

  const peak = fanPoints.reduce((best, d) => (best && best.median >= d.median ? best : d), null)

  return (
    <>
      {activeFanRun && <EvaluationBanner run={activeFanRun} />}

      <Card>
        <CardBody>
          <div className="filter-bar">
            <span className="filter-bar-label">Recursive run</span>
            <Select
              label="Recursive run"
              hideLabel
              value={activeFanRunId ?? ''}
              disabled={!recursiveRuns.length}
              onChange={onRunChange}
              options={recursiveRuns.map((r) => ({
                value: r.id,
                label: `${r.model_type} · ${String(r.test_start ?? '').slice(0, 7)} → ${String(r.test_end ?? '').slice(0, 7)}`,
              }))}
            />
            <span className="filter-bar-spacer" />
            <ViewToggle view={fanView} onChange={onViewChange} label="Fan view" />
          </div>
          {fanExog && <p className="muted" style={{ marginBottom: 0 }}>Future inputs: {fanExog}</p>}
        </CardBody>
      </Card>

      <div className="grid grid-4">
        <StatCard label="Forecast origin" value={fanOrigin ?? '—'} sublabel="Last observed month; sampling starts after it" />
        <StatCard label="Horizon" value={fanPoints.length ? `${fanPoints.length} months` : '—'} sublabel={fanOrigin ? `Starting after ${fanOrigin}` : '—'} />
        <StatCard
          label="Fan widening"
          value={fanGrowth !== null ? `×${fanGrowth.toFixed(1)}` : '—'}
          sublabel="95% width, last vs first horizon month"
        />
        <StatCard
          label="Peak median"
          value={peak ? formatInt(peak.median) : '—'}
          sublabel={peak ? `Month of ${peak.period}` : 'No forecast points'}
        />
      </div>

      <Card className="section-gap">
        <CardHead
          title={`Multi-step fan — ${regionName}`}
          description="Observed history, then sampled futures feeding their own lags forward. The fan widens because uncertainty compounds — a fan that does not widen is median-plugging, not forecasting."
          actions={<ViewToggle view={fanView} onChange={onViewChange} label="Fan view" />}
        />
        <AsyncSection
          loading={loading}
          error={error}
          hasData={fanSeries.length > 0}
          isEmpty={fanSeries.length === 0}
          onRetry={onRetry}
          errorTitle="Could not load the fan"
          skeleton={<SkeletonBlock height={300} />}
          empty={(
            <EmptyState
              icon="models"
              title="No fan stored for this region and run"
              body="Pick another recursive run, or train one with a horizon greater than 1."
            />
          )}
        >
          {fanView === 'chart' ? (
            <CardBody>
              <div className="legend">
                <LegendItem shape="line" color={t.series2} label="Observed cases" />
                <LegendItem shape="line" color={t.series1} label="Median path" />
                <LegendItem shape="band" color={t.series1} label="95% band" />
                <LegendItem shape="band" color={t.series1} label="80% band" />
                <LegendItem shape="band" color={t.series1} label="50% band" />
              </div>
              <div className="chart-frame">
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={fanSeries} margin={{ top: 22, right: 52, bottom: 4, left: -6 }}>
                    <CartesianGrid stroke={t.grid} strokeWidth={1} vertical={false} />
                    <XAxis
                      dataKey="period"
                      tickFormatter={(v) => String(v).slice(2)}
                      tick={{ fill: t.ink3, fontSize: 11 }}
                      axisLine={{ stroke: t.axis }}
                      tickLine={false}
                      tickMargin={10}
                      minTickGap={24}
                    />
                    <YAxis
                      tick={{ fill: t.ink3, fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickMargin={8}
                      width={52}
                      tickFormatter={(v) => v.toLocaleString()}
                    />
                    <Tooltip
                      cursor={{ stroke: t.axis, strokeWidth: 1 }}
                      content={(
                        <ChartTooltip
                          labelFormatter={(v) => v}
                          valueFormatter={(value) => (Array.isArray(value)
                            ? `${formatInt(value[0])} – ${formatInt(value[1])}`
                            : formatInt(value))}
                        />
                      )}
                    />
                    {fanOrigin && (
                      <ReferenceLine
                        x={fanOrigin}
                        stroke={t.axis}
                        strokeWidth={1}
                        label={{
                          value: 'origin →',
                          position: 'insideTopLeft',
                          fill: t.ink3,
                          fontSize: 10,
                          offset: 8,
                        }}
                      />
                    )}
                    <Area dataKey="band95" name="95% band" stroke="none" fill={t.series1} fillOpacity={0.10} connectNulls={false} isAnimationActive={false} activeDot={false} />
                    <Area dataKey="band80" name="80% band" stroke="none" fill={t.series1} fillOpacity={0.16} connectNulls={false} isAnimationActive={false} activeDot={false} />
                    <Area dataKey="band50" name="50% band" stroke="none" fill={t.series1} fillOpacity={0.24} connectNulls={false} isAnimationActive={false} activeDot={false} />
                    <Line
                      dataKey="observed"
                      name="Observed cases"
                      type="monotone"
                      stroke={t.series2}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={{ r: 3.5, fill: t.series2, stroke: t.surface, strokeWidth: 2 }}
                      activeDot={{ r: 5, fill: t.series2, stroke: t.surface, strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="median"
                      name="Median path"
                      type="monotone"
                      stroke={t.series1}
                      strokeWidth={2}
                      strokeDasharray="7 3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={{ r: 3.5, fill: t.series1, stroke: t.surface, strokeWidth: 2 }}
                      activeDot={{ r: 5, fill: t.series1, stroke: t.surface, strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          ) : (
            <DataTable
              caption={`Multi-step fan values for ${regionName}`}
              rows={fanSeries}
              getRowKey={(row) => row.period}
              columns={[
                { key: 'period', header: 'Month' },
                { key: 'observed', header: 'Observed', align: 'right', render: (r) => (r.observed === null ? <span className="cell-quiet">—</span> : formatInt(r.observed)) },
                { key: 'median', header: 'Median', align: 'right', className: 'cell-strong', render: (r) => (r.median === null ? <span className="cell-quiet">—</span> : formatInt(r.median)) },
                { key: 'band50', header: '50% band', align: 'right', render: (r) => bandCell(r.lo50, r.hi50) },
                { key: 'band80', header: '80% band', align: 'right', render: (r) => bandCell(r.lo80, r.hi80) },
                { key: 'band95', header: '95% band', align: 'right', render: (r) => bandCell(r.lo95, r.hi95) },
                {
                  key: 'width',
                  header: 'Width (95%)',
                  align: 'right',
                  render: (r) => (r.lo95 === null || r.hi95 === null
                    ? <span className="cell-quiet">—</span>
                    : formatInt(r.hi95 - r.lo95)),
                },
              ]}
            />
          )}
        </AsyncSection>
      </Card>
    </>
  )
}

export default function Forecast() {
  const t = useChartTheme()
  const [regionId, setRegionId] = useState(null)
  const [view, setView] = useState('chart')
  const [tab, setTab] = useState('forecast')
  const [fanView, setFanView] = useState('chart')
  const [fanRunId, setFanRunId] = useState(null)

  const { data: regions, loading: regionsLoading } = useFetch(() => regionsApi.list('region'), [])
  const { data: alerts } = useFetch(() => alertsApi.list(), [])
  const { data: runs } = useFetch(() => modelsApi.compare(), [])

  /*
   * The explainer's status box retires itself: while every hybrid run is
   * DEMO-flagged it warns; the day a fitted hybrid run lands it downgrades to
   * provenance guidance instead. No code change needed on that day.
   */
  const hybridRuns = useMemo(
    () => (runs ?? []).filter((r) => /hybrid/i.test(r.model_type ?? '')
      && Number(r.horizon_months ?? 1) === 1),
    [runs],
  )
  const realHybridRuns = useMemo(
    () => hybridRuns.filter((r) => !/demo fixture/i.test(r.notes ?? '')),
    [hybridRuns],
  )

  /*
   * Land on the region that most needs looking at rather than whichever name
   * sorts first -- which on the seeded data is a region with no forecast at
   * all, so the page opened on an empty state.
   */
  const defaultRegionId = useMemo(() => {
    if (!regions?.length) return null
    const worst = (alerts ?? []).reduce(
      (acc, a) => (riskRank(a.risk_level) > riskRank(acc?.risk_level) ? a : acc),
      null,
    )
    const match = worst && regions.find((r) => r.name === worst.region_name)
    return (match ?? regions[0]).id
  }, [regions, alerts])

  const activeRegionId = regionId ?? defaultRegionId

  /*
   * Pinned to the horizon-1 hybrid run on purpose: the endpoint defaults to
   * the newest run overall, which silently switched this page to 6-row
   * recursive forecasts the day runs 14-16 landed. Multi-step fans live on
   * the fan tab, which pins its own run the same way.
   */
  const hybridOne = useMemo(
    () => pickRun(runs ?? [], { hybridOnly: true, horizon: 1 }),
    [runs],
  )

  const {
    data: predictions, loading: predLoading, error: predError, refetch: refetchPred,
  } = useFetch(
    () => (activeRegionId && hybridOne
      ? predictionsApi.forRegion(activeRegionId, hybridOne.id)
      : Promise.resolve([])),
    [activeRegionId, hybridOne?.id],
  )

  const { data: cases } = useFetch(
    () => (activeRegionId ? casesApi.list(activeRegionId) : Promise.resolve([])),
    [activeRegionId],
  )

  /*
   * Fan tab: recursive runs are a different regime, so the tab pins its own
   * run from the horizon>1 pool (selector below) instead of inheriting the
   * one-step pin above. Three level fetches join into nested bands; one bad
   * level degrades its band, never the tab.
   */
  const recursiveRuns = useMemo(() => listRecursiveRuns(runs ?? []), [runs])
  const defaultFanRunId = recursiveRuns[0]?.id ?? null
  const activeFanRunId = recursiveRuns.some((r) => String(r.id) === String(fanRunId))
    ? fanRunId
    : defaultFanRunId
  const activeFanRun = recursiveRuns.find((r) => String(r.id) === String(activeFanRunId)) ?? null

  const {
    data: fanBands, loading: fanLoading, error: fanError, refetch: refetchFan,
  } = useFetch(() => {
    if (!activeRegionId || !activeFanRunId) return Promise.resolve(null)
    return Promise.all(
      [95, 80, 50].map((level) => predictionsApi.forRegion(activeRegionId, activeFanRunId, level)
        .then((rows) => [level, rows])
        .catch(() => [level, []])),
    ).then((pairs) => Object.fromEntries(pairs))
  }, [activeRegionId, activeFanRunId])

  const fanOrigin = useMemo(() => {
    // The true origin is the last observed month: one step before the first
    // forecast month. Falls back to the run window only when no forecast rows
    // exist at all (in which case the tab renders its empty state anyway).
    const merged = mergeFanSeries(cases, fanBands)
    const first = merged.find((d) => d.median !== null)?.period ?? null
    if (first) return shiftMonth(first, -1)
    const window = activeFanRun?.test_start ? String(activeFanRun.test_start).slice(0, 7) : null
    return window ? shiftMonth(window, -1) : null
  }, [cases, fanBands, activeFanRun])

  const fanSeries = useMemo(() => {
    const merged = mergeFanSeries(cases, fanBands)
    if (!fanOrigin) return merged
    // Twelve months of history ending at the origin, then the fan itself.
    return merged.filter((d) => d.period >= shiftMonth(fanOrigin, -11))
  }, [cases, fanBands, fanOrigin])

  const fanPoints = useMemo(() => fanSeries.filter((d) => d.median !== null), [fanSeries])

  const fanGrowth = useMemo(() => {
    const widths = fanPoints
      .map((d) => (d.hi95 !== null && d.lo95 !== null ? d.hi95 - d.lo95 : null))
      .filter((w) => w !== null)
    if (widths.length < 2 || widths[0] <= 0) return null
    return widths[widths.length - 1] / widths[0]
  }, [fanPoints])

  const fanExog = useMemo(() => {
    const raw = activeFanRun?.feature_set_json
    if (!raw) return null
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      const assumptions = parsed?.exog_assumptions
      if (!assumptions || typeof assumptions !== 'object') return null
      return Object.entries(assumptions).map(([k, v]) => `${k}: ${v}`).join(' · ')
    } catch { return null }
  }, [activeFanRun])

  // The whole 17-region panel: the correlation tab needs every region for its
  // between-region view, not just the selected one.
  const { data: panel, loading: panelLoading, error: panelError, refetch: refetchPanel } =
    useFetch(() => panelApi.get(), [])

  const series = useMemo(() => mergeSeries(cases, predictions), [cases, predictions])
  const forecastPoints = series.filter((d) => d.forecast !== null)
  const observedPoints = series.filter((d) => d.observed !== null)
  const hasForecast = forecastPoints.length > 0

  const peak = forecastPoints.reduce((best, d) => (best && best.forecast >= d.forecast ? best : d), null)
  const forecastStart = forecastPoints[0]
  const lastObserved = observedPoints.at(-1)

  const meanWidth = forecastPoints.length
    ? forecastPoints.reduce((sum, d) => sum + ((d.upper ?? 0) - (d.lower ?? 0)), 0) / forecastPoints.length
    : null

  const activeRegion = regions?.find((r) => String(r.id) === String(activeRegionId))
  const regionName = activeRegion?.name ?? 'Region'
  const activeSlug = activeRegion?.slug ?? null

  return (
    <>
      <PageHeader
        title="Forecast"
        description={tab === 'forecast'
          ? "Monthly predicted cases from the Bayesian-neural hybrid model, shown with the credible interval the model reports alongside each point."
          : tab === 'fan'
            ? "One origin, many sampled futures feeding their own lags forward. Bands nest 50 inside 80 inside 95 and widen with horizon — that widening is uncertainty propagating, not the model hedging."
            : tab === 'lag'
              ? "Climate leads dengue by weeks to months. Shift the series, verify the alignment, and read the measured lag — observed surveillance only, no model output on this tab."
              : "How the recorded case burden relates to each region's climate and socioeconomic profile. Observed surveillance only — no model output on this tab."}
      />

      {/* One selector, shared by both tabs — the brief's requirement, and it
          only works because the whole app now runs on the same 17 regions. */}
      <div className="filter-bar">
        <span className="filter-bar-label">Region</span>
        <Select
          label="Region"
          hideLabel
          value={activeRegionId ?? ''}
          disabled={regionsLoading || !regions?.length}
          onChange={(v) => setRegionId(v)}
          options={(regions ?? []).map((r) => ({ value: r.id, label: `${r.name} · ${r.slug}` }))}
        />
        <span className="filter-bar-spacer" />
        {tab === 'forecast' && (
          <span className="tag">
            <Icon name="clock" size={12} />
            {hasForecast ? `${forecastPoints.length}-month horizon` : 'No horizon'}
          </span>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Forecast views">
        <button type="button" role="tab" aria-selected={tab === 'forecast'}
          className={`tab ${tab === 'forecast' ? 'is-on' : ''}`} onClick={() => setTab('forecast')}>
          <Icon name="forecast" size={15} />
          Predicted cases
        </button>
        <button type="button" role="tab" aria-selected={tab === 'correlation'}
          className={`tab ${tab === 'correlation' ? 'is-on' : ''}`} onClick={() => setTab('correlation')}>
          <Icon name="chart" size={15} />
          Correlations
        </button>
        <button type="button" role="tab" aria-selected={tab === 'lag'}
          className={`tab ${tab === 'lag' ? 'is-on' : ''}`} onClick={() => setTab('lag')}>
          <Icon name="clock" size={15} />
          Lag explorer
        </button>
        <button type="button" role="tab" aria-selected={tab === 'fan'}
          className={`tab ${tab === 'fan' ? 'is-on' : ''}`} onClick={() => setTab('fan')}>
          <Icon name="models" size={15} />
          Multi-step fan
        </button>
      </div>

      {tab === 'fan' ? (
        <FanTab
          t={t}
          regionName={regionName}
          recursiveRuns={recursiveRuns}
          activeFanRun={activeFanRun}
          activeFanRunId={activeFanRunId}
          onRunChange={setFanRunId}
          fanSeries={fanSeries}
          fanPoints={fanPoints}
          fanGrowth={fanGrowth}
          fanOrigin={fanOrigin}
          fanExog={fanExog}
          fanView={fanView}
          onViewChange={setFanView}
          loading={fanLoading}
          error={fanError}
          onRetry={refetchFan}
        />
      ) : tab === 'lag' ? (
        <LagExplorer
          panel={panel}
          loading={panelLoading}
          error={panelError}
          refetch={refetchPanel}
          activeSlug={activeSlug}
          regionName={regionName}
        />
      ) : tab === 'correlation' ? (
        <CorrelationPanel
          panel={panel}
          loading={panelLoading}
          error={panelError}
          refetch={refetchPanel}
          activeSlug={activeSlug}
          regionName={regionName}
        />
      ) : (
      <>
      <div className="grid grid-4">
        <StatCard
          label="Peak predicted cases"
          value={peak ? formatInt(peak.forecast) : '—'}
          sublabel={peak ? `Week of ${formatDate(peak.date)}` : 'Awaiting a model run'}
          loading={predLoading && !hasForecast}
        />
        <StatCard
          label="Forecast starts"
          value={forecastStart ? formatDate(forecastStart.date, 'short') : '—'}
          sublabel={forecastStart ? `Through ${formatDate(forecastPoints.at(-1).date)}` : 'No predictions stored'}
          loading={predLoading && !hasForecast}
        />
        <StatCard
          label="Mean interval width"
          value={meanWidth !== null ? formatNumber(meanWidth, { decimals: 0 }) : '—'}
          unit="cases"
          sublabel="Average upper minus lower bound"
          loading={predLoading && !hasForecast}
        />
        <StatCard
          label="Last observed"
          value={lastObserved ? formatInt(lastObserved.observed) : '—'}
          sublabel={lastObserved ? `Week of ${formatDate(lastObserved.date)}` : 'No case data for this region'}
          trend={observedPoints.map((d) => d.observed)}
        />
      </div>

      <Card className="section-gap">
        <CardHead
          title="How this forecast is computed"
          description="What the model does with last month's cases and weather to produce each point — and what it does not (yet) do."
          actions={<Link className="btn btn-secondary btn-sm" to="/methodology">Full derivation</Link>}
        />
        <CardBody>
          {realHybridRuns.length > 0 ? (
            <div className="notice notice-info" role="status" style={{ marginBottom: 'var(--sp-4)' }}>
              <Icon name="info" size={15} />
              <span>
                <strong>{realHybridRuns.length} fitted hybrid run{realHybridRuns.length === 1 ? '' : 's'} in the database.</strong>{' '}
                The chart below shows the latest run&apos;s forecast — confirm which run on the{' '}
                <Link to="/models">Model comparison</Link> page. DEMO-flagged runs remain for
                reference; their bands are illustrative, not posterior samples.
              </span>
            </div>
          ) : (
            <div className="notice notice-warning" role="status" style={{ marginBottom: 'var(--sp-4)' }}>
              <Icon name="warning" size={15} />
              <span>
                <strong>Specified design, not current output.</strong>{' '}
                Described here is the Bayesian-neural hybrid (Methodology §5). The forecasts on this
                page today come from harness-validation runs and seeded fixtures — see their{' '}
                <code className="mono">model_runs.notes</code>. Their bands are residual-bootstrap
                intervals, not posterior samples. This box retires itself when a fitted hybrid run lands.
              </span>
            </div>
          )}
          <p>
            For a region <i className="eq-var">r</i> and target month <i className="eq-var">t</i>,
            the model predicts a <em>rate</em>, then scales it by people. It looks only backward:
            last month&apos;s and last year&apos;s cases, temperature three months back (mosquito
            development takes weeks), rainfall and humidity one month back (breeding water, adult
            survival), extreme-heat days — plus population density, which barely moves. A 32-unit
            GRU reads that history as a sequence and learns how the signals combine; there are no
            hand-written interaction terms, the nonlinearity <em>is</em> the interaction model. A
            hierarchical layer gives each province its own baseline, informed by HDI.
          </p>
          <p>
            Because counts are noisy, the model never outputs a single number. It simulates
            thousands of plausible futures and reports their middle — that median is the
            Predicted Cases point — and their spread: the 50%, 80% and 95% bands are quantiles
            of those simulations. They are <em>credible</em> intervals (Bayesian), not confidence
            intervals, and a wider band is honest uncertainty, not a worse model — read width
            alongside coverage on the Calibration page.
          </p>
          <details>
            <summary>Show the mathematics</summary>
            <div className="eq-block">
              <div className="eq-scroll">
                <div className="eq">
                  x<sub><i className="eq-var">r</i>,<i className="eq-var">t</i></sub> = [ log1p(C<sub>
                  <i className="eq-var">t</i>−1</sub>), log1p(C<sub><i className="eq-var">t</i>−12</sub>),
                  T<sub><i className="eq-var">t</i>−3</sub>, H<sub><i className="eq-var">t</i>−1</sub>,
                  R<sub><i className="eq-var">t</i>−1</sub>, HD<sub><i className="eq-var">t</i>−3</sub>,
                  ONI<sub><i className="eq-var">t</i>−<i className="eq-var">L</i></sub>, logPopDens
                  <sub><i className="eq-var">r</i></sub> ] <span className="eq-note">all lags look
                  strictly backward — no leakage by construction</span>
                </div>
                <div className="eq">
                  h = GRU32(x<sub><i className="eq-var">r</i>,<i className="eq-var">t</i>−
                  <i className="eq-var">L</i>:<i className="eq-var">t</i></sub>),&nbsp;&nbsp; g = w
                  <sub>out</sub><sup>T</sup> h + b<sub>out</sub>
                </div>
                <div className="eq">
                  log λ<sub><i className="eq-var">r</i>,<i className="eq-var">t</i></sub> ={' '}
                  <u>log P<sub><i className="eq-var">r</i>,<i className="eq-var">t</i></sub></u> +
                  α<sub>p(<i className="eq-var">r</i>)</sub> + g &nbsp;&nbsp;
                  <span className="eq-note">offset (fixed coefficient 1) + province intercept + GRU</span>
                </div>
                <div className="eq">
                  C̃<sup>(s)</sup> ~ NegBinomial(λ<sup>(s)</sup>, φ<sup>(s)</sup>),&nbsp;&nbsp;
                  Predicted = median<sub>s</sub>(C̃<sup>(s)</sup>),&nbsp;&nbsp; 95% band = [Q
                  <sub>2.5</sub>, Q<sub>97.5</sub>]<sub>s</sub>,&nbsp;&nbsp; 80% = [Q
                  <sub>10</sub>, Q<sub>90</sub>],&nbsp;&nbsp; 50% = [Q<sub>25</sub>, Q
                  <sub>75</sub>]
                </div>
                <div className="eq">
                  λ<sub><i className="eq-var">r</i>,<i className="eq-var">t</i></sub> = P
                  <sub><i className="eq-var">r</i>,<i className="eq-var">t</i></sub> · exp(η
                  <sub><i className="eq-var">r</i>,<i className="eq-var">t</i></sub>) &nbsp;&nbsp;
                  <span className="eq-note">rate → counts is multiplication: populous ≠ prone</span>
                </div>
              </div>
              <p className="eq-cap">
                Open gaps, stated not papered over:{' '}
                <span className="prov prov-gap">inference scheme unnamed (NUTS vs MAP vs variational)</span>{' '}
                <span className="prov prov-gap">GRU window length L unspecified</span>{' '}
                <span className="prov prov-gap">density entry point (GRU input vs linear term) unspecified</span>{' '}
                horizons beyond 1 month are planning scenarios, not model outputs.
              </p>
            </div>
          </details>
        </CardBody>
      </Card>

      <Card className="section-gap">
        <CardHead
          title={`Predicted cases — ${regionName}`}
          description="Observed surveillance counts and the hybrid model's forecast, on a single case-count axis."
          actions={<ViewToggle view={view} onChange={setView} label="Forecast view" />}
        />

        <AsyncSection
          loading={predLoading}
          error={predError}
          hasData={series.length > 0}
          isEmpty={series.length === 0}
          onRetry={refetchPred}
          errorTitle="Could not load the forecast"
          skeleton={<SkeletonBlock height={300} />}
          empty={(
            <EmptyState
              icon="forecast"
              title="No forecast stored for this region"
              body="Predictions are written into MySQL by the Python model service. Once it has run for this region, its output and credible interval appear here."
            />
          )}
        >
          {view === 'chart' ? (
            <CardBody>
              <div className="legend">
                <LegendItem shape="line" color={t.series2} label="Observed cases" />
                <LegendItem shape="line" color={t.series1} label="Forecast (hybrid)" />
                <LegendItem shape="band" color={t.series1} label="Credible interval" />
              </div>

              <div className="chart-frame">
                <ResponsiveContainer width="100%" height={320}>
                  {/* The right margin has to clear the peak label: the peak is
                      usually the last point, and a clipped direct label is
                      worse than none. */}
                  <ComposedChart data={series} margin={{ top: 22, right: 52, bottom: 4, left: -6 }}>
                    <CartesianGrid stroke={t.grid} strokeWidth={1} vertical={false} />

                    <XAxis
                      dataKey="key"
                      tickFormatter={(v) => formatDate(v, 'axis')}
                      tick={{ fill: t.ink3, fontSize: 11 }}
                      axisLine={{ stroke: t.axis }}
                      tickLine={false}
                      tickMargin={10}
                      minTickGap={16}
                    />
                    <YAxis
                      tick={{ fill: t.ink3, fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickMargin={8}
                      width={52}
                      tickFormatter={(v) => v.toLocaleString()}
                    />

                    <Tooltip
                      cursor={{ stroke: t.axis, strokeWidth: 1 }}
                      content={(
                        <ChartTooltip
                          labelFormatter={(v) => `Week of ${formatDate(v, 'long')}`}
                          valueFormatter={(value) => (Array.isArray(value)
                            ? `${formatInt(value[0])} – ${formatInt(value[1])}`
                            : formatInt(value))}
                        />
                      )}
                    />

                    {forecastStart && (
                      <ReferenceLine
                        x={forecastStart.key}
                        stroke={t.axis}
                        strokeWidth={1}
                        label={{
                          value: 'forecast →',
                          position: 'insideTopLeft',
                          fill: t.ink3,
                          fontSize: 10,
                          offset: 8,
                        }}
                      />
                    )}

                    {/* ~14% wash, never a saturated block */}
                    <Area
                      dataKey="band"
                      name="Credible interval"
                      stroke="none"
                      fill={t.series1}
                      fillOpacity={0.14}
                      connectNulls={false}
                      isAnimationActive={false}
                      activeDot={false}
                    />

                    <Line
                      dataKey="observed"
                      name="Observed cases"
                      type="monotone"
                      stroke={t.series2}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={{ r: 3.5, fill: t.series2, stroke: t.surface, strokeWidth: 2 }}
                      activeDot={{ r: 5, fill: t.series2, stroke: t.surface, strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />

                    <Line
                      dataKey="forecast"
                      name="Forecast (hybrid)"
                      type="monotone"
                      stroke={t.series1}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={{ r: 3.5, fill: t.series1, stroke: t.surface, strokeWidth: 2 }}
                      activeDot={{ r: 5, fill: t.series1, stroke: t.surface, strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />

                    {/* The extreme is the only directly labelled point -- a
                        number on every point goes unread. */}
                    {peak && (
                      <ReferenceDot
                        x={peak.key}
                        y={peak.forecast}
                        r={0}
                        isFront
                        label={{
                          value: `peak ${formatInt(peak.forecast)}`,
                          position: 'top',
                          fill: t.ink2,
                          fontSize: 11,
                          fontWeight: 600,
                          offset: 10,
                        }}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          ) : (
            <DataTable
              caption={`Weekly observed and predicted cases for ${regionName}`}
              rows={series}
              getRowKey={(row) => row.key}
              columns={[
                { key: 'date', header: 'Week of', render: (r) => formatDate(r.date) },
                { key: 'observed', header: 'Observed', align: 'right', render: (r) => (r.observed === null ? <span className="cell-quiet">—</span> : formatInt(r.observed)) },
                { key: 'forecast', header: 'Forecast', align: 'right', className: 'cell-strong', render: (r) => (r.forecast === null ? <span className="cell-quiet">—</span> : formatInt(r.forecast)) },
                { key: 'lower', header: 'CI lower', align: 'right', render: (r) => (r.lower === null ? <span className="cell-quiet">—</span> : formatInt(r.lower)) },
                { key: 'upper', header: 'CI upper', align: 'right', render: (r) => (r.upper === null ? <span className="cell-quiet">—</span> : formatInt(r.upper)) },
                {
                  key: 'width',
                  header: 'Width',
                  align: 'right',
                  render: (r) => (r.lower === null || r.upper === null
                    ? <span className="cell-quiet">—</span>
                    : formatInt(r.upper - r.lower)),
                },
              ]}
            />
          )}
        </AsyncSection>
      </Card>
      </>
      )}
    </>
  )
}
