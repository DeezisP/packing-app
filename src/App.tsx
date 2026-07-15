import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { DashboardPage } from './pages/DashboardPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { DevicePairingPage } from './pages/DevicePairingPage'
import { BottomPanel } from './components/common/BottomPanel'
import { SaveLocationWarningBanner } from './components/common/SaveLocationWarningBanner'
import { useSaveLocationStatus } from './hooks/useSaveLocationStatus'
import { strings } from './lib/strings'
import type { AppConfig } from '../electron/shared/types'

type Tab = 'dashboard' | 'search' | 'devices' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: strings.tabs.dashboard },
  { id: 'search', label: strings.tabs.search },
  { id: 'devices', label: strings.tabs.devices },
  { id: 'settings', label: strings.tabs.settings }
]

export default function App(): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [tab, setTab] = useState<Tab>('dashboard')
  const saveLocationStatus = useSaveLocationStatus()

  useEffect(() => {
    window.electronAPI.config.get().then(setConfig)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('light', config?.theme === 'light')
  }, [config?.theme])

  if (!config) {
    return (
      <div className="h-screen flex items-center justify-center text-slate-400">
        <div className="app-aurora">
          <span />
          <span />
          <span />
        </div>
        {strings.loading}
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col text-slate-100">
      <div className="app-aurora">
        <span />
        <span />
        <span />
      </div>

      <div className="glass rounded-none border-x-0 border-t-0 flex items-center gap-1 px-4 py-2">
        <span className="font-semibold text-slate-100 mr-4">{strings.appName}</span>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="relative px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-150"
          >
            {tab === t.id && (
              <motion.span
                layoutId="tab-highlight"
                className="absolute inset-0 bg-accent-600 rounded-lg"
                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              />
            )}
            <span className={`relative z-10 ${tab === t.id ? 'text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {t.label}
            </span>
          </button>
        ))}
      </div>

      <AnimatePresence>
        {saveLocationStatus && !saveLocationStatus.writable && (
          <SaveLocationWarningBanner key="save-location-banner" status={saveLocationStatus} />
        )}
      </AnimatePresence>

      {/* popLayout pulls the exiting tab out of flex flow immediately (so it
          can't push the new tab / BottomPanel around) while still fading it
          out - the new tab mounts and animates in right away instead of
          waiting for the old one to finish leaving. */}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="flex-1 flex flex-col overflow-hidden"
        >
          {tab === 'dashboard' && <DashboardPage config={config} onConfigChanged={setConfig} />}
          {tab === 'search' && <SearchPage config={config} />}
          {tab === 'devices' && <DevicePairingPage config={config} onConfigChanged={setConfig} />}
          {tab === 'settings' && <SettingsPage config={config} onConfigChanged={setConfig} />}
        </motion.div>
      </AnimatePresence>

      <BottomPanel />
    </div>
  )
}
