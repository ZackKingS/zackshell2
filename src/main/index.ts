import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { SSHManager } from './sshManager'
import { hostStore } from './store'
import type { HostInput } from '@shared/types'
import { logger } from './services/logger'

let mainWindow: BrowserWindow | null = null
let ssh: SSHManager

function createWindow(): void {
  logger.info('App', '开始创建应用主窗口 BrowserWindow')
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

  mainWindow.on('ready-to-show', () => {
    logger.info('App', '主窗口已就绪，正在显示主窗口')
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    logger.info('App', `拦截到窗口打开请求，通过外部浏览器打开 URL: ${url}`)
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    logger.info('App', `加载开发服务器 URL: ${process.env.ELECTRON_RENDERER_URL}`)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const htmlPath = join(__dirname, '../renderer/index.html')
    logger.info('App', `加载生产 HTML 文件: ${htmlPath}`)
    mainWindow.loadFile(htmlPath)
  }
}

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

function registerIpc(): void {
  logger.info('App', '开始注册 IPC 路由监听器')
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
  // ---- SFTP ----
  ipcMain.handle('sftp:list', async (_e, id: string, remotePath: string) => {
    try {
      const entries = await ssh.sftpList(id, remotePath)
      return { ok: true, entries }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('sftp:mkdir', async (_e, id: string, remotePath: string) => {
    try { await ssh.sftpMkdir(id, remotePath); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('sftp:rename', async (_e, id: string, oldPath: string, newPath: string) => {
    try { await ssh.sftpRename(id, oldPath, newPath); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('sftp:remove', async (_e, id: string, remotePath: string, isDir: boolean) => {
    try { await ssh.sftpRemove(id, remotePath, isDir); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('sftp:chmod', async (_e, id: string, remotePath: string, mode: number) => {
    try { await ssh.sftpChmod(id, remotePath, mode); return { ok: true } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  })
  ipcMain.handle('sftp:download', (_e, id: string, transferId: string, remotePath: string, localPath: string) => {
    ssh.sftpDownload(id, transferId, remotePath, localPath)
  })
  ipcMain.handle('sftp:upload', (_e, id: string, transferId: string, localPath: string, remotePath: string) => {
    ssh.sftpUpload(id, transferId, localPath, remotePath)
  })
  ipcMain.handle('sftp:cancel', (_e, id: string, transferId: string) => {
    ssh.sftpCancel(id, transferId)
  })
  ipcMain.on('sftp:log', (_e, level: 'INFO' | 'ERROR' | 'WARN', message: string) => {
    if (level === 'ERROR') {
      logger.error('Renderer', message)
    } else if (level === 'WARN') {
      logger.warn('Renderer', message)
    } else {
      logger.info('Renderer', message)
    }
  })
}

app.whenReady().then(() => {
  logger.info('App', 'Electron 应用 ready 事件触发，初始化主进程服务')
  ssh = new SSHManager(send)
  registerIpc()
  createWindow()

  app.on('activate', () => {
    logger.info('App', 'Electron activate 事件触发')
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  logger.info('App', '所有窗口已关闭 (window-all-closed)')
  ssh?.closeAll()
  if (process.platform !== 'darwin') {
    logger.info('App', '非 macOS 平台下窗口全关，退出应用')
    app.quit()
  }
})

app.on('before-quit', () => {
  logger.info('App', '应用准备退出 (before-quit)，开始关闭所有 SSH 会话')
  ssh?.closeAll()
})
