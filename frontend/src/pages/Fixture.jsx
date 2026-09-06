import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useFetch } from '../hooks/useFetch.js'
import { apiBase, fixtureApi, regionsApi } from '../services/api.js'
import { Card, CardBody, CardHead } from '../components/Card.jsx'
import { Notice, PageHeader, Select } from '../components/Controls.jsx'
import { AsyncSection, EmptyState, SkeletonRows } from '../components/States.jsx'
import DataTable from '../components/DataTable.jsx'
import StatCard from '../components/StatCard.jsx'
import Icon from '../components/Icon.jsx'
import { formatInt } from '../lib/format.js'
import { FIELD_MAP } from '../lib/panelFields.js';

/*
 * Synthetic fixture inspector: a viewer for the DEMO FIXTURE CSV that cannot
 * be mistaken for results. Three structural choices carry that:
 *
 * - Identity first: the title, the watermark tag and the pinned notice all
 *   say synthetic before any number appears, and the footer line makes every
 *   screenshot self-discrediting.
 * - No results-shaped content: column dictionary, filterable sample rows and
 *   file-integrity checks. No rankings, no forecasts, no charts that could
 *   read as conclusions about dengue.
 * - Server-side filtering with a stated cap: ?region=&split= filter the whole
 *   1,020-row file before the 200-row sample cap, and `truncated` says when
 *   the cap bit. A client-side slice of the first 200 rows would have shown
 *   an empty page for most regions -- absence as a bug, not as data.
 */

const PAGE_SIZE = 50;
const EXPECTED = { rows: 1020, cols: 28, seed: 20260214, train: 612, test: 204, diagnostic_excluded: 204 };

export default function Fixture() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(0);
  const region = params.get('region') ?? 'all';
  const split = params.get('split') ?? 'all';

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value === null || value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next);
    setPage(0);
  };

  const { data: regions } = useFetch(() => regionsApi.list('region'), []);
  const {
    data, loading, error, refetch,
  } = useFetch(() => fixtureApi.get({
    region: region !== 'all' ? region : undefined,
    split: split !== 'all' ? split : undefined,
  }), [region, split]);

  const dictionary = useMemo(() => Object.entries(FIELD_MAP).map(([key, spec]) => ({
    key,
    column: spec.csv,
    meaning: `${spec.label}${spec.unit ? ` (${spec.unit})` : ''}`,
    servedBy: spec.api ? `API · ${spec.api}` : 'CSV only',
    lag: spec.bestLag ?? '—',
    note: spec.note ?? '',
  })), []);

  const sample = data?.sample ?? [];
  const pages = Math.max(1, Math.ceil(sample.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const pageRows = sample.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  /*
   * Plain anchor, not fetch+Blob: the browser honours the server's
   * Content-Disposition filename (which always carries DEMO_FIXTURE), and the
   * download streams the full filtered file rather than this 200-row preview.
   * Query mirrors the browser filters, so button and table always agree.
   */
  const downloadParams = new URLSearchParams();
  if (region !== 'all') downloadParams.set('region', region);
  if (split !== 'all') downloadParams.set('split', split);
  const downloadQuery = downloadParams.toString();
  const downloadUrl = `${apiBase}/fixture/download${downloadQuery ? `?${downloadQuery}` : ''}`;
  const downloadLabel = region === 'all' && split === 'all'
    ? 'Download CSV (all 1,020 rows)'
    : `Download CSV (${[region !== 'all' ? region : null, split !== 'all' ? split : null].filter(Boolean).join(' · ')})`;

  const checks = useMemo(() => {
    if (!data) return [];
    const allFlagged = sample.length > 0 && sample.every((r) => r.is_demo_fixture === '1');
    return [
      {
        key: 'rows', check: 'Row count', expected: String(EXPECTED.rows),
        observed: formatInt(data.rows), pass: data.rows === EXPECTED.rows,
      },
      {
        key: 'cols', check: 'Column count', expected: String(EXPECTED.cols),
        observed: String(data.cols?.length ?? '—'), pass: data.cols?.length === EXPECTED.cols,
      },
      {
        key: 'splits', check: 'Train / test / excluded', expected: '612 / 204 / 204',
        observed: `${data.splits?.train ?? '—'} / ${data.splits?.test ?? '—'} / ${data.splits?.diagnostic_excluded ?? '—'}`,
        pass: data.splits?.train === 612 && data.splits?.test === 204 && data.splits?.diagnostic_excluded === 204,
      },
      {
        key: 'seed', check: 'Generator seed', expected: String(EXPECTED.seed),
        observed: String(data.seed ?? '—'), pass: data.seed === EXPECTED.seed,
      },
      {
        key: 'flag', check: 'Every sampled row DEMO-flagged', expected: 'all is_demo_fixture = 1',
        observed: allFlagged ? `yes (${sample.length} rows)` : 'NO — unflagged rows present',
        pass: allFlagged,
      },
    ];
  }, [data, sample]);

  return (
    <>
      <PageHeader
        title="Synthetic fixture inspector"
        description="What is inside the DEMO FIXTURE file — its columns, its rows, its integrity checks. Nothing here is observed dengue data."
        actions={<span className="tag"><Icon name="file" size={12} />SYNTHETIC — NOT REAL DATA</span>}
      />

      <Notice tone="warning">
        <strong>Every value on this page is invented for pipeline testing</strong> (seed 20260214).
        Do not cite, screenshot as findings, or mix with the REVISED DATA SET panel.
      </Notice>

      <AsyncSection
        loading={loading}
        error={error}
        isEmpty={!loading && !error && !data}
        onRetry={refetch}
        errorTitle="Could not load the fixture"
        skeleton={<SkeletonRows rows={8} />}
        empty={(
          <EmptyState
            icon="file"
            title="Fixture file not found"
            body="Generate it with npm run synthetic:demo in the backend, then reload."
          />
        )}
      >
        {data && (
        <>
          <div className="grid grid-4">
            <StatCard label="Rows" value={formatInt(data.rows)} sublabel={data.file} />
            <StatCard label="Columns" value={formatInt(data.cols?.length ?? 0)} sublabel="28 in the committed file" />
            <StatCard label="Seed" value={String(data.seed)} sublabel={`via ${data.generated_from}`} />
            <StatCard
              label="Train / test / excluded"
              value={`${data.splits?.train ?? '—'} / ${data.splits?.test ?? '—'} / ${data.splits?.diagnostic_excluded ?? '—'}`}
              sublabel="2020 excluded from headline scoring"
            />
          </div>

          <Card className="section-gap">
            <CardHead
              title="Column dictionary"
              description="What each fixture column means and where the production app can serve it from. “CSV only” marks a variable the live panel does not have yet — the backfill each note names."
            />
            <CardBody flush>
              <DataTable
                caption="Synthetic fixture column dictionary"
                getRowKey={(r) => r.key}
                rows={dictionary}
                columns={[
                  { key: 'column', header: 'Column', className: 'cell-strong' },
                  { key: 'meaning', header: 'Meaning' },
                  { key: 'servedBy', header: 'Served by' },
                  { key: 'lag', header: 'Best lag', align: 'right' },
                  { key: 'note', header: 'Backfill needed', render: (r) => (r.note ? <span className="cell-quiet">{r.note}</span> : '—') },
                ]}
              />
            </CardBody>
          </Card>

          <Card className="section-gap">
            <CardHead
              title="Sample browser"
              description={data.truncated
                ? `Filters matched ${formatInt(data.filtered)} rows; showing a ${data.sample_cap}-row preview. Narrow the filters to see the rest.`
                : `Showing all ${formatInt(data.filtered)} matching rows of the ${formatInt(data.rows)}-row file.`}
            />
            <CardBody>
              <div className="filter-bar">
                <Select
                  label="Region"
                  value={region}
                  onChange={(v) => setParam('region', v)}
                  options={[
                    { value: 'all', label: 'All regions in sample' },
                    ...((regions ?? []).map((r) => ({ value: r.slug, label: `${r.name} · ${r.slug}` }))),
                  ]}
                />
                <Select
                  label="Split"
                  value={split}
                  onChange={(v) => setParam('split', v)}
                  options={[
                    { value: 'all', label: 'All splits' },
                    { value: 'train', label: 'Train (2016–2018)' },
                    { value: 'test', label: 'Test (2019)' },
                    { value: 'diagnostic_excluded', label: 'Excluded (2020)' },
                  ]}
                />
                <span className="filter-bar-spacer" />
                <a
                  className="btn btn-secondary btn-sm" href={downloadUrl} download
                  title="Full filtered file, not the 200-row preview. The filename always carries DEMO_FIXTURE."
                >
                  <Icon name="download" size={14} />
                  {downloadLabel}
                </a>
                <button
                  type="button" className="btn btn-secondary btn-sm"
                  disabled={safePage === 0} onClick={() => setPage(safePage - 1)}
                >
                  ← Prev
                </button>
                <span className="muted" aria-live="polite">
                  Page {safePage + 1} of {pages}
                </span>
                <button
                  type="button" className="btn btn-secondary btn-sm"
                  disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}
                >
                  Next →
                </button>
              </div>
              {pageRows.length === 0 ? (
                <EmptyState
                  icon="inbox"
                  title="No rows match these filters"
                  body="Unknown slugs honestly return zero rows. Clear a filter to browse again."
                />
              ) : (
                <DataTable
                  caption={`Synthetic fixture sample rows, page ${safePage + 1}`}
                  getRowKey={(r, i) => `${r.slug}-${r.period}-${i}`}
                  rows={pageRows}
                  columns={(data.cols ?? []).map((c) => ({
                    key: c, header: c, align: /cases|deaths|population|density|pct|mm|oni|year|month|hot_days|incidence/.test(c) ? 'right' : undefined,
                  }))}
                />
              )}
            </CardBody>
          </Card>

          <Card className="section-gap">
            <CardHead
              title="File integrity checks"
              description="The same guards the generator asserts before writing. A failing row here means the file on disk is not the fixture the pipeline was validated against."
            />
            <CardBody flush>
              <DataTable
                caption="Synthetic fixture integrity checks"
                getRowKey={(r) => r.key}
                rows={checks}
                columns={[
                  { key: 'check', header: 'Check', className: 'cell-strong' },
                  { key: 'expected', header: 'Expected', align: 'right' },
                  { key: 'observed', header: 'Observed', align: 'right' },
                  {
                    key: 'pass', header: 'Status', align: 'right',
                    render: (r) => (r.pass
                      ? <span><Icon name="check" size={13} /> Pass</span>
                      : <span><Icon name="warning" size={13} /> FAIL</span>),
                  },
                ]}
              />
            </CardBody>
          </Card>

          <Notice tone="info">
            Every value on this page is invented for pipeline testing (seed 20260214) — safe to copy as an example, never as evidence.
          </Notice>
        </>
        )}
      </AsyncSection>
    </>
  );
}
