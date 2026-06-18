import { useCallback, useEffect, useState } from 'react'
import type { HostMeta, SessionStatus } from '@shared/types'
import Sidebar from './components/Sidebar'
import HostForm from './components/HostForm'
import TerminalView from './components/Terminal'
import Monitor from './components/Monitor'

interface Tab {
  sessionId: string
  hostId: string
  name: string
}

// crypto.randomUUID() only exists in secure contexts; the dev server runs on a
// plain-http LAN IP, so generate a session id without it.
function newSessionId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

export default function App(): JSX.Element {
  const [hosts, setHosts] = useState<HostMeta[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, SessionStatus>>({})
  const [editing, setEditing] = useState<HostMeta | 'new' | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

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
    // Open after the tab (and its subscribers) are registered; the SSH handshake
    // takes far longer than this render, so no terminal output is missed.
    window.api.session.open(sessionId, host.id)
  }, [])

  const closeTab = useCallback(
    (sessionId: string) => {
      window.api.session.close(sessionId)
      setTabs((prev) => {
        const next = prev.filter((t) => t.sessionId !== sessionId)
        setActiveId((cur) =>
          cur === sessionId ? next[next.length - 1]?.sessionId ?? null : cur
        )
        return next
      })
    },
    []
  )

  const saveHost = useCallback(
    async (input: Parameters<typeof window.api.hosts.save>[0]) => {
      await window.api.hosts.save(input)
      setEditing(null)
      refreshHosts()
    },
    [refreshHosts]
  )

  const deleteHost = useCallback(
    async (id: string) => {
      await window.api.hosts.delete(id)
      refreshHosts()
    },
    [refreshHosts]
  )

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
        <div className="tabbar">
          <button
            className="icon-btn"
            title={sidebarOpen ? '隐藏主机列表' : '显示主机列表'}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>
          {tabs.map((t) => (
            <div
              key={t.sessionId}
              className={'tab' + (t.sessionId === activeId ? ' active' : '')}
              onClick={() => setActiveId(t.sessionId)}
            >
              <span className={'dot ' + (status[t.sessionId] ?? 'connecting')} />
              <span className="tab-name">{t.name}</span>
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.sessionId)
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>

        <div className="session-area">
          {tabs.length === 0 && (
            <div className="empty-state">
              <h2>zack-shell</h2>
              <p>从左侧选择一台主机连接，或点击「+ 新建主机」。</p>
            </div>
          )}
          {tabs.map((t) => (
            <div
              key={t.sessionId}
              className="session-view"
              style={{ display: t.sessionId === activeId ? 'flex' : 'none' }}
            >
              <Monitor sessionId={t.sessionId} />
              <TerminalView sessionId={t.sessionId} active={t.sessionId === activeId} />
            </div>
          ))}
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
