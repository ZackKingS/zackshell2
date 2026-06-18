import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostMeta, SessionStatus } from '@shared/types'
import Sidebar from './components/Sidebar'
import HostForm from './components/HostForm'
import TerminalView from './components/Terminal'
import Monitor from './components/Monitor'
import SftpPanel from './components/SftpPanel'

interface Tab {
  sessionId: string
  hostId: string
  name: string
}

function newSessionId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

const MIN_TERM_H = 80   // px
const MIN_SFTP_H = 100  // px

export default function App(): JSX.Element {
  const [hosts, setHosts] = useState<HostMeta[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, SessionStatus>>({})
  const [editing, setEditing] = useState<HostMeta | 'new' | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Split ratio: terminal height fraction (0-1)
  const [splitFrac, setSplitFrac] = useState(0.55)
  const dragging = useRef(false)
  const splitAreaRef = useRef<HTMLDivElement>(null)

  const refreshHosts = useCallback(async () => {
    setHosts(await window.api.hosts.list())
  }, [])

  useEffect(() => {
    refreshHosts()
    return window.api.onSessionStatus((e) => {
      setStatus((prev) => ({ ...prev, [e.id]: e.status }))
    })
  }, [refreshHosts])

  const connect = useCallback((host: HostMeta) => {
    const sessionId = newSessionId()
    setTabs((prev) => [...prev, { sessionId, hostId: host.id, name: host.name }])
    setActiveId(sessionId)
    window.api.session.open(sessionId, host.id)
  }, [])

  const closeTab = useCallback((sessionId: string) => {
    window.api.session.close(sessionId)
    setTabs((prev) => {
      const next = prev.filter((t) => t.sessionId !== sessionId)
      setActiveId((cur) =>
        cur === sessionId ? next[next.length - 1]?.sessionId ?? null : cur
      )
      return next
    })
  }, [])

  const saveHost = useCallback(
    async (input: Parameters<typeof window.api.hosts.save>[0]) => {
      await window.api.hosts.save(input)
      setEditing(null)
      refreshHosts()
    },
    [refreshHosts]
  )

  const deleteHost = useCallback(async (id: string) => {
    await window.api.hosts.delete(id)
    refreshHosts()
  }, [refreshHosts])

  // ---- drag-to-resize ----
  const onDividerMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (me: MouseEvent): void => {
      if (!dragging.current || !splitAreaRef.current) return
      const rect = splitAreaRef.current.getBoundingClientRect()
      const totalH = rect.height
      const rawFrac = (me.clientY - rect.top) / totalH
      // clamp so both panes stay usable
      const minFrac = MIN_TERM_H / totalH
      const maxFrac = 1 - MIN_SFTP_H / totalH
      setSplitFrac(Math.min(Math.max(rawFrac, minFrac), maxFrac))
    }
    const onUp = (): void => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar
          hosts={hosts}
          onConnect={connect}
          onAdd={() => setEditing('new')}
          onEdit={(h) => setEditing(h)}
          onDelete={deleteHost}
        />
      )}

      <div className="workspace">
        {/* Tab bar */}
        <div className="tabbar">
          <button
            className="icon-btn"
            title={sidebarOpen ? '隐藏主机列表' : '显示主机列表'}
            onClick={() => setSidebarOpen((v) => !v)}
          >☰</button>
          {tabs.map((t) => (
            <div
              key={t.sessionId}
              className={'tab' + (t.sessionId === activeId ? ' active' : '')}
              onClick={() => setActiveId(t.sessionId)}
            >
              <span className={'dot ' + (status[t.sessionId] ?? 'connecting')} />
              <span className="tab-name">{t.name}</span>
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.sessionId) }}>×</span>
            </div>
          ))}
        </div>

        {/* Main content */}
        <div className="session-area">
          {tabs.length === 0 && (
            <div className="empty-state">
              <h2>zack-shell</h2>
              <p>从左侧选择一台主机连接，或点击「+ 新建主机」。</p>
            </div>
          )}

          {tabs.map((t) => {
            const connected = status[t.sessionId] === 'connected'
            const isActive = t.sessionId === activeId
            return (
              <div
                key={t.sessionId}
                className="session-view"
                style={{ display: isActive ? 'flex' : 'none' }}
              >
                {/* Left monitor panel */}
                <Monitor sessionId={t.sessionId} />

                {/* Right: terminal + sftp split */}
                <div className="split-area" ref={isActive ? splitAreaRef : undefined}>
                  {/* Terminal pane */}
                  <div
                    className="split-term"
                    style={{ flex: `0 0 ${(splitFrac * 100).toFixed(2)}%` }}
                  >
                    <TerminalView sessionId={t.sessionId} active={isActive} />
                  </div>

                  {/* Divider */}
                  <div className="split-divider" onMouseDown={onDividerMouseDown}>
                    <div className="split-divider-grip" />
                  </div>

                  {/* SFTP pane */}
                  <div className="split-sftp">
                    {connected
                      ? <SftpPanel sessionId={t.sessionId} />
                      : (
                        <div className="sftp-waiting">
                          <span>SSH 连接成功后自动加载文件管理器</span>
                        </div>
                      )
                    }
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {editing && (
        <HostForm
          host={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={saveHost}
        />
      )}
    </div>
  )
}
