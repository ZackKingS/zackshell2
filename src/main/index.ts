import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { SSHManager } from './sshManager'
import { hostStore } from './store'
import type { HostInput } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let ssh: SSHManager

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'zack-shell',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

function registerIpc(): void {
  ipcMain.handle('hosts:list', () => hostStore.list())
  ipcMain.handle('hosts:save', (_e, input: HostInput) => hostStore.save(input))
  ipcMain.handle('hosts:delete', (_e, id: string) => hostStore.remove(id))

  ipcMain.handle('session:open', (_e, sessionId: string, hostId: string) => {
    const host = hostStore.getForConnect(hostId)
    if (!host) {
      send('session:status', { id: sessionId, status: 'error', message: 'Host not found' })
      return
    }
    ssh.open(sessionId, host)
  })
  ipcMain.on('session:write', (_e, id: string, data: string) => ssh.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    ssh.resize(id, cols, rows)
  )
  ipcMain.handle('session:close', (_e, id: string) => ssh.close(id))
}

app.whenReady().then(() => {
  ssh = new SSHManager(send)
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  ssh?.closeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => ssh?.closeAll())
