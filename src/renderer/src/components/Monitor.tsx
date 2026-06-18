import { useEffect, useRef, useState } from 'react'
import type { MonitorSnapshot, NetIf, SysInfo } from '@shared/types'

interface Props {
  sessionId: string
}

const HISTORY = 50

export default function Monitor({ sessionId }: Props): JSX.Element {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null)
  const [sysInfo, setSysInfo] = useState<SysInfo | null>(null)
  const [selectedIf, setSelectedIf] = useState('')
  const [showSys, setShowSys] = useState(false)
  const selRef = useRef('')
  const netHist = useRef<number[]>([])
  const rttHist = useRef<number[]>([])

  useEffect(() => {
    const off1 = window.api.onMonitorData((e) => {
      if (e.id !== sessionId) return
      const act = pickIf(e.snapshot.interfaces, selRef.current)
      push(netHist.current, act ? act.rx + act.tx : 0)
      push(rttHist.current, e.snapshot.rttMs)
      setSnap(e.snapshot)
    })
    const off2 = window.api.onMonitorSysInfo((e) => {
      if (e.id === sessionId) setSysInfo(e.info)
    })
    return () => {
      off1()
      off2()
    }
  }, [sessionId])

  if (!snap) {
    return (
      <div className="monitor">
        <div className="monitor-empty">采集中…</div>
      </div>
    )
  }

  const memPct = snap.mem.total ? (snap.mem.used / snap.mem.total) * 100 : 0
  const swapPct = snap.swap.total ? (snap.swap.used / snap.swap.total) * 100 : 0
  const ifaces = snap.interfaces
  const act = pickIf(ifaces, selectedIf)

  const changeIf = (name: string): void => {
    setSelectedIf(name)
    selRef.current = name
    netHist.current = []
  }

  return (
    <div className="monitor">
      {showSys && (
        <SysInfoModal info={sysInfo} snap={snap} onClose={() => setShowSys(false)} />
      )}

      <div className="fs-ip">
        <span>
          IP <b>{snap.ip || '—'}</b>
        </span>
        <a className="fs-copy" onClick={() => copyText(snap.ip)}>
          复制
        </a>
      </div>

      <button className="fs-sysbtn" onClick={() => setShowSys(true)}>
        系统信息
      </button>

      <div className="fs-meta">
        <div>运行 {fmtUptime(snap.uptimeSec)}</div>
        <div>负载 {snap.load.map((n) => n.toFixed(2)).join(', ')}</div>
      </div>

      <Gauge label="CPU" pct={snap.cpu} color="#7ec97e" value={`${snap.cpu.toFixed(0)}%`} />
      <Gauge
        label="内存"
        pct={memPct}
        color="#f0a44f"
        overlay={`${memPct.toFixed(0)}%`}
        value={`${snap.mem.used}M/${snap.mem.total}M`}
      />
      <Gauge
        label="交换"
        pct={swapPct}
        color="#6fb1d6"
        overlay={`${swapPct.toFixed(0)}%`}
        value={`${snap.swap.used}M/${snap.swap.total}M`}
      />

      <table className="fs-proc">
        <thead>
          <tr>
            <th>内存</th>
            <th>CPU</th>
            <th>命令</th>
          </tr>
        </thead>
        <tbody>
          {snap.procs.slice(0, 5).map((p) => (
            <tr key={p.pid}>
              <td>{fmtRss(p.rss)}</td>
              <td>{p.cpu.toFixed(1)}</td>
              <td className="cmd" title={p.cmd}>
                {p.cmd}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="fs-net-head">
        <span className="up">↑{fmtNet(act ? act.tx : 0)}</span>
        <span className="down">↓{fmtNet(act ? act.rx : 0)}</span>
        <select value={act?.name ?? ''} onChange={(e) => changeIf(e.target.value)}>
          {ifaces.length === 0 && <option value="">—</option>}
          {ifaces.map((i) => (
            <option key={i.name} value={i.name}>
              {i.name}
            </option>
          ))}
        </select>
      </div>
      <BarGraph data={netHist.current} color="#d9b98a" fmt={fmtNet} />

      <div className="fs-ping-head">
        <span>{Math.round(snap.rttMs)}ms</span>
        <span className="muted">本机</span>
      </div>
      <LineGraph data={rttHist.current} color="#6fb1d6" fmt={(v) => `${Math.round(v)}`} />

      <table className="fs-disk">
        <thead>
          <tr>
            <th>路径</th>
            <th className="r">可用/大小</th>
          </tr>
        </thead>
        <tbody>
          {snap.disks.map((d) => (
            <tr key={d.mount}>
              <td className="mount" title={d.mount}>
                {d.mount}
              </td>
              <td className="r">
                <span className="size">
                  {fmtDisk(d.avail)}/{fmtDisk(d.size)}
                </span>
                <span className="usebar">
                  <span className="usefill" style={{ width: `${d.usePct}%` }} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- sub-components ----------

function Gauge({
  label,
  pct,
  color,
  value,
  overlay
}: {
  label: string
  pct: number
  color: string
  value: string
  overlay?: string
}): JSX.Element {
  return (
    <div className="fs-gauge">
      <span className="g-label">{label}</span>
      <div className="g-bar">
        <div className="g-fill" style={{ width: `${clamp(pct, 0, 100)}%`, background: color }} />
        {overlay != null && <span className="g-overlay">{overlay}</span>}
      </div>
      <span className="g-value">{value}</span>
    </div>
  )
}

function BarGraph({
  data,
  color,
  fmt
}: {
  data: number[]
  color: string
  fmt: (v: number) => string
}): JSX.Element {
  const W = 180
  const H = 58
  const max = Math.max(...data, 1)
  const bw = W / HISTORY
  return (
    <div className="fs-graph">
      <div className="fs-yaxis">
        <span>{fmt(max)}</span>
        <span>{fmt((max * 2) / 3)}</span>
        <span>{fmt(max / 3)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="fs-svg">
        {data.map((v, i) => {
          const h = (v / max) * H
          return (
            <rect
              key={i}
              x={i * bw}
              y={H - h}
              width={Math.max(bw - 0.6, 0.5)}
              height={h}
              fill={color}
            />
          )
        })}
      </svg>
    </div>
  )
}

function LineGraph({
  data,
  color,
  fmt
}: {
  data: number[]
  color: string
  fmt: (v: number) => string
}): JSX.Element {
  const W = 180
  const H = 42
  const max = Math.max(...data, 1)
  const step = W / Math.max(HISTORY - 1, 1)
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * H).toFixed(1)}`).join(' ')
  return (
    <div className="fs-graph">
      <div className="fs-yaxis">
        <span>{fmt(max)}</span>
        <span>{fmt(max / 2)}</span>
        <span>0</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="fs-svg">
        {data.length > 1 && <polyline points={pts} fill="none" stroke={color} strokeWidth="1" />}
      </svg>
    </div>
  )
}

function SysInfoModal({
  info,
  snap,
  onClose
}: {
  info: SysInfo | null
  snap: MonitorSnapshot
  onClose: () => void
}): JSX.Element {
  const rows: [string, string][] = [
    ['主机名', info?.hostname || '—'],
    ['操作系统', info?.os || '—'],
    ['内核', info?.kernel || '—'],
    ['CPU', info?.cpuModel || '—'],
    ['核心数', info ? String(info.cores) : '—'],
    ['IP', snap.ip || '—'],
    ['运行时间', fmtUptime(snap.uptimeSec)],
    ['负载', snap.load.map((n) => n.toFixed(2)).join(', ')],
    ['内存', `${snap.mem.used}M / ${snap.mem.total}M`]
  ]
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sysinfo-modal" onClick={(e) => e.stopPropagation()}>
        <h3>系统信息</h3>
        <table className="sysinfo-table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="k">{k}</td>
                <td className="v">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- helpers ----------

function pickIf(ifs: NetIf[], sel: string): NetIf | undefined {
  return ifs.find((i) => i.name === sel) || ifs.find((i) => i.name === 'eth0') || ifs[0]
}

function push(arr: number[], v: number): void {
  arr.push(v)
  if (arr.length > HISTORY) arr.shift()
}

function copyText(text: string): void {
  // navigator.clipboard needs a secure context; the dev server is plain-http on a
  // LAN IP, so use the execCommand fallback which works everywhere.
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta)
}

function fmtNet(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)}B`
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)}K`
  return `${(bps / 1024 / 1024).toFixed(1)}M`
}

function fmtRss(kb: number): string {
  if (!kb) return '0'
  if (kb < 1024) return `${kb}K`
  return `${(kb / 1024).toFixed(1)}M`
}

function fmtDisk(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`
  return `${kb}K`
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} 天`
  if (h > 0) return `${h} 时`
  return `${m} 分`
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}
