import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useFetch } from '../hooks/useFetch.js'
import { modelsApi } from '../services/api.js'
import { Card, CardBody, CardFoot, CardHead } from '../components/Card.jsx'
import EvaluationBanner from '../components/EvaluationBanner.jsx'
import { LegendItem, PageHeader, ViewToggle } from '../components/Controls.jsx'
import { AsyncSection, EmptyState, SkeletonRows } from '../components/States.jsx'
import DataTable from '../components/DataTable.jsx'
import Icon from '../components/Icon.jsx'
import { seriesSlots, useChartTheme } from '../lib/useChartTheme.js'
import { formatDateTime, formatNumber, toNumber } from '../lib/format.js'

/*
 * Five metrics on five different scales (cases, %, CRPS). Putting any two of
 * them on one plot would need a second y-axis, which invents a relationship
 * that isn't in the data -- so this is small multiples instead: one chart per
 * metric, each with its own scale, the three models keeping their colour
 * across all five.
 */
/*
 * The objective asks two separate questions, so the page answers them
 * separately rather than in one undifferentiated table:
 *
 *   1. point accuracy   - is the forecast close?      RMSE / MAE / MAPE
 *   2. probabilistic    - is the UNCERTAINTY honest?  CRPS / coverage / sharpness
 *
 * A model can win outright on (1) and be useless on (2), which is exactly the
 * accuracy-vs-calibration gap the study exists to address. Merging them into
 * one ranking hides that.
 *
 * Within each group these are still small multiples: five metrics on five
 * different scales cannot share a y-axis without inventing a relationship.
 */
const POINT_METRICS = [
  { key: 'rmse', name: 'RMSE', goal: 'lower is better', decimals: 2, unit: '', blurb: 'Root mean squared error, in cases. Punishes large misses hardest.' },
  { key: 'mae', name: 'MAE', goal: 'lower is better', decimals: 2, unit: '', blurb: 'Mean absolute error, in cases. Treats every miss proportionally.' },
  { key: 'mape', name: 'MAPE', goal: 'lower is better', decimals: 2, unit: '%', blurb: 'Mean absolute percentage error — scale-free, so it compares across regions of very different size.' },
]

const PROB_METRICS = [
  { key: 'crps', name: 'CRPS', goal: 'lower is better', decimals: 2, unit: '', blurb: 'Continuous ranked probability score — scores the whole predictive distribution, not just the point estimate. A point forecast cannot compete here.' },
  { key: 'coverage', name: 'Interval coverage', goal: 'higher is better', decimals: 1, unit: '%', blurb: 'Share of observations that fell inside the stated interval. Should land ON the nominal level, not above it.' },
  { key: 'mean_interval_width', name: 'Interval width', goal: 'lower is better', decimals: 1, unit: '', blurb: 'Sharpness. Read this together with coverage — an interval wide enough to contain everything covers perfectly and decides nothing.' },
]

const METRICS = [...POINT_METRICS, ...PROB_METRICS]


function bestIdFor(metric, runs) {
  const scored = runs
    .map((r) => ({ id: r.id, value: toNumber(r[metric.key]) }))
    .filter((r) => r.value !== null)
  if (!scored.length) return null
  const higherWins = metric.goal.startsWith('higher')
  return scored.reduce((best, r) => {
    if (!best) return r
    return (higherWins ? r.value > best.value : r.value < best.value) ? r : best
  }, null).id
}

function MetricChart({ metric, runs, colorFor }) {
  const values = runs.map((r) => toNumber(r[metric.key])).filter((v) => v !== null)
  const max = values.length ? Math.max(...values) : 0
  const bestId = bestIdFor(metric, runs)

  return (
    <Card>
      <CardBody>
        <div className="metric-card-head">
          <span className="metric-name">{metric.name}</span>
          <span className="metric-goal">{metric.goal}</span>
        </div>

        <div className="bars">
          {runs.map((run) => {
            const value = toNumber(run[metric.key])
            const pct = value !== null && max > 0 ? Math.max((value / max) * 100, 2) : 0
            return (
              <div className="bar-row" key={run.id}>
                <div className="bar-row-head">
                  <span className="key-swatch" style={{ background: colorFor(run.id) }} />
                  <span className="bar-row-name">{run.model_type}</span>
                  {/* Direct label at the data end -- value, not a number on every tick. */}
                  <span className="bar-row-value">
                    {value === null ? '—' : formatNumber(value, { decimals: metric.decimals, unit: metric.unit })}
                    {run.id === bestId && (
                      <>
                        {' '}
                        <Icon name="check" size={11} strokeWidth={2.6} style={{ verticalAlign: -1, color: 'var(--accent-ink)' }} />
                        <span className="sr-only"> best on this metric</span>
                      </>
                    )}
                  </span>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${pct}%`, background: colorFor(run.id) }}
                    role="img"
                    aria-label={`${run.model_type}: ${value === null ? 'no value' : formatNumber(value, { decimals: metric.decimals, unit: metric.unit })}`}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </CardBody>
      <CardFoot>{metric.blurb}</CardFoot>
    </Card>
  )
}

export default function ModelComparison() {
  const t = useChartTheme()
  const [view, setView] = useState('chart')
  const [horizon, setHorizon] = useState('1')
  const { data: runs, loading, error, refetch } = useFetch(() => modelsApi.compare(), [])

  const list = runs ?? []

  /*
   * Horizons are different regimes, not newer versions: a 6-month recursive
   * RMSE is scored over compounding paths while a 1-step RMSE is scored over
   * single months, so ranking them together is a category error. The filter
   * defaults to one-step (the study's headline regime); colours stay assigned
   * from the FULL list so filtering can never repaint a model.
   */
  const scoped = useMemo(() => {
    if (horizon === 'all') return list
    return list.filter((r) => (horizon === 'multi'
      ? Number(r.horizon_months ?? 1) > 1
      : Number(r.horizon_months ?? 1) === 1))
  }, [list, horizon])

  /*
   * Colour follows the entity, never its rank. The hybrid is pinned to slot 1
   * because it is the subject of the study, not because it happens to be
   * winning; the baselines then take the remaining slots in stable id order.
   * Nothing here depends on the current sort, so filtering or re-sorting can
   * never repaint a model the reader has already learned.
   */
  const modelOrder = useMemo(() => {
    const byId = [...list].sort((a, b) => a.id - b.id)
    const isHybrid = (r) => /hybrid/i.test(r.model_type)
    return [...byId.filter(isHybrid), ...byId.filter((r) => !isHybrid(r))].map((r) => r.id)
  }, [list])

  const colorFor = useMemo(() => {
    const slots = seriesSlots(t)
    return (id) => slots[modelOrder.indexOf(id) % slots.length]
  }, [modelOrder, t])

  const best = scoped[0]
  const runnerUp = scoped[1]
  const rmseGain = best && runnerUp
    ? ((toNumber(runnerUp.rmse) - toNumber(best.rmse)) / toNumber(runnerUp.rmse)) * 100
    : null

  const bestPerMetric = useMemo(
    () => Object.fromEntries(METRICS.map((m) => [m.key, bestIdFor(m, scoped)])),
    [scoped],
  )

  const horizonLabel = horizon === 'all' ? 'all horizons' : horizon === 'multi' ? 'multi-step horizons' : 'one-step horizon'

  return (
    <>
      <PageHeader
        title="Model comparison"
        description={`Comparative evaluation of the Bayesian-neural hybrid against the SARIMA and LSTM baselines, on the held-out evaluation window — ${horizonLabel}.`}
        actions={(
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-3)', alignItems: 'center' }}>
            <div className="segmented" role="group" aria-label="Forecast horizon">
              <button type="button" aria-pressed={horizon === '1'} onClick={() => setHorizon('1')}>One-step</button>
              <button type="button" aria-pressed={horizon === 'multi'} onClick={() => setHorizon('multi')}>Multi-step</button>
              <button type="button" aria-pressed={horizon === 'all'} onClick={() => setHorizon('all')}>All</button>
            </div>
            <ViewToggle view={view} onChange={setView} label="Comparison view" />
          </div>
        )}
      />

      <EvaluationBanner run={best} />

      <AsyncSection
        loading={loading}
        error={error}
        hasData={list.length > 0}
        isEmpty={Boolean(runs) && scoped.length === 0}
        onRetry={refetch}
        errorTitle="Could not load evaluation results"
        skeleton={<Card><SkeletonRows rows={5} /></Card>}
        empty={(
          <Card>
            <EmptyState
              icon="models"
              title={list.length === 0 ? 'No evaluation runs recorded' : 'No runs at this horizon'}
              body={list.length === 0
                ? 'Each model run needs a matching row in evaluation_metrics. Run npm run seed in the backend for the sample comparison, or let the Python model service write real results.'
                : 'No evaluated runs exist at the selected horizon yet. Train one (for example: python validate_harness.py --horizon 6 --origin 2019-06), or switch the horizon filter.'}
            />
          </Card>
        )}
      >
        {best && (
          <Card>
            <CardBody>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--sp-3)' }}>
                <span className="badge badge-accent">
                  <span className="badge-dot" />
                  Leading model
                </span>
                <span style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>{best.model_type}</span>
                <span className="tag">{best.version}</span>
                <span className="tag">{Number(best.horizon_months ?? 1) > 1 ? `H=${best.horizon_months}` : 'H=1'}</span>
                <span className="muted" style={{ fontSize: 'var(--text-xs)', marginLeft: 'auto' }}>
                  Trained {formatDateTime(best.trained_at)}
                </span>
              </div>
              <p className="subtle" style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--text-sm)', maxWidth: '80ch' }}>
                {rmseGain === null
                  ? `${best.model_type} is the only evaluated run, so there is nothing to compare it against yet.`
                  : `${best.model_type} cuts RMSE by ${rmseGain.toFixed(1)}% against ${runnerUp.model_type}, and reports ${formatNumber(best.coverage, { decimals: 1 })}% interval coverage — the property the baselines do not provide.`}
              </p>
            </CardBody>
          </Card>
        )}

        {view === 'chart' ? (
          <>
            <div className="legend section-gap" style={{ paddingBottom: 0 }}>
              {scoped.map((run) => (
                <LegendItem key={run.id} shape="swatch" color={colorFor(run.id)} label={run.model_type} />
              ))}
            </div>

            <div className="section-gap">
              <h2 className="group-title">1 &middot; Point accuracy</h2>
              <p className="group-sub">
                How close the forecast lands. This is the comparison the first
                objective asks for, and all three models can be scored on it.
              </p>
            </div>
            <div className="grid grid-3 section-gap">
              {POINT_METRICS.map((metric) => (
                <MetricChart key={metric.key} metric={metric} runs={scoped} colorFor={colorFor} />
              ))}
            </div>

            <div className="section-gap">
              <h2 className="group-title">2 &middot; Uncertainty and calibration</h2>
              <p className="group-sub">
                Whether the stated uncertainty is honest. A model can win on
                point accuracy and still be badly calibrated here — that gap is
                what the hybrid exists to close. Coverage and width must be read
                together.{' '}
                <Link to="/calibration">See the full calibration evidence →</Link>
              </p>
            </div>
            <div className="grid grid-3 section-gap">
              {PROB_METRICS.map((metric) => (
                <MetricChart key={metric.key} metric={metric} runs={scoped} colorFor={colorFor} />
              ))}
            </div>
          </>
        ) : (
          <Card className="section-gap">
            <CardHead
              title="Evaluation metrics"
              description="The same numbers as the charts. “Best” marks the winning model on each metric."
            />
            <DataTable
              caption="Model evaluation metrics"
              rows={scoped}
              getRowKey={(row) => row.id}
              columns={[
                {
                  key: 'model_type',
                  header: 'Model',
                  className: 'cell-strong',
                  render: (r) => (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span className="key-swatch" style={{ background: colorFor(r.id) }} />
                      {r.model_type}
                    </span>
                  ),
                },
                { key: 'version', header: 'Version', render: (r) => <span className="mono cell-quiet">{r.version ?? '—'}</span> },
                ...METRICS.map((m) => ({
                  key: m.key,
                  header: `${m.name}${m.unit ? ` (${m.unit})` : ''}`,
                  align: 'right',
                  render: (r) => {
                    const text = formatNumber(r[m.key], { decimals: m.decimals })
                    return bestPerMetric[m.key] === r.id
                      ? <span className="cell-best">{text}</span>
                      : text
                  },
                })),
              ]}
            />
            <CardFoot>
              RMSE, MAE, MAPE, CRPS and interval width are lower-is-better; interval coverage
              should land <em>on</em> its nominal level rather than as high as possible — see
              the <Link to="/calibration">calibration page</Link>.
            </CardFoot>
          </Card>
        )}
      </AsyncSection>
    </>
  )
}
