import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendJson } from '../utils/http.js'

/*
 * Fixture inspector: serves the SYNTHETIC DEMO FIXTURE CSV as JSON
 * (GET /api/fixture) and as a download (GET /api/fixture/download) so the
 * /fixture page can show what is in the file without any model framing.
 *
 * This is deliberately NOT part of the ETL and writes nothing. The CSV lives
 * outside REVISED DATA SET/ so no loader can mistake it for observations;
 * this controller is the only server-side reader of that folder.
 *
 * A missing file is a 404 with a message, never an empty 200: an empty
 * response would read as "the fixture is empty" instead of "the fixture was
 * never generated" (run `npm run synthetic:demo` in that case).
 *
 * Download filenames ALWAYS carry the DEMO_FIXTURE marker: the name is built
 * server-side from a fixed stem and no query parameter can suppress or alter
 * it -- filters may only append `_SLUG` / `_split` tag segments.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CSV_PATH = path.join(
  HERE, '..', '..', '..', 'RESEARCH DATA SET',
  'SYNTHETIC DEMO FIXTURE - DO NOT USE AS REAL DATA',
  'ph_synthetic_dengue_2016-2020_DEMO_FIXTURE.csv',
)

// Must match the generator default (backend/scripts/generate-synthetic-demo.js)
// and README_DEMO_FIXTURE.md. A reseeded regeneration updates all three.
const GENERATOR_SEED = 20260214
const SAMPLE_CAP = 200
const FILENAME_STEM = 'ph_synthetic_dengue_2016-2020_DEMO_FIXTURE'
const VALID_SPLITS = ['train', 'test', 'diagnostic_excluded']

function fixtureExists() {
  return fs.existsSync(CSV_PATH)
}

// The generator writes no quoted commas, so a plain split is exact. If a
// future regeneration ever quotes a field, this must become a real parser
// rather than silently misaligning columns. Single assumption point for both
// endpoints, so they can never disagree about the file's contents.
function readFixture() {
  const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split(/\r?\n/)
  const cols = lines[0].split(',')
  const rows = lines.slice(1).map((ln) => {
    const cells = ln.split(',')
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']))
  })
  return { cols, rows }
}

function splitCounts(rows) {
  const splits = { train: 0, test: 0, diagnostic_excluded: 0 }
  for (const r of rows) {
    if (splits[r.split] !== undefined) splits[r.split] += 1
  }
  return splits
}

// Filters apply to the whole file BEFORE any cap, so ?region=R13 returns
// R13's 60 rows rather than an empty page. Unknown slugs are not a 400:
// they honestly match zero rows.
function applyFilters(rows, region, split) {
  return rows.filter((r) => (
    (region === undefined || r.slug === String(region))
    && (split === undefined || r.split === String(split))
  ))
}

function checkSplit(res, split) {
  if (split !== undefined && !VALID_SPLITS.includes(String(split))) {
    sendJson(res, 400, {
      error: `Bad "split": expected one of ${VALID_SPLITS.join(', ')}, got "${split}"`,
    })
    return false
  }
  return true
}

export async function getFixture(req, res) {
  const { region, split } = req.query ?? {};
  if (!checkSplit(res, split)) return;
  if (!fixtureExists()) {
    return sendJson(res, 404, {
      error: 'Synthetic fixture CSV not found. Generate it with `npm run synthetic:demo` in backend/.',
    })
  }

  const { cols, rows } = readFixture()
  const filtered = applyFilters(rows, region, split)

  sendJson(res, 200, {
    file: path.basename(CSV_PATH),
    seed: GENERATOR_SEED,
    generated_from: 'backend/scripts/generate-synthetic-demo.js',
    readme: 'RESEARCH DATA SET/SYNTHETIC DEMO FIXTURE - DO NOT USE AS REAL DATA/README_DEMO_FIXTURE.md',
    rows: rows.length,
    cols,
    splits: splitCounts(rows),
    filters: {
      region: region === undefined ? null : String(region),
      split: split === undefined ? null : String(split),
    },
    filtered: filtered.length,
    sample_cap: SAMPLE_CAP,
    truncated: filtered.length > SAMPLE_CAP,
    sample: filtered.slice(0, SAMPLE_CAP),
  })
}

export async function downloadFixture(req, res) {
  const { region, split } = req.query ?? {};
  if (!checkSplit(res, split)) return;
  if (!fixtureExists()) {
    return sendJson(res, 404, {
      error: 'Synthetic fixture CSV not found. Generate it with `npm run synthetic:demo` in backend/.',
    })
  }

  const { cols, rows } = readFixture()
  const filtered = applyFilters(rows, region, split)

  // Marker stem first, always; each active filter appends one tag segment.
  // Nothing the client sends can rename or drop the DEMO_FIXTURE marker.
  const tags = [
    region === undefined ? null : String(region).toUpperCase().replace(/[^A-Z0-9]+/g, ''),
    split === undefined ? null : String(split).toLowerCase().replace(/[^a-z0-9]+/g, ''),
  ].filter(Boolean)
  const filename = `${FILENAME_STEM}${tags.length ? `_${tags.join('_')}` : ''}.csv`

  const body = [cols.join(','), ...filtered.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n'
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}
