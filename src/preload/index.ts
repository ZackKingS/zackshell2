import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  HostInput,
  HostMeta,
  SessionDataEvent,
  SessionStatusEvent,
  MonitorEvent,
  SysInfoEvent
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
  onSessionData: (cb: (e: SessionDataEvent) => void): (() => void) =>
    subscribe('session:data', cb),
  onSessionStatus: (cb: (e: SessionStatusEvent) => void): (() => void) =>
    subscribe('session:status', cb),
  onMonitorData: (cb: (e: MonitorEvent) => void): (() => void) => subscribe('monitor:data', cb),
  onMonitorSysInfo: (cb: (e: SysInfoEvent) => void): (() => void) =>
    subscribe('monitor:sysinfo', cb)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
