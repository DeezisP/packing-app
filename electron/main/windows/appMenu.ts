import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron'
import { updateService } from '../services/UpdateService'

const REPO_URL = 'https://github.com/DeezisP/packing-app'

/** Minimal application menu. The window keeps autoHideMenuBar so this stays
 *  out of the way during normal barcode-scanning operation (kiosk-style) but
 *  is still reachable via Alt, which is where "Check for Updates" lives. */
export function buildAppMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'PackingRecorder',
      submenu: [
        {
          label: 'Check for Updates...',
          click: (): void => {
            void updateService.check()
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'View Releases on GitHub',
          click: (): void => {
            void shell.openExternal(`${REPO_URL}/releases`)
          }
        },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
