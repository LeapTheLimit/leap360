import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App'
import { ServicesView } from './pages/ServicesView'
import { TracesView } from './pages/TracesView'
import { TraceDetailView } from './pages/TraceDetailView'
import { KillSwitchView } from './pages/KillSwitchView'
import { ViolationsView } from './pages/ViolationsView'
import { PoliciesView } from './pages/PoliciesView'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Navigate to="/services" replace />} />
          <Route path="services" element={<ServicesView />} />
          <Route path="services/:serviceId/traces" element={<TracesView />} />
          <Route path="traces/:traceId" element={<TraceDetailView />} />
          <Route path="killswitch" element={<KillSwitchView />} />
          <Route path="violations" element={<ViolationsView />} />
          <Route path="policies" element={<PoliciesView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
