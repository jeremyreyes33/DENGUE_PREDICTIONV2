import { Router } from './router.js'
import { listRegions } from '../controllers/regionsController.js'
import { listCases, bulkInsertCases } from '../controllers/casesController.js'
import { listAnnualCases } from '../controllers/surveillanceController.js'
import { getPredictionsForRegion } from '../controllers/predictionsController.js'
import {
  compareModels, getCoverage, getCalibration, getFeatureImportance,
} from '../controllers/modelsController.js'
import { getPanel } from '../controllers/panelController.js'
import { listAlerts, listRegionRisk } from '../controllers/alertsController.js'
import { getFixture, downloadFixture } from '../controllers/fixtureController.js'
import { login } from '../controllers/authController.js'

export const router = new Router()

router.get('/api/regions', listRegions)

router.get('/api/cases', listCases)
router.get('/api/cases/annual', listAnnualCases)
router.post('/api/cases/bulk', bulkInsertCases)

router.get('/api/predictions/:regionId', getPredictionsForRegion)

router.get('/api/panel', getPanel)

// `/compare` is registered before `/:runId/...` — they cannot collide (three
// segments vs four), but keeping the literal first makes that obvious.
router.get('/api/models/compare', compareModels)
router.get('/api/models/:runId/coverage', getCoverage)
router.get('/api/models/:runId/calibration', getCalibration)
router.get('/api/models/:runId/importance', getFeatureImportance)

router.get('/api/alerts', listAlerts)
router.get('/api/alerts/regions', listRegionRisk)

// Fixture inspector (synthetic DEMO data only): registered after the
// observed-data routes so the grouping stays obvious. Literal first, per the
// house rule from /api/models/compare above.
router.get('/api/fixture/download', downloadFixture)
router.get('/api/fixture', getFixture)

router.post('/api/auth/login', login)
