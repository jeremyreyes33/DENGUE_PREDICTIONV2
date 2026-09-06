import { useEffect, useMemo, useState } from 'react'
import { useFetch } from '../hooks/useFetch.js'
import { panelApi, surveillanceApi } from '../services/api.js'
import { Card, CardBody, CardFoot, CardHead } from '../components/Card.jsx'
import { PageHeader, Select, ViewToggle } from '../components/Controls.jsx'
import { AsyncSection, EmptyState, SkeletonBlock } from '../components/States.jsx'
import Choropleth, { ChoroplethLegend, makeBins } from '../components/Choropleth.jsx'
import AnomalyBar, { formatAnomaly } from '../components/AnomalyBar.jsx'
import DataTable from '../components/DataTable.jsx'
import StatCard from '../components/StatCard.jsx'
import { formatInt, formatNumber, toNumber } from '../lib/format.js'
import { buildRainfallNormals, rainAnomaly } from '../lib/panelFields.js'

const METRICS = {
  cases: {
    label: 'Confirmed cases',
    short: 'cases',
    legend: 'Confirmed cases',
    format: (v) => (v === null ? '—' : formatInt(v)),
    of: (row) => toNumber(row.confirmed_cases),
  },
  incidence: {
    label: 'Cases per 100,000',
    short: 'per 100k',
    legend: 'Cases per 100,000 (2020 census)',
    format: (v) => (v === null ? '—' : formatNumber(v, { decimals: 1 })),
    of: (row) => {
      const cases = toNumber(row.confirmed_cases)
      const pop = toNumber(row.population)
      return cases === null || !pop ? null : (cases / pop) * 1e5
    },
  },
}

/*
 * Two scopes, two committed boundary files. Both are static assets built once
 * by backend/scripts/build-boundaries.js — no tile server, no API key, no
 * request to anything but this app's own origin.
 */
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

const SCOPES = {
  region: {
    label: 'Philippine regions',
    file: 'ph-regions.geojson',
    grain: '17 administrative regions, monthly',
    note: 'The study panel. 2016-2020, the window the model is trained and scored on.',
  },
  municipality: {
    label: 'CALABARZON municipalities',
    file: 'calabarzon-lgus.geojson',
    grain: '142 cities and municipalities, annual',
    note: 'Finer geography, but annual totals only — it cannot support the forecast model.',
  },
}

function useBoundaries(scope) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  useEffect(() => {
    let alive = true
    setState((prev) => ({ ...prev, loading: true }))
    fetch(`${import.meta.env.BASE_URL}${SCOPES[scope].file}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Boundary file returned HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error, loading: false }))
    return () => { alive = false }
  }, [scope])
  return state
}

export default function RiskMap() {
  const [scope, setScope] = useState('region')
  const [metricKey, setMetricKey] = useState('incidence')
  const [year, setYear] = useState(null)
  const [month, setMonth] = useState('all')
  const [view, setView] = useState('chart')

  // Both sources are fetched; the inactive one costs one request and makes
  // switching scope instant instead of a spinner.
  const { data: annual, loading: annualLoading, error: annualError, refetch } =
    useFetch(() => surveillanceApi.annual(), [])
  const { data: panel, loading: panelLoading, error: panelError } =
    useFetch(() => panelApi.get(), [])
  const { data: geo, error: geoError, loading: geoLoading } = useBoundaries(scope)

  const metric = METRICS[metricKey]
  const isRegion = scope === 'region'

  const loading = isRegion ? panelLoading : annualLoading
  const error = isRegion ? panelError : annualError

  /*
   * Both scopes are normalised to one row shape so everything downstream --
   * bins, stats, table, tooltip -- is written once:
   *
   *   { key, name, sublabel, year, month, confirmed_cases, deaths, population }
   *
   * `key` is what a map feature is matched on: the region slug for the
   * national layer, name::province for the municipal one (name alone is not
   * unique -- there are two Rosarios).
   */
  const records = useMemo(() => {
    if (isRegion) {
      return (panel ?? []).map((r) => ({
        key: r.region_slug,
        name: r.region_name,
        sublabel: r.region_slug,
        year: r.year,
        month: r.month,
        confirmed_cases: toNumber(r.confirmed_cases),
        deaths: toNumber(r.deaths),
        population: toNumber(r.population),
      }))
    }
    return (annual ?? []).map((r) => ({
      key: `${r.region_name}::${String(r.province).toUpperCase()}`,
      name: r.region_name,
      sublabel: r.province,
      year: r.year,
      month: null,
      confirmed_cases: toNumber(r.confirmed_cases),
      deaths: toNumber(r.deaths),
      population: toNumber(r.population),
    }))
  }, [isRegion, panel, annual])

  const years = useMemo(
    () => [...new Set(records.map((r) => r.year))].sort((a, b) => b - a),
    [records],
  )
  const activeYear = years.includes(year) ? year : (years[0] ?? null)
  const activeMonth = isRegion ? month : 'all'

  /*
   * Collapse to one row per place for the selected period. For the regional
   * scope "all" sums the twelve months, which is what makes the two scopes
   * comparable; population is a yearly figure so it is taken, not summed.
   */
  const periodRows = useMemo(() => {
    const wanted = records.filter((r) => r.year === activeYear
      && (activeMonth === 'all' || r.month === Number(activeMonth)))
    const byPlace = new Map()
    for (const r of wanted) {
      const cur = byPlace.get(r.key)
      if (!cur) byPlace.set(r.key, { ...r })
      else {
        cur.confirmed_cases += r.confirmed_cases ?? 0
        cur.deaths += r.deaths ?? 0
      }
    }
    return [...byPlace.values()]
  }, [records, activeYear, activeMonth])

  /*
   * Bins are computed across EVERY period in the scope, not just the one on
   * screen, so the scale holds still while the reader steps through time.
   * Recomputing per period would repaint the map on every change and hide the
   * growth that is the entire point of stepping through it.
   */
  const bins = useMemo(() => {
    const byPeriod = new Map()
    for (const r of records) {
      const k = `${r.key}|${r.year}|${activeMonth === 'all' ? 'y' : r.month}`
      const cur = byPeriod.get(k)
      if (!cur) byPeriod.set(k, { ...r })
      else {
        cur.confirmed_cases += r.confirmed_cases ?? 0
        cur.deaths += r.deaths ?? 0
      }
    }
    return makeBins([...byPeriod.values()].map(metric.of))
  }, [records, metric, activeMonth])

  const byKey = useMemo(
    () => new Map(periodRows.map((r) => [r.key, r])),
    [periodRows],
  )

  /*
   * Rainfall anomaly for the selected period, region scope only. The baseline
   * is the place-month mean across the whole panel window (see panelFields):
   * a July in R4A is compared against R4A Julys, not against the national
   * average and not against January. Municipal scope has no climate columns,
   * so rainByKey simply holds nulls there and the tooltip stays quiet.
   */
  const rainNormals = useMemo(() => buildRainfallNormals(panel ?? []), [panel])

  const rainByKey = useMemo(() => {
    if (!isRegion) return new Map();
    const wanted = (panel ?? []).filter((r) => r.year === activeYear
      && (activeMonth === 'all' || r.month === Number(activeMonth)));
    const groups = new Map();
    for (const r of wanted) {
      if (!groups.has(r.region_slug)) groups.set(r.region_slug, []);
      groups.get(r.region_slug).push(r);
    }
    return new Map([...groups].map(([key, rows]) => [key, rainAnomaly(rows, rainNormals)]));
  }, [isRegion, panel, rainNormals, activeYear, activeMonth])

  const maxAnomalyAbs = useMemo(() => {
    let peak = 0;
    for (const { anomaly } of rainByKey.values()) {
      if (anomaly !== null) peak = Math.max(peak, Math.abs(anomaly));
    }
    return peak;
  }, [rainByKey])

  const lookup = (feature) => byKey.get(
    isRegion
      ? feature.properties.slug
      : `${feature.properties.name}::${String(feature.properties.province).toUpperCase()}`,
  ) ?? null

  const valueOf = (feature) => {
    const row = lookup(feature)
    return row ? metric.of(row) : null
  }

  const total = periodRows.reduce((s, r) => s + (r.confirmed_cases ?? 0), 0)
  const deaths = periodRows.reduce((s, r) => s + (r.deaths ?? 0), 0)
  const worst = periodRows.reduce((best, r) => {
    const v = metric.of(r)
    if (v === null) return best
    return !best || v > metric.of(best) ? r : best
  }, null)
  const noData = geo ? geo.features.some((f) => valueOf(f) === null) : false

  const tableRows = useMemo(
    () => [...periodRows].sort((a, b) => (metric.of(b) ?? -1) - (metric.of(a) ?? -1)),
    [periodRows, metric],
  )

  const ready = Boolean(geo && periodRows.length)

  return (
    <>
      <PageHeader
        title="Risk map"
        description={isRegion
          ? 'Confirmed dengue cases across the 17 administrative regions — the study panel, monthly, 2016-2020.'
          : 'Confirmed dengue cases by city and municipality across CALABARZON, from the DOH annual surveillance tables.'}
      />

      <div className="filter-bar">
        <span className="filter-bar-label">Scope</span>
        <Select
          label="Scope"
          hideLabel
          value={scope}
          onChange={(v) => { setScope(v); setYear(null); setMonth('all') }}
          options={Object.entries(SCOPES).map(([k, v]) => ({ value: k, label: v.label }))}
        />
        <span className="filter-bar-label" style={{ marginLeft: 'var(--sp-2)' }}>Year</span>
        <Select
          label="Year"
          hideLabel
          value={activeYear ?? ''}
          onChange={(v) => setYear(Number(v))}
          options={years.map((y) => ({ value: y, label: String(y) }))}
          disabled={!years.length}
        />
        {isRegion && (
          <>
            <span className="filter-bar-label" style={{ marginLeft: 'var(--sp-2)' }}>Month</span>
            <Select
              label="Month"
              hideLabel
              value={month}
              onChange={setMonth}
              options={[
                { value: 'all', label: 'All months (annual)' },
                ...MONTH_NAMES.map((m, i) => ({ value: String(i + 1), label: m })),
              ]}
            />
          </>
        )}
        <span className="filter-bar-label" style={{ marginLeft: 'var(--sp-2)' }}>Metric</span>
        <Select
          label="Metric"
          hideLabel
          value={metricKey}
          onChange={setMetricKey}
          options={Object.entries(METRICS).map(([k, m]) => ({ value: k, label: m.label }))}
        />
        <span className="filter-bar-spacer" />
        <ViewToggle view={view} onChange={setView} label="Map view" />
      </div>

      <div className="grid grid-4">
        <StatCard
          label={`Confirmed cases, ${activeMonth === 'all' ? activeYear ?? '—' : `${MONTH_NAMES[Number(activeMonth) - 1]} ${activeYear}`}`}
          value={formatInt(total)}
          sublabel={isRegion ? 'Across all 17 administrative regions' : 'Across all 142 cities and municipalities'}
          loading={loading && !records.length}
        />
        <StatCard
          label="Reported deaths"
          value={formatInt(deaths)}
          sublabel={total ? `${((deaths / total) * 100).toFixed(2)}% case fatality` : '—'}
          loading={loading && !records.length}
        />
        <StatCard
          label={`Highest ${metric.short}`}
          value={worst ? metric.format(metric.of(worst)) : '—'}
          sublabel={worst ? `${worst.name}${worst.sublabel && !isRegion ? `, ${worst.sublabel}` : ''}` : '—'}
          loading={loading && !records.length}
        />
        <StatCard
          label={isRegion ? 'Regions mapped' : 'Municipalities mapped'}
          value={geo ? formatInt(geo.features.length) : '—'}
          sublabel={isRegion ? 'geoBoundaries ADM1, all 17 matched' : 'Boundaries matched to the PSA gazetteer'}
          loading={geoLoading}
        />
      </div>

      <div className={view === 'chart' ? 'grid grid-map section-gap' : 'section-gap'}>
      <Card>
        <CardHead
          title={`${metric.label} — ${activeMonth === 'all' ? activeYear ?? '' : `${MONTH_NAMES[Number(activeMonth) - 1]} ${activeYear}`}`}
          // The ramp anchors to the surface, so "darker = higher" is only true
          // in light mode. This wording holds in both.
          description={`${SCOPES[scope].grain}. Low values sit closest to the background, high values stand furthest from it. Bins are fixed across every period, so stepping through time shows real change.`}
        />

        <AsyncSection
          loading={loading || geoLoading}
          error={error ?? geoError}
          hasData={ready}
          isEmpty={!loading && periodRows.length === 0}
          onRetry={refetch}
          errorTitle="Could not load the map"
          skeleton={<SkeletonBlock height={420} />}
          empty={(
            <EmptyState
              icon="data"
              title="No surveillance data loaded"
              body={isRegion
                ? 'Run npm run etl:revised in the backend to import the study panel.'
                : 'Run npm run etl in the backend to import the CALABARZON research dataset.'}
            />
          )}
        >
          {view === 'chart' ? (
            <CardBody>
              <ChoroplethLegend
                bins={bins}
                formatValue={metric.format}
                label={metric.legend}
                hasNoData={noData}
              />
              {ready && (
                <Choropleth
                  features={geo.features}
                  bbox={geo.bbox}
                  bins={bins}
                  valueOf={valueOf}
                  formatValue={metric.format}
                  height={isRegion ? 700 : 520}
                  ariaLabel={`Choropleth of ${metric.label} by municipality in CALABARZON, ${activeYear}. Values are listed in the table view.`}
                  renderTooltip={(feature) => {
                    const row = lookup(feature)
                    // rainByKey is an empty map outside the regional scope, so
                    // municipal tooltips fall through to null with no branch.
                    const rain = rainByKey.get(feature.properties.slug) ?? null
                    return (
                      <>
                        <p className="map-tip-name">{feature.properties.name}</p>
                        <p className="map-tip-sub">{feature.properties.province ?? feature.properties.slug}</p>
                        <div className="map-tip-row">
                          <span>Cases</span>
                          <span className="map-tip-value">{row ? formatInt(row.confirmed_cases) : 'No data'}</span>
                        </div>
                        <div className="map-tip-row">
                          <span>Per 100k</span>
                          <span className="map-tip-value">
                            {row ? METRICS.incidence.format(METRICS.incidence.of(row)) : '—'}
                          </span>
                        </div>
                        <div className="map-tip-row">
                          <span>Deaths</span>
                          <span className="map-tip-value">{row ? formatInt(row.deaths) : '—'}</span>
                        </div>
                        {isRegion && rain?.anomaly !== null && rain?.anomaly !== undefined && (
                          <>
                            <div className="map-tip-row">
                              <span>{`Rain vs usual${activeMonth === 'all' ? ' (year)' : ''}`}</span>
                              <span className="map-tip-value">{formatAnomaly(rain.anomaly)}</span>
                            </div>
                            <AnomalyBar value={rain.anomaly} maxAbs={maxAnomalyAbs} />
                          </>
                        )}
                      </>
                    )
                  }}
                />
              )}
            </CardBody>
          ) : (
            <DataTable
              caption={`${metric.label} by ${isRegion ? 'region' : 'municipality'}, ${activeYear}`}
              rows={tableRows}
              getRowKey={(r) => `${r.key}-${r.year}-${r.month ?? 'y'}`}
              columns={[
                { key: 'name', header: isRegion ? 'Region' : 'Municipality', className: 'cell-strong' },
                { key: 'sublabel', header: isRegion ? 'Code' : 'Province', render: (r) => <span className="cell-quiet">{r.sublabel}</span> },
                { key: 'confirmed_cases', header: 'Cases', align: 'right', render: (r) => formatInt(r.confirmed_cases) },
                { key: 'deaths', header: 'Deaths', align: 'right', render: (r) => (toNumber(r.deaths) ? formatInt(r.deaths) : <span className="cell-quiet">0</span>) },
                { key: 'population', header: 'Population 2020', align: 'right', render: (r) => formatInt(r.population) },
                {
                  key: 'incidence',
                  header: 'Per 100k',
                  align: 'right',
                  className: 'cell-strong',
                  render: (r) => METRICS.incidence.format(METRICS.incidence.of(r)),
                },
                // The tooltip's anomaly bar, as numbers: same values, same
                // missing-data rule. Municipal scope has no climate columns,
                // so the column is omitted there rather than filled with dashes.
                ...(isRegion ? [{
                  key: 'rain_anomaly',
                  header: 'Rain ±',
                  align: 'right',
                  render: (r) => {
                    const a = rainByKey.get(r.key)?.anomaly ?? null;
                    return a === null ? <span className="cell-quiet">—</span> : formatAnomaly(a);
                  },
                }] : []),
              ]}
            />
          )}
        </AsyncSection>

        <CardFoot>
          {isRegion ? (
            <>
              Cases: DOH monthly regional surveillance, 2016–2020 (1,020 region-months).
              Population: PSA 2015/2020 census, interpolated between them. Rainfall anomaly
              compares the selected period against that place-month's 2016–2020 mean — positive
              is wetter than usual, the variable to watch rather than raw millimetres. Boundaries:{' '}
              <a href="https://www.geoboundaries.org/" target="_blank" rel="noreferrer">geoBoundaries</a>{' '}
              gbOpen PHL ADM1 (2020), CC-BY 4.0. This is the panel the model is trained and
              scored on. 2020 is shown but excluded from headline evaluation — the COVID
              lockdown collapsed surveillance reporting, not transmission.
            </>
          ) : (
            <>
              Cases: DOH Center for Health Development – CALABARZON annual surveillance tables,
              2020–2024. Population: PSA 2020 Census. Boundaries:{' '}
              <a href="https://www.geoboundaries.org/" target="_blank" rel="noreferrer">geoBoundaries</a>{' '}
              gbOpen PHL ADM3 (2020), CC-BY 4.0. These are <strong>annual</strong> totals at a
              finer geography than the study panel — useful context, but they cannot support the
              forecast model.
            </>
          )}{' '}
          Both boundary files are bundled as static assets, so this map makes no external requests.
        </CardFoot>
      </Card>

      {view === 'chart' && (
        <Card>
          <CardHead
            title={`Highest ${metric.short}`}
            description={`Top ${Math.min(12, tableRows.length)} of ${tableRows.length} ${isRegion ? 'regions' : 'municipalities'}.`}
          />
          <AsyncSection
            loading={loading}
            hasData={tableRows.length > 0}
            isEmpty={tableRows.length === 0}
            skeleton={<SkeletonBlock height={360} />}
            empty={<EmptyState icon="inbox" title="No data for this year" />}
          >
            <div className="rank-list">
              {tableRows.slice(0, 12).map((r, i) => {
                const v = metric.of(r)
                const top = metric.of(tableRows[0]) || 1
                return (
                  <div className="rank-row" key={`${r.key}-${r.year}-${r.month ?? 'y'}`}>
                    <span className="rank-index">{i + 1}</span>
                    <span className="rank-body">
                      <span className="rank-head">
                        <span className="rank-name">{r.name}</span>
                        <span className="rank-value">{metric.format(v)}</span>
                      </span>
                      <span className="bar-track" style={{ height: 6 }}>
                        <span
                          className="bar-fill"
                          style={{ height: 6, width: `${Math.max(((v ?? 0) / top) * 100, 2)}%`, background: 'var(--seq-500)' }}
                        />
                      </span>
                      <span className="rank-meta">{r.sublabel}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </AsyncSection>
          <CardFoot>
            Ranked on the selected metric.{' '}
            {isRegion
              ? 'Regions have large, stable denominators, so per-100k here is a fair comparison.'
              : 'Small municipalities dominate the per-100k view — that is real, not an artefact: a low denominator makes incidence volatile.'}
          </CardFoot>
        </Card>
      )}
      </div>
    </>
  )
}
