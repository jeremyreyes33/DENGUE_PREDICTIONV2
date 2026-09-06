import { query } from '../config/db.js'
import { sendJson } from '../utils/http.js'

// Predictions are produced by the separate Python model service and written
// into MySQL. This endpoint reads one run's forecast for a region.
//
// ?modelRunId= picks the run (default newest by trained_at, id breaking ties
// because seeded runs share a timestamp; without the tiebreak MySQL can
// return a run that holds no prediction rows).
// ?level=50|80|95 picks which stored interval to serve as ci_lower/ci_upper
// (default 95, the pair kept on predictions for back-compat). Anything else
// is a 400, not a silent fallback to 95: a mislabelled interval is worse
// than an error, since coverage cannot be assessed against a wrong target.
const INTERVAL_LEVELS = ['50', '80', '95']

export async function getPredictionsForRegion(req, res) {
  const { regionId } = req.params
  const { modelRunId, level } = req.query

  if (level !== undefined && !INTERVAL_LEVELS.includes(String(level))) {
    return sendJson(res, 400, {
      error: `Bad "level": expected one of ${INTERVAL_LEVELS.join(', ')}, got "${level}"`,
    })
  }

  const runId = modelRunId
    ? modelRunId
    : (
        await query(
          // id breaks the tie: seeded runs share a trained_at, and without it
          // MySQL can return a run that has no predictions rows.
          'SELECT id FROM model_runs ORDER BY trained_at DESC, id DESC LIMIT 1',
        )
      )[0]?.id

  if (!runId) {
    return sendJson(res, 200, [])
  }

  // The 95 percent band lives on predictions itself. Other levels live in
  // prediction_intervals, one row per level, so they join in here. Either way
  // the response keeps the same keys, and existing callers are unaffected.
  // predicted_median ships in both shapes: the median path is not always the
  // mean (predicted_cases), and bands must centre on what they were built over.
  const rows = level === undefined || String(level) === '95'
    ? await query(
      `SELECT date, predicted_cases, predicted_median, ci_lower, ci_upper
       FROM predictions
       WHERE region_id = :regionId AND model_run_id = :runId
       ORDER BY date ASC`,
      { regionId, runId },
    )
    : await query(
      `SELECT p.date, p.predicted_cases, p.predicted_median, pi.lower AS ci_lower, pi.upper AS ci_upper
       FROM predictions p
       JOIN prediction_intervals pi
         ON pi.prediction_id = p.id AND pi.nominal_level = :level
       WHERE p.region_id = :regionId AND p.model_run_id = :runId
       ORDER BY p.date ASC`,
      { regionId, runId, level: String(level) },
    )
  sendJson(res, 200, rows)
}
