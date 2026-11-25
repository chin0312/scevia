import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from './components/shell'

const Overview = lazy(() => import('./pages/Overview'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Risk = lazy(() => import('./pages/Risk'))
const ScenarioLab = lazy(() => import('./pages/ScenarioLab'))
const Records = lazy(() => import('./pages/Records'))

/* Remount a page when its route changes (not on ?query changes). */
function Page({ el: El }: { el: React.ComponentType }) {
  const { pathname } = useLocation()
  return <Suspense fallback={<div className="page-loading" aria-busy="true" aria-label="Loading"><div className="skeleton" style={{ height: 240 }} /><div className="skeleton" style={{ height: 480 }} /></div>}><El key={pathname} /></Suspense>
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Page el={Overview} />} />
        <Route path="/analytics" element={<Page el={Analytics} />} />
        <Route path="/risk" element={<Page el={Risk} />} />
        <Route path="/scenario-lab" element={<Page el={ScenarioLab} />} />
        <Route path="/accounts" element={<Page el={Records} />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  )
}
