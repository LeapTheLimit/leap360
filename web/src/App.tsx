import { Outlet, NavLink } from 'react-router-dom'
import { Activity, Layers, ShieldOff, AlertTriangle, Shield } from 'lucide-react'

const NAV = [
  { to: '/services',   label: 'Services',    icon: Layers },
  { to: '/violations', label: 'Violations',  icon: AlertTriangle },
  { to: '/policies',   label: 'Policies',    icon: Shield },
  { to: '/killswitch', label: 'Kill Switch', icon: ShieldOff },
]

function App() {
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 mr-4">
          <Activity className="h-5 w-5 text-blue-500" />
          <span className="text-white font-semibold tracking-tight">
            Leap360{' '}
            <span className="text-gray-400 font-normal text-sm">AI Governance</span>
          </span>
        </div>

        <nav className="flex items-center gap-1 flex-wrap">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600/20 text-blue-400'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`
              }
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto text-xs text-gray-600 hidden sm:block">
          Local · http://localhost:4000
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full">
        <Outlet />
      </main>
    </div>
  )
}

export default App
