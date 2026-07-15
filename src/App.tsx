import { useEffect, useState } from 'react'
import { DashboardPage } from './pages/DashboardPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { BottomPanel } from './components/common/BottomPanel'
import { SaveLocationWarningBanner } from './components/common/SaveLocationWarningBanner'
import type { AppConfig } from '../electron/shared/types'

type Tab = 'dashboard' | 'search' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'search', label: 'Search' },
  { id: 'settings', label: 'Settings' }
]

export default function App(): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [tab, setTab] = useState<Tab>('dashboard')

  useEffect(() => {
    window.electronAPI.config.get().then(setConfig)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('light', config?.theme === 'light')
  }, [config?.theme])

  if (!config) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-950 text-slate-400">
        Loading PackingRecorder...
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-surface-950 text-slate-100">
      <div className="flex items-center gap-1 px-4 py-2 border-b border-surface-800 bg-surface-900">
        <span className="font-semibold text-slate-100 mr-4">PackingRecorder</span>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-accent-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-surface-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <SaveLocationWarningBanner />

      {tab === 'dashboard' && <DashboardPage config={config} onConfigChanged={setConfig} />}
      {tab === 'search' && <SearchPage config={config} />}
      {tab === 'settings' && <SettingsPage config={config} onConfigChanged={setConfig} />}

      <BottomPanel />
    </div>
  )
}
