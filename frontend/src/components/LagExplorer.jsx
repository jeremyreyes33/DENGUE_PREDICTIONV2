import { useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useChartTheme } from '../lib/useChartTheme.js'
import { toNumber, formatInt, formatNumber } from '../lib/format.js'
import { FIELD_MAP, ccfByLag, lagValues } from '../lib/panelFields.js'
import { Card, CardBody, CardHead } from './Card.jsx'
import { LegendItem, Notice, PageHeader, Select, ViewToggle } from './Controls.jsx'
import { AsyncSection, EmptyState, SkeletonBlock } from './States.jsx'
import ChartTooltip from './ChartTooltip.jsx'
import DataTable from './DataTable.jsx'
import Scatter from './Scatter.jsx'
import StatCard from './StatCard.jsx';

/*
 * Lag explorer: climate leads dengue by weeks to months, so plotting both
 * series contemporaneously hides the relationship the model is built on. This
 * view shifts the climate series back by a selectable lag and shows three
 * mutually-checking pictures of the same claim:
 *
 *   1. overlay — cases and lag-shifted climate on one axis, so the eye can
 *      verify the alignment the slider asserts;
 *   2. CCF bars — Pearson r at every lag 0..6, so "lag 3" is a measurement,
 *      not a slider position that happens to look nice;
 *   3. scatter at the best lag — the relationship with its r and n printed.
 *
 * The overlay deliberately z-scores both series instead of using a second
 * y-axis. The alignment between two y-axes is arbitrary -- rescale either
 * side and any two curves can be made to coincide -- while standard
 * deviations from the monthly mean are a fixed, stated transform. The axis
 * says so.
 *
 * Only API-servable variables are offered (temperature, rainfall, humidity,
 * hot days). ONI and ovitrap live in the synthetic CSV only; FIELD_MAP marks
 * them api: null, and this selector reads that flag rather than hardcoding
 * the list -- so a future enso_index backfill appears here for free.
 */

const VAR_KEYS = Object.entries(FIELD_MAP)
  .filter(([, spec]) => spec.api && spec.bestLag !== undefined && spec.bestLag !== null)
  .map(([key]) => key);

const MECHANISM = {
  temperature: 'Warmth speeds larval development and viral replication — the effect shows up a full mosquito-generation chain later, around three months.',
  rainfall: 'Standing water becomes breeding habitat; about one mosquito generation separates the rain from the reported bite.',
  humidity: 'Damp air lengthens adult mosquito survival, so the biting population builds shortly before cases are reported.',
  hot_days: 'Extreme heat cuts both ways: faster development against containers drying out. Expect the weakest, noisiest signal of the four.',
};

function zscore(values) {
  const clean = values.filter((v) => v !== null && Number.isFinite(v));
  if (clean.length < 3) return values.map(() => null);
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  const sd = Math.sqrt(clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length) || 1;
  return values.map((v) => (v === null || !Number.isFinite(v) ? null : (v - mean) / sd));
}

export default function LagExplorer({ panel, loading, error, refetch, activeSlug, regionName }) {
  const t = useChartTheme();
  const [varKey, setVarKey] = useState('rainfall');
  const [lag, setLag] = useState(FIELD_MAP.rainfall.bestLag);
  const [view, setView] = useState('chart');

  const spec = FIELD_MAP[varKey] ?? FIELD_MAP.rainfall;

  const series = useMemo(() => {
    const rows = (panel ?? [])
      .filter((r) => r.region_slug === activeSlug)
      .sort((a, b) => (a.period < b.period ? -1 : 1));
    const periods = rows.map((r) => r.period);
    const cases = rows.map((r) => toNumber(r.confirmed_cases));
    const climate = rows.map((r) => toNumber(r[spec.api]));
    const shifted = lagValues(climate, lag);
    const zCases = zscore(cases);
    const zClim = zscore(shifted);
    return periods.map((period, i) => ({
      period,
      cases: cases[i],
      climate: climate[i],
      zCases: zCases[i],
      zClim: zClim[i],
    }));
  }, [panel, activeSlug, spec.api, lag]);

  const ccf = useMemo(() => {
    const cases = series.map((d) => d.cases);
    const climate = series.map((d) => d.climate);
    return ccfByLag(cases, climate, 6);
  }, [series]);

  /*
   * Best = strongest POSITIVE association, not strongest absolute. The annual
   * cycle guarantees a large negative echo half a period out (rainfall L6 is
   * strongly negative precisely because L0..L2 are positive) -- ranking by
   * |r| would crown the trough's echo instead of the driver. We are hunting
   * the leading indicator: the climate that precedes and increases cases.
   */
  const best = useMemo(() => {
    const ranked = ccf
      .filter((d) => d.r !== null)
      .sort((a, b) => b.r - a.r);
    return ranked[0] ?? null;
  }, [ccf]);

  const scatterPoints = useMemo(() => {
    const shifted = lagValues(series.map((d) => d.climate), best?.lag ?? lag);
    return series.map((d, i) => ({
      x: shifted[i],
      y: d.cases,
      label: d.period,
    })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }, [series, best, lag]);

  const shiftedClimate = useMemo(
    () => lagValues(series.map((d) => d.climate), lag),
    [series, lag],
  );

  const n = series.filter((d) => d.cases !== null && d.climate !== null).length;

  return (
    <>
      <PageHeader
        title={`Lag explorer — ${regionName}`}
        description="Shift the climate series back in time and watch cases line up behind it. Both series are z-scored so they share one honest axis."
      />

      <AsyncSection
        loading={loading}
        error={error}
        isEmpty={!loading && !error && series.length === 0}
        onRetry={refetch}
        skeleton={<SkeletonBlock height={300} />}
        empty={(
          <EmptyState
            icon="clock"
            title="No panel rows for this region"
            body="The explorer needs the region-month panel. Load it with npm run etl:revised in the backend first."
          />
        )}
      >
        <Card>
          <CardBody>
            <div className="filter-bar">
              <Select
                label="Climate variable"
                value={varKey}
                onChange={(v) => { setVarKey(v); setLag(FIELD_MAP[v].bestLag ?? 0); }}
                options={VAR_KEYS.map((k) => ({ value: k, label: FIELD_MAP[k].label }))}
              />
              {/* Seven buttons overflow a 360px viewport as a rigid row, so this
                  one group wraps; the level/horizon groups elsewhere are short
                  enough to stay rigid. */}
              <div className="segmented" role="group" aria-label="Lag in months" style={{ flexWrap: 'wrap' }}>
                {[0, 1, 2, 3, 4, 5, 6].map((k) => (
                  <button key={k} type="button" aria-pressed={lag === k} onClick={() => setLag(k)}>
                    {k === 0 ? '±0' : `−${k}`}
                  </button>
                ))}
              </div>
              <span className="tag">{spec.unit} · shifted {lag} mo</span>
              <span className="filter-bar-spacer" />
              <ViewToggle view={view} onChange={setView} label="Lag explorer view" />
            </div>
            <Notice tone="info">{MECHANISM[varKey]}</Notice>
          </CardBody>
        </Card>

        <div className="grid grid-4">
          <StatCard label="Best lag" value={best ? `${best.lag} mo` : '—'} sublabel={`${spec.label} vs cases`} />
          <StatCard
            label="r at best lag"
            value={best && best.r !== null ? formatNumber(best.r, { decimals: 2 }) : '—'}
            sublabel={`n = ${n} months`}
          />
          <StatCard
            label="r at no lag"
            value={ccf[0]?.r !== null && ccf[0]?.r !== undefined ? formatNumber(ccf[0].r, { decimals: 2 }) : '—'}
            sublabel="What a contemporaneous model would see"
          />
          <StatCard label="Viewing lag" value={`${lag} mo`} sublabel={best && lag === best.lag ? 'Matches the measured best' : 'Differs from the measured best'} />
        </div>

        {view === 'table' ? (
          <>
          <Card className="section-gap">
            <CardHead
              title="Cross-correlation by lag"
              description={`Pearson r between monthly cases and ${spec.label.toLowerCase()} shifted back k months. n = ${n} region-months; leading nulls from the shift are excluded, never zero-filled.`}
            />
            <CardBody flush>
              <DataTable
                caption={`Cross-correlation of cases against ${spec.label} by lag, ${regionName}`}
                getRowKey={(r) => r.lag}
                rows={ccf}
                columns={[
                  { key: 'lag', header: 'Lag (months)', render: (r) => (r.lag === 0 ? '±0 (same month)' : `−${r.lag}`) },
                  {
                    key: 'r', header: 'r', align: 'right', className: 'cell-strong',
                    render: (r) => (r.r === null ? <span className="cell-quiet">—</span> : formatNumber(r.r, { decimals: 3 })),
                  },
                  { key: 'best', header: '', render: (r) => (best && r.lag === best.lag ? '← best' : '') },
                ]}
              />
            </CardBody>
          </Card>
          {/* The overlay and scatter twin: every monthly value behind both
              charts, so no number in chart view is hover-only. */}
          <Card>
            <CardHead
              title={`Monthly series — ${regionName}`}
              description={`Observed cases and ${spec.label.toLowerCase()}${lag > 0 ? `, plus the climate shifted −${lag} mo as drawn` : ''}. Shifted cells with no history show a dash, never zero.`}
            />
            <CardBody flush>
              <DataTable
                caption={`Monthly cases and ${spec.label} for ${regionName}`}
                getRowKey={(r) => r.period}
                rows={series}
                columns={[
                  { key: 'period', header: 'Month' },
                  { key: 'cases', header: 'Cases', align: 'right', render: (r) => (r.cases === null ? <span className="cell-quiet">—</span> : formatInt(r.cases)) },
                  {
                    key: 'climate', header: `${spec.label} (${spec.unit})`, align: 'right',
                    render: (r) => (r.climate === null ? <span className="cell-quiet">—</span> : formatNumber(r.climate, { decimals: 1 })),
                  },
                  ...(lag > 0 ? [{
                    key: 'shifted', header: `Shifted −${lag} mo`, align: 'right', className: 'cell-strong',
                    render: (r, i) => {
                      const v = shiftedClimate[i];
                      return v === null ? <span className="cell-quiet">—</span> : formatNumber(v, { decimals: 1 });
                    },
                  }] : []),
                ]}
              />
            </CardBody>
          </Card>
          </>
        ) : (
          <>
            <Card className="section-gap">
              <CardHead
                title={`Aligned series — climate shifted −${lag} mo`}
                description="Both series in standard deviations from their monthly mean. The climate line starts late exactly where the shift leaves no history — that gap is the lag made visible."
                actions={<ViewToggle view={view} onChange={setView} label="Lag explorer view" />}
              />
              <CardBody>
                <div className="legend">
                  <LegendItem shape="line" color={t.series2} label="Cases (z-scored)" />
                  <LegendItem shape="line" color={t.series1} label={`${spec.label} −${lag} mo (z-scored)`} />
                </div>
                <div className="chart-frame">
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={series} margin={{ top: 12, right: 16, bottom: 4, left: -6 }}>
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
                        tickFormatter={(v) => Number(v).toFixed(1)}
                        label={{ value: 'SD from mean', angle: -90, position: 'insideLeft', fill: t.ink3, fontSize: 11 }}
                      />
                      <Tooltip
                        cursor={{ stroke: t.axis, strokeWidth: 1 }}
                        content={(
                          <ChartTooltip
                            labelFormatter={(v) => v}
                            valueFormatter={(value, row) => {
                              if (value === null) return 'no history at this lag';
                              const raw = row?.payload?.[row?.dataKey === 'zCases' ? 'cases' : 'climate'];
                              const sd = `${Number(value).toFixed(2)} SD`;
                              if (row?.dataKey === 'zCases') return `${sd} · ${formatInt(raw)} cases`;
                              return `${sd} · ${formatNumber(raw, { decimals: 1 })} ${spec.unit}`;
                            }}
                          />
                        )}
                      />
                      <Line
                        dataKey="zCases"
                        name="zCases"
                        type="monotone"
                        stroke={t.series2}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: t.series2, stroke: t.surface, strokeWidth: 2 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                      <Line
                        dataKey="zClim"
                        name="zClim"
                        type="monotone"
                        stroke={t.series1}
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        dot={false}
                        activeDot={{ r: 4, fill: t.series1, stroke: t.surface, strokeWidth: 2 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardBody>
            </Card>

            <div className="grid grid-2">
              <Card>
                <CardHead
                  title="Correlation at every lag"
                  description="The slider position is a claim; these bars are the evidence. Strongest bar should sit at the audit's lag."
                />
                <CardBody>
                  <div className="chart-frame">
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={ccf} margin={{ top: 12, right: 16, bottom: 4, left: -6 }}>
                        <CartesianGrid stroke={t.grid} strokeWidth={1} vertical={false} />
                        <XAxis
                          dataKey="lag"
                          tickFormatter={(v) => (v === 0 ? '±0' : `−${v}`)}
                          tick={{ fill: t.ink3, fontSize: 11 }}
                          axisLine={{ stroke: t.axis }}
                          tickLine={false}
                          tickMargin={10}
                        />
                        <YAxis
                          tick={{ fill: t.ink3, fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          tickMargin={8}
                          width={52}
                          tickFormatter={(v) => Number(v).toFixed(1)}
                          domain={[-1, 1]}
                        />
                        <Tooltip
                          cursor={{ fill: t.grid, opacity: 0.35 }}
                          content={(
                            <ChartTooltip
                              labelFormatter={(v) => `Lag −${v} mo`}
                              valueFormatter={(value) => (value === null ? '—' : `r = ${formatNumber(value, { decimals: 3 })}`)}
                            />
                          )}
                        />
                        <Bar dataKey="r" name="r" isAnimationActive={false} radius={[3, 3, 0, 0]}>
                          {ccf.map((d) => (
                            <Cell
                              key={d.lag}
                              fill={best && d.lag === best.lag ? t.accent : t.series3}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardHead
                  title={`Scatter at best lag${best ? ` (−${best.lag} mo)` : ''}`}
                  description="One dot per month. If the alignment is real, the cloud tilts; the fit line reports its own r and n."
                />
                <CardBody>
                  <Scatter
                    points={scatterPoints}
                    xLabel={`${spec.label} (${spec.unit}), −${best?.lag ?? lag} mo`}
                    yLabel="Cases"
                    formatX={(v) => formatNumber(v, { decimals: 1 })}
                    formatY={(v) => formatInt(v)}
                    clampX0={varKey === 'rainfall'}
                    t={t}
                  />
                </CardBody>
              </Card>
            </div>
          </>
        )}
      </AsyncSection>
    </>
  );
}
