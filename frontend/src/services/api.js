import axios from 'axios'

// In dev, Vite proxies /api to the Node.js server (see vite.config.js).
// In production, set VITE_API_BASE_URL to the deployed API origin.
export const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'

const client = axios.create({
  baseURL: apiBase,
})

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('dews_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export const regionsApi = {
  // `level` scopes the result: 'region' = the 17 study regions,
  // 'municipality' = the 142 CALABARZON LGUs. Omit for both, tagged with
  // admin_level. Always pass one — an untagged mixed list puts
  // "National Capital Region" next to "Agdangan" in a selector.
  list: (level) =>
    client.get('/regions', { params: level ? { level } : undefined }).then((r) => r.data),
}

export const casesApi = {
  list: (regionId) => client.get('/cases', { params: { regionId } }).then((r) => r.data),
  upload: (rows) => client.post('/cases/bulk', { rows }).then((r) => r.data),
}

export const surveillanceApi = {
  // Annual cases per LGU with the census denominator attached — feeds the map.
  annual: (regionCode) =>
    client.get('/cases/annual', { params: regionCode ? { regionCode } : undefined }).then((r) => r.data),
}

export const predictionsApi = {
  // level: 50 | 80 | 95 — which stored interval to serve as ci_lower/ci_upper
  // (default 95). Bad levels are a 400, so only pass validated values.
  forRegion: (regionId, modelRunId, level) =>
    client.get(`/predictions/${regionId}`, { params: { modelRunId, level } }).then((r) => r.data),
}

/*
 * The modelling panel: one row per region-month with the target and every
 * predictor. Key rows on `period` ("YYYY-MM"), never on `date` — the latter is
 * a timestamp at local midnight and slicing it yields the previous month.
 */
export const panelApi = {
  get: ({ region, regionId, from, to } = {}) =>
    client.get('/panel', { params: { region, regionId, from, to } }).then((r) => r.data),
}

export const modelsApi = {
  // scope: 'overall' (one row per model) | 'region' (one row per model-region)
  compare: (scope) =>
    client.get('/models/compare', { params: scope ? { scope } : undefined }).then((r) => r.data),

  // Nominal vs empirical interval coverage. regionId 'overall' = pooled.
  coverage: (runId, regionId) =>
    client.get(`/models/${runId}/coverage`, { params: regionId ? { regionId } : undefined })
      .then((r) => r.data),

  // PIT bins — flat is calibrated, U-shaped is overconfident.
  calibration: (runId) => client.get(`/models/${runId}/calibration`).then((r) => r.data),

  /*
   * Feature effects with credible intervals. Every row carries `crosses_zero`,
   * computed server-side: when it is 1 the effect is not distinguishable from
   * no effect, and the UI must say so rather than just ranking it lower.
   * regionId 'global' = pooled across regions.
   */
  importance: (runId, regionId) =>
    client.get(`/models/${runId}/importance`, { params: regionId ? { regionId } : undefined })
      .then((r) => r.data),
}

export const alertsApi = {
  // Defaults to the 17 study regions server-side; pass 'all' to audit the table.
  list: (level) => client.get('/alerts', { params: level ? { level } : {} }).then((r) => r.data),
  // One row per study region: current risk level plus the demographic, climate
  // and case context the map's hover panel shows.
  regions: (year) => client.get('/alerts/regions', { params: year ? { year } : {} }).then((r) => r.data),
}

export const authApi = {
  login: (email, password) => client.post('/auth/login', { email, password }).then((r) => r.data),
}

export const fixtureApi = {
  // Synthetic DEMO FIXTURE inspector. region = slug, split = train | test |
  // diagnostic_excluded; both optional. The server filters the whole file
  // before capping the sample, so ?region=R13 returns R13's rows.
  get: ({ region, split } = {}) =>
    client.get('/fixture', { params: { region, split } }).then((r) => r.data),
}

export default client
