import { readFileSync } from 'fs'
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import type { FullHost } from './store'
import type { SftpEntry } from '@shared/types'
import { startMonitor, fetchSysInfo, type CpuSample, type NetSample } from './services/telemetryService'
import * as sftpService from './services/sftpService'

export type Sender = (channel: string, payload: unknown) => void

export interface Session {
  id: string
  client: Client
  shell?: ClientChannel
  monitorTimer?: ReturnType<typeof setInterval>
  prevCpu?: CpuSample
  prevNet?: NetSample
  prevNetIf?: Record<string, NetSample>
  prevTime?: number
  sftp?: SFTPWrapper
}

// Re-export logToFile so index.ts doesn't break
export { logToFile } from './services/sftpService'

export class SSHManager {
  private sessions = new Map<string, Session>()

  constructor(private send: Sender) {}

  open(id: string, host: FullHost): void {
    const client = new Client()
    const session: Session = { id, client }
    this.sessions.set(id, session)
    this.send('session:status', { id, status: 'connecting' })

    client.on('ready', () => {
      this.send('session:status', { id, status: 'connected' })
      client.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          this.send('session:status', { id, status: 'error', message: err.message })
          return
        }
        session.shell = stream
        stream.on('data', (d: Buffer) => this.send('session:data', { id, data: d.toString('utf8') }))
        stream.stderr.on('data', (d: Buffer) =>
          this.send('session:data', { id, data: d.toString('utf8') })
        )
        stream.on('close', () => this.close(id))
      })
      startMonitor(session, this.send)
      fetchSysInfo(session, this.send)
    })

    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => host.password ?? ''))
    })

    client.on('error', (err) => {
      this.send('session:status', { id, status: 'error', message: err.message })
    })

    client.on('close', () => {
      this.send('session:status', { id, status: 'closed' })
      this.cleanup(id)
    })

    try {
      client.connect(this.buildConfig(host))
    } catch (e) {
      this.send('session:status', {
        id,
        status: 'error',
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }

  private buildConfig(host: FullHost): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      tryKeyboard: true
    }
    if (host.authType === 'key' && host.privateKeyPath) {
      cfg.privateKey = readFileSync(host.privateKeyPath)
      if (host.passphrase) cfg.passphrase = host.passphrase
    } else {
      cfg.password = host.password
    }
    return cfg
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.shell?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.shell?.setWindow(rows, cols, 0, 0)
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    try {
      s.shell?.end()
    } catch {
      /* ignore */
    }
    try {
      s.client.end()
    } catch {
      /* ignore */
    }
    this.cleanup(id)
  }

  // ===================== SFTP (Delegated to sftpService) =====================

  async sftpList(id: string, remotePath: string): Promise<SftpEntry[]> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Session not found')
    return sftpService.sftpList(session, remotePath)
  }

  async sftpMkdir(id: string, remotePath: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Session not found')
    return sftpService.sftpMkdir(session, remotePath)
  }

  async sftpRename(id: string, oldPath: string, newPath: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Session not found')
    return sftpService.sftpRename(session, oldPath, newPath)
  }

  async sftpRemove(id: string, remotePath: string, isDir: boolean): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Session not found')
    return sftpService.sftpRemove(session, remotePath, isDir)
  }

  async sftpChmod(id: string, remotePath: string, mode: number): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Session not found')
    return sftpService.sftpChmod(session, remotePath, mode)
  }

  sftpDownload(id: string, transferId: string, remotePath: string, localPath: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    sftpService.sftpDownload(session, this.send, transferId, remotePath, localPath)
  }

  sftpUpload(id: string, transferId: string, localPath: string, remotePath: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    sftpService.sftpUpload(session, this.send, transferId, localPath, remotePath)
  }

  sftpCancel(id: string, transferId: string): void {
    sftpService.sftpCancel(id, transferId)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  private cleanup(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.monitorTimer) clearInterval(s.monitorTimer)
    try {
      s.sftp?.end()
    } catch {
      /* ignore */
    }
    sftpService.sftpCancelSession(id)
    this.sessions.delete(id)
  }
}
