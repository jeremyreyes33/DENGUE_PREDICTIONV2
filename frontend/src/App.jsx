import { Routes, Route, Link } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import { Card } from './components/Card.jsx'
import { EmptyState } from './components/States.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Response from './pages/Response.jsx'
import DataManagement from './pages/DataManagement.jsx'
import Forecast from './pages/Forecast.jsx'
import ModelComparison from './pages/ModelComparison.jsx'
import Methodology from './pages/Methodology.jsx'
import Alerts from './pages/Alerts.jsx'
import RiskMap from './pages/RiskMap.jsx'
import Calibration from './pages/Calibration.jsx'
import Fixture from './pages/Fixture.jsx'
import Drivers from './pages/Drivers.jsx'
import Mathematics from './pages/Mathematics.jsx'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/response" element={<Response />} />
        <Route path="/forecast" element={<Forecast />} />
        <Route path="/models" element={<ModelComparison />} />
        <Route path="/methodology" element={<Methodology />} />
        <Route path="/data" element={<DataManagement />} />
        <Route path="/fixture" element={<Fixture />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/map" element={<RiskMap />} />
        <Route path="/calibration" element={<Calibration />} />
        <Route path="/drivers" element={<Drivers />} />
        <Route path="/mathematics" element={<Mathematics />} />
        <Route
          path="*"
          element={(
            <Card>
              <EmptyState
                icon="inbox"
                title="Page not found"
                body="That route isn't part of the app."
                actions={<Link className="btn btn-primary btn-sm" to="/">Back to the dashboard</Link>}
              />
            </Card>
          )}
        />
      </Routes>
    </Layout>
  )
}
