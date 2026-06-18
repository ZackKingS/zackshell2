import { useEffect, useRef, useState } from 'react'
import type { MonitorSnapshot } from '@shared/types'

interface Props {
  sessionId: string
}

const HISTORY = 40

export default function Monitor({ sessionId }: Props): JSX.Element {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null)
  const cpuHist = useRef<number[]>([])
  const [, force] = useState(0)

  useEffect(() => {
    return window.api.onMonitorData((e) => {
      if (e.id !== sessionId) return
      setSnap(e.snapshot)
      const h = cpuHist.current
      h.push(e.snapshot.cpu)
      if (h.length > HISTORY) h.shift()
      force((n) => n + 1)
    })
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

  return (
    <div className="monitor">
      <div className="m-section sysinfo">
        <Row label="IP" value={snap.ip || '—'} />
        <Row label="运行" value={formatUptime(snap.uptimeSec)} />
        <Row label="负载" value={snap.load.map((n) => n.toFixed(2)).join(', ')} />
      </div>

      <Gauge label="CPU" pct={snap.cpu} text={`${snap.cpu.toFixed(0)}%`} />
      <Sparkline values={cpuHist.current} />

      <Gauge
        label="内存"
        pct={memPct}
        text={`${snap.mem.used}M / ${snap.mem.total}M`}
        color="#e0a458"
      />
      <Gauge
        label="交换"
        pct={swapPct}
        text={`${snap.swap.used}M / ${snap.swap.total}M`}
        color="#9a7bd0"
      />

      <div className="m-section net">
        <div className="net-row">
          <span className="up">↑ {formatRate(snap.net.tx)}</span>
          <span className="down">↓ {formatRate(snap.net.rx)}</span>
        </div>
      </div>

      <div className="m-section">
        <div className="m-title">进程 (内存占用)</div>
        <table className="proc-table">
          <tbody>
            {snap.procs.slice(0, 6).map((p) => (
              <tr key={p.pid}>
                <td className="proc-cmd" title={p.cmd}>
                  {p.cmd}
                </td>
                <td className="proc-num">{p.mem.toFixed(1)}%</td>
                <td className="proc-num">{p.cpu.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="m-section">
        <div className="m-title">磁盘</div>
        {snap.disks.slice(0, 6).map((d) => (
          <div key={d.mount} className="disk-row">
            <div className="disk-head">
              <span className="disk-mount">{d.mount}</span>
              <span className="disk-size">
                {formatKb(d.used)} / {formatKb(d.size)}
              </span>
            </div>
            <div className="bar mini">
              <div className="bar-fill" style={{ width: `${d.usePct}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  )
}

function Gauge({
  label,
  pct,
  text,
  color = '#4a9d6f'
}: {
  label: string
  pct: number
  text: string
  color?: string
}): JSX.Element {
  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="gauge-label">{label}</span>
        <span className="gauge-text">{text}</span>
      </div>
      <div className="bar">
        <div
          className="bar-fill"
          style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, background: color }}
        />
      </div>
    </div>
  )
}

function Sparkline({ values }: { values: number[] }): JSX.Element {
  const w = 220
  const h = 36
  if (values.length < 2) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} />
  const step = w / (HISTORY - 1)
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (Math.min(v, 100) / 100) * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="#4a9d6f" strokeWidth="1.5" />
    </svg>
  )
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
}

function formatKb(kb: number): string {
  if (kb < 1024) return `${kb}K`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)}M`
  return `${(kb / 1024 / 1024).toFixed(1)}G`
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const hrs = Math.floor((sec % 86400) / 3600)
  const min = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}天 ${hrs}时`
  if (hrs > 0) return `${hrs}时 ${min}分`
  return `${min}分`
}
