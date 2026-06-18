import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  HostInput,
  HostMeta,
  SessionDataEvent,
  SessionStatusEvent,
  MonitorEvent,
  SysInfoEvent,
  SftpEntry,
  SftpProgressEvent
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  hosts: {
    list: (): Promise<HostMeta[]> => ipcRenderer.invoke('hosts:list'),
    save: (input: HostInput): Promise<HostMeta> => ipcRenderer.invoke('hosts:save', input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('hosts:delete', id)
  },
  session: {
    open: (sessionId: string, hostId: string): Promise<void> =>
      ipcRenderer.invoke('session:open', sessionId, hostId),
    close: (id: string): Promise<void> => ipcRenderer.invoke('session:close', id),
    write: (id: string, data: string): void => ipcRenderer.send('session:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('session:resize', id, cols, rows)
  },
  sftp: {
    list: (id: string, remotePath: string): Promise<{ ok: boolean; entries?: SftpEntry[]; error?: string }> =>
      ipcRenderer.invoke('sftp:list', id, remotePath),
    mkdir: (id: string, remotePath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('sftp:mkdir', id, remotePath),
    rename: (id: string, oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('sftp:rename', id, oldPath, newPath),
    remove: (id: string, remotePath: string, isDir: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('sftp:remove', id, remotePath, isDir),
    chmod: (id: string, remotePath: string, mode: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('sftp:chmod', id, remotePath, mode),
    download: (id: string, transferId: string, remotePath: string, localPath: string): Promise<void> =>
      ipcRenderer.invoke('sftp:download', id, transferId, remotePath, localPath),
    upload: (id: string, transferId: string, localPath: string, remotePath: string): Promise<void> =>
      ipcRenderer.invoke('sftp:upload', id, transferId, localPath, remotePath),
    log: (level: string, message: string): void =>
      ipcRenderer.send('sftp:log', level, message),
    getPathForFile: (file: File): string => webUtils.getPathForFile(file)
  },
  onSessionData: (cb: (e: SessionDataEvent) => void): (() => void) =>
    subscribe('session:data', cb),
  onSessionStatus: (cb: (e: SessionStatusEvent) => void): (() => void) =>
    subscribe('session:status', cb),
  onMonitorData: (cb: (e: MonitorEvent) => void): (() => void) => subscribe('monitor:data', cb),
  onMonitorSysInfo: (cb: (e: SysInfoEvent) => void): (() => void) =>
    subscribe('monitor:sysinfo', cb),
  onSftpProgress: (cb: (e: SftpProgressEvent) => void): (() => void) =>
    subscribe('sftp:progress', cb)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
