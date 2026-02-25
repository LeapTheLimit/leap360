import { Outlet } from 'react-router-dom'
import { Activity } from 'lucide-react'

function App() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 flex flex-col">
      <header className="bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800 px-6 py-4 flex items-center space-x-3">
        <Activity className="h-6 w-6 text-blue-600 dark:text-blue-500" />
        <h1 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
          Leap360 <span className="text-gray-500 dark:text-gray-400 font-normal">Agent Control Plane</span>
        </h1>
      </header>
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <Outlet />
      </main>
    </div>
  )
}

export default App
