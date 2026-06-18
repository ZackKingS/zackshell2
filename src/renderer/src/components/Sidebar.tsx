import { useMemo, useState } from 'react'
import type { HostMeta } from '@shared/types'

interface Props {
  hosts: HostMeta[]
  onConnect: (host: HostMeta) => void
  onAdd: () => void
  onEdit: (host: HostMeta) => void
  onDelete: (id: string) => void
}

export default function Sidebar({ hosts, onConnect, onAdd, onEdit, onDelete }: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const map = new Map<string, HostMeta[]>()
    for (const h of hosts) {
      const g = h.group || 'default'
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(h)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [hosts])

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span>主机</span>
        <button className="add-btn" onClick={onAdd}>
          + 新建主机
        </button>
      </div>

      <div className="host-list">
        {hosts.length === 0 && <div className="hint">还没有主机，点击上方新建。</div>}
        {groups.map(([group, items]) => (
          <div key={group} className="host-group">
            <div
              className="group-head"
              onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
            >
              <span className="caret">{collapsed[group] ? '▸' : '▾'}</span>
              {group}
              <span className="group-count">{items.length}</span>
            </div>
            {!collapsed[group] &&
              items.map((h) => (
                <div
                  key={h.id}
                  className="host-row"
                  onDoubleClick={() => onConnect(h)}
                  title="双击连接"
                >
                  <div className="host-info">
                    <div className="host-name">{h.name}</div>
                    <div className="host-addr">
                      {h.username}@{h.host}:{h.port}
                    </div>
                  </div>
                  <div className="host-actions">
                    <button title="连接" onClick={() => onConnect(h)}>
                      ⏵
                    </button>
                    <button title="编辑" onClick={() => onEdit(h)}>
                      ✎
                    </button>
                    <button
                      title="删除"
                      onClick={() => {
                        if (confirm(`删除主机「${h.name}」？`)) onDelete(h.id)
                      }}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}
