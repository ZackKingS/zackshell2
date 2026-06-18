import { readFileSync } from 'fs'
import { Client, type ClientChannel } from 'ssh2'
import type { FullHost } from './store'
import type { MonitorSnapshot, ProcInfo, DiskUsage, NetIf, SysInfo } from '@shared/types'

type Sender = (channel: string, payload: unknown) => void

export interface CpuSample {
  total: number
  idle: number
}
export interface NetSample {
  rx: number
  tx: number
}

/** Mutable per-session state needed to compute CPU% and network rates. */
export interface MonitorState {
  prevCpu?: CpuSample
  prevNet?: NetSample
  prevNetIf?: Record<string, NetSample>
  prevTime?: number
}

interface Session {
  id: string
  client: Client
  shell?: ClientChannel
  monitorTimer?: ReturnType<typeof setInterval>
  prevCpu?: CpuSample
  prevNet?: NetSample
  prevNetIf?: Record<string, NetSample>
  prevTime?: number
}

const MONITOR_INTERVAL_MS = 2000

// Single command whose output is split into labelled sections we can parse.
export const MONITOR_CMD = [
  "echo '@@CPU'; grep '^cpu ' /proc/stat",
  "echo '@@MEM'; cat /proc/meminfo",
  "echo '@@NET'; cat /proc/net/dev",
  "echo '@@UP'; cat /proc/uptime",
  "echo '@@LOAD'; cat /proc/loadavg",
  "echo '@@DISK'; df -kP",
  "echo '@@PROC'; ps -eo pid,pcpu,rss,comm --sort=-rss 2>/dev/null | head -n 9",
  "echo '@@IP'; hostname -I 2>/dev/null || hostname -i 2>/dev/null",
  "echo '@@END'"
].join('; ')

// Static host details, fetched once per connection.
const SYSINFO_CMD = [
  "echo '@@HOST'; hostname",
  "echo '@@OS'; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\")",
  "echo '@@KERNEL'; uname -sr",
  "echo '@@CPU'; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2",
  "echo '@@CORES'; nproc 2>/dev/null",
  "echo '@@END'"
].join('; ')

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
      this.startMonitor(session)
      this.fetchSysInfo(session)
    })

    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      // keyboard-interactive fallback: answer every prompt with the password.
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

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  private cleanup(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.monitorTimer) clearInterval(s.monitorTimer)
    this.sessions.delete(id)
  }

  private startMonitor(session: Session): void {
    const sample = (): void => {
      const t0 = Date.now()
      session.client.exec(MONITOR_CMD, (err, stream) => {
        if (err) return
        let out = ''
        stream.on('data', (d: Buffer) => (out += d.toString('utf8')))
        stream.on('close', () => {
          const snapshot = parseMonitorOutput(out, session)
          if (snapshot) {
            snapshot.rttMs = Date.now() - t0
            this.send('monitor:data', { id: session.id, snapshot })
          }
        })
      })
    }
    sample()
    session.monitorTimer = setInterval(sample, MONITOR_INTERVAL_MS)
  }

  private fetchSysInfo(session: Session): void {
    session.client.exec(SYSINFO_CMD, (err, stream) => {
      if (err) return
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString('utf8')))
      stream.on('close', () =>
        this.send('monitor:sysinfo', { id: session.id, info: parseSysInfo(out) })
      )
    })
  }
}

// ---------- monitor parsing (pure, testable) ----------

/** Parse one labelled monitor dump into a snapshot; `state` carries the
 *  previous CPU/net sample so deltas can be computed. Mutates `state`. */
export function parseMonitorOutput(out: string, state: MonitorState): MonitorSnapshot | null {
  const sections = splitSections(out)
  if (!sections.CPU) return null
  const now = Date.now()
  const dtSec = state.prevTime ? Math.max((now - state.prevTime) / 1000, 0.001) : 0

  // --- CPU ---
  const cpuFields = sections.CPU.trim().split(/\s+/).slice(1).map(Number)
  const cpuTotal = cpuFields.reduce((a, b) => a + (b || 0), 0)
  const cpuIdle = (cpuFields[3] || 0) + (cpuFields[4] || 0) // idle + iowait
  let cpuPct = 0
  if (state.prevCpu) {
    const dTotal = cpuTotal - state.prevCpu.total
    const dIdle = cpuIdle - state.prevCpu.idle
    cpuPct = dTotal > 0 ? clamp(((dTotal - dIdle) / dTotal) * 100, 0, 100) : 0
  }
  state.prevCpu = { total: cpuTotal, idle: cpuIdle }

  // --- MEM / SWAP ---
  const mem = parseMeminfo(sections.MEM || '')

  // --- NET (per non-loopback interface + aggregate) ---
  const raw = parseNetDev(sections.NET || '') // cumulative byte counters per iface
  const interfaces: NetIf[] = []
  const nextPrevIf: Record<string, NetSample> = {}
  let aggCumRx = 0
  let aggCumTx = 0
  for (const ni of raw) {
    aggCumRx += ni.rx
    aggCumTx += ni.tx
    nextPrevIf[ni.name] = { rx: ni.rx, tx: ni.tx }
    const prev = state.prevNetIf?.[ni.name]
    let rx = 0
    let tx = 0
    if (prev && dtSec > 0) {
      rx = Math.max((ni.rx - prev.rx) / dtSec, 0)
      tx = Math.max((ni.tx - prev.tx) / dtSec, 0)
    }
    interfaces.push({ name: ni.name, rx: Math.round(rx), tx: Math.round(tx) })
  }
  let aggRx = 0
  let aggTx = 0
  if (state.prevNet && dtSec > 0) {
    aggRx = Math.max((aggCumRx - state.prevNet.rx) / dtSec, 0)
    aggTx = Math.max((aggCumTx - state.prevNet.tx) / dtSec, 0)
  }
  state.prevNet = { rx: aggCumRx, tx: aggCumTx }
  state.prevNetIf = nextPrevIf
  state.prevTime = now

  // --- UPTIME / LOAD ---
  const uptimeSec = Math.floor(parseFloat((sections.UP || '0').trim().split(/\s+/)[0]) || 0)
  const loadParts = (sections.LOAD || '').trim().split(/\s+/).map(Number)
  const load: [number, number, number] = [loadParts[0] || 0, loadParts[1] || 0, loadParts[2] || 0]

  return {
    cpu: round1(cpuPct),
    mem: mem.ram,
    swap: mem.swap,
    net: { rx: Math.round(aggRx), tx: Math.round(aggTx) },
    interfaces,
    rttMs: 0,
    uptimeSec,
    load,
    disks: parseDf(sections.DISK || ''),
    procs: parseProcs(sections.PROC || ''),
    ip: (sections.IP || '').trim().split(/\s+/)[0] || ''
  }
}

// ---------- parsing helpers ----------

function splitSections(out: string): Record<string, string> {
  const result: Record<string, string> = {}
  let current = ''
  for (const line of out.split('\n')) {
    const m = line.match(/^@@(\w+)$/)
    if (m) {
      current = m[1]
      result[current] = ''
    } else if (current) {
      result[current] += line + '\n'
    }
  }
  return result
}

function parseMeminfo(text: string): {
  ram: { used: number; total: number }
  swap: { used: number; total: number }
} {
  const get = (key: string): number => {
    const m = text.match(new RegExp('^' + key + ':\\s+(\\d+)', 'm'))
    return m ? parseInt(m[1], 10) : 0 // kB
  }
  const total = get('MemTotal')
  const available = get('MemAvailable')
  const swapTotal = get('SwapTotal')
  const swapFree = get('SwapFree')
  const toMb = (kb: number): number => Math.round(kb / 1024)
  return {
    ram: { used: toMb(total - available), total: toMb(total) },
    swap: { used: toMb(swapTotal - swapFree), total: toMb(swapTotal) }
  }
}

/** Cumulative byte counters per non-loopback interface. */
function parseNetDev(text: string): { name: string; rx: number; tx: number }[] {
  const ifaces: { name: string; rx: number; tx: number }[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([\w.-]+):\s*(.*)$/)
    if (!m) continue
    if (m[1] === 'lo') continue
    const cols = m[2].trim().split(/\s+/).map(Number)
    ifaces.push({ name: m[1], rx: cols[0] || 0, tx: cols[8] || 0 })
  }
  return ifaces
}

function parseDf(text: string): DiskUsage[] {
  const disks: DiskUsage[] = []
  const lines = text.trim().split('\n')
  for (const line of lines) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6 || cols[0] === 'Filesystem') continue
    const size = parseInt(cols[1], 10)
    const used = parseInt(cols[2], 10)
    const avail = parseInt(cols[3], 10)
    const usePct = parseInt(cols[4], 10)
    const mount = cols.slice(5).join(' ')
    if (!Number.isFinite(size) || size <= 0) continue
    disks.push({
      mount,
      used,
      avail: Number.isFinite(avail) ? avail : 0,
      size,
      usePct: Number.isFinite(usePct) ? usePct : 0
    })
  }
  return disks
}

function parseProcs(text: string): ProcInfo[] {
  const procs: ProcInfo[] = []
  for (const line of text.trim().split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4 || cols[0] === 'PID') continue
    const pid = parseInt(cols[0], 10)
    if (!Number.isFinite(pid)) continue
    procs.push({
      pid,
      cpu: parseFloat(cols[1]) || 0,
      rss: parseInt(cols[2], 10) || 0, // KB
      cmd: cols.slice(3).join(' ')
    })
  }
  return procs
}

function parseSysInfo(out: string): SysInfo {
  const s = splitSections(out)
  const line = (v?: string): string => (v || '').trim().split('\n')[0]?.trim() ?? ''
  return {
    hostname: line(s.HOST),
    os: line(s.OS),
    kernel: line(s.KERNEL),
    cpuModel: line(s.CPU),
    cores: parseInt(line(s.CORES), 10) || 0
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}
function round1(n: number): number {
  return Math.round(n * 10) / 10
}
