// Shared type contract between main, preload and renderer.

export type AuthType = 'password' | 'key'

/** Host as the renderer sees it — never carries plaintext secrets. */
export interface HostMeta {
  id: string
  name: string
  group: string
  host: string
  port: number
  username: string
  authType: AuthType
  hasPassword: boolean
  privateKeyPath: string
  hasPassphrase: boolean
}

/** Payload the renderer sends to create or update a host. */
export interface HostInput {
  id?: string
  name: string
  group: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** Only sent when set/changed; undefined means "keep existing". */
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SessionStatusEvent {
  id: string
  status: SessionStatus
  message?: string
}

export interface SessionDataEvent {
  id: string
  data: string
}

export interface DiskUsage {
  mount: string
  used: number // KB
  size: number // KB
  usePct: number
}

export interface ProcInfo {
  pid: number
  cpu: number // percent
  mem: number // percent
  cmd: string
}

/** One sampling of remote system metrics. */
export interface MonitorSnapshot {
  cpu: number // 0-100
  mem: { used: number; total: number } // MB
  swap: { used: number; total: number } // MB
  net: { rx: number; tx: number } // bytes/sec
  uptimeSec: number
  load: [number, number, number]
  disks: DiskUsage[]
  procs: ProcInfo[]
  ip: string
}

export interface MonitorEvent {
  id: string
  snapshot: MonitorSnapshot
}
