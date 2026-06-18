import { useState, useEffect, useCallback, useRef } from 'react'
import type { SftpEntry, SftpProgressEvent } from '@shared/types'

interface Props {
  sessionId: string
}

// ---- helpers ----
function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function fmtTime(unix: number): string {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function permStr(mode: number): string {
  const t = (mode & 0o040000) ? 'd' : (mode & 0o120000) ? 'l' : '-'
  const bits = 'rwxrwxrwx'
  let s = t
  for (let i = 8; i >= 0; i--) s += (mode >> i) & 1 ? bits[8 - i] : '-'
  return s
}

function joinPath(base: string, name: string): string {
  return base === '/' ? '/' + name : base.replace(/\/+$/, '') + '/' + name
}
function parentPath(p: string): string {
  if (p === '/') return '/'
  const parts = p.replace(/\/+$/, '').split('/')
  parts.pop()
  return parts.join('/') || '/'
}

interface TreeNode {
  name: string
  path: string
  open: boolean
  children?: TreeNode[]
}

interface Transfer {
  id: string; direction: 'upload' | 'download'
  filename: string; transferred: number; total: number; done: boolean; error?: string
}

// ---- component ----
export default function SftpPanel({ sessionId }: Props): JSX.Element {
  const [cwd, setCwd] = useState('/')
  const [isDragOver, setIsDragOver] = useState(false)
  const cwdRef = useRef(cwd)
  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [treeRoots, setTreeRoots] = useState<TreeNode[]>([{ name: '/', path: '/', open: true }])
  const renameInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (path: string) => {
    setLoading(true); setError(null); setSelected(null)
    const res = await window.api.sftp.list(sessionId, path)
    setLoading(false)
    if (!res.ok) { setError(res.error ?? 'Unknown error'); return }
    const sorted = [...(res.entries ?? [])].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.filename.localeCompare(b.filename)
    })
    setEntries(sorted)
    setCwd(path)
  }, [sessionId])

  useEffect(() => {
    refresh('/')
    const unsub = window.api.onSftpProgress((e: SftpProgressEvent) => {
      if (e.sessionId !== sessionId) return
      setTransfers((prev) => {
        const idx = prev.findIndex((t) => t.id === e.transferId)
        const item: Transfer = { id: e.transferId, direction: e.direction, filename: e.filename, transferred: e.transferred, total: e.total, done: e.done, error: e.error }
        if (idx >= 0) { const n = [...prev]; n[idx] = item; return n }
        return [...prev, item]
      })
      if (e.done && e.direction === 'upload' && !e.error) {
        refresh(cwdRef.current)
      }
    })
    return unsub
  }, [sessionId, refresh])

  useEffect(() => {
    if (renaming) setTimeout(() => renameInputRef.current?.select(), 40)
  }, [renaming])

  // ---- tree helpers ----
  const loadTreeChildren = async (node: TreeNode): Promise<TreeNode[]> => {
    const res = await window.api.sftp.list(sessionId, node.path)
    if (!res.ok) return []
    return (res.entries ?? [])
      .filter((e) => e.isDir && !e.filename.startsWith('.'))
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map((e) => ({ name: e.filename, path: joinPath(node.path, e.filename), open: false }))
  }

  const toggleTree = async (node: TreeNode, roots: TreeNode[]): Promise<TreeNode[]> => {
    return await Promise.all(roots.map(async (n) => {
      if (n.path === node.path) {
        if (n.open) return { ...n, open: false }
        const children = n.children ?? await loadTreeChildren(n)
        return { ...n, open: true, children }
      }
      if (n.children) return { ...n, children: await toggleTree(node, n.children) }
      return n
    }))
  }

  const handleTreeClick = async (node: TreeNode): Promise<void> => {
    refresh(node.path)
    const next = await toggleTree(node, treeRoots)
    setTreeRoots(next)
  }

  // ---- file actions ----
  const handleMkdir = async (): Promise<void> => {
    const name = prompt('新建文件夹名称:')
    if (!name) return
    const res = await window.api.sftp.mkdir(sessionId, joinPath(cwd, name))
    if (!res.ok) { alert('创建失败: ' + res.error); return }
    refresh(cwd)
  }

  const handleRename = async (): Promise<void> => {
    if (!renaming || !renameVal.trim()) { setRenaming(null); return }
    const res = await window.api.sftp.rename(sessionId, joinPath(cwd, renaming), joinPath(cwd, renameVal.trim()))
    setRenaming(null)
    if (!res.ok) { alert('重命名失败: ' + res.error); return }
    refresh(cwd)
  }

  const handleDelete = async (entry: SftpEntry): Promise<void> => {
    if (!confirm(`确定删除 "${entry.filename}"？`)) return
    const res = await window.api.sftp.remove(sessionId, joinPath(cwd, entry.filename), entry.isDir)
    if (!res.ok) { alert('删除失败: ' + res.error); return }
    refresh(cwd)
  }

  const handleDownload = async (entry: SftpEntry): Promise<void> => {
    if (entry.isDir) { alert('暂不支持下载文件夹'); return }
    const localPath = prompt('保存到本地路径（含文件名）:', entry.filename)
    if (!localPath) return
    const transferId = Date.now().toString(36) + Math.random().toString(36).slice(2)
    await window.api.sftp.download(sessionId, transferId, joinPath(cwd, entry.filename), localPath)
  }

  const handleUpload = async (): Promise<void> => {
    const localPath = prompt('本地文件路径:')
    if (!localPath) return
    const filename = localPath.replace(/\\/g, '/').split('/').pop() ?? 'upload'
    const transferId = Date.now().toString(36) + Math.random().toString(36).slice(2)
    await window.api.sftp.upload(sessionId, transferId, localPath, joinPath(cwd, filename))
  }

  // ---- drag & drop ----
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragOver) {
      setIsDragOver(true)
      window.api.sftp.log('INFO', 'Frontend: Drag over/enter SftpPanel')
    }
  }, [isDragOver])
 
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setIsDragOver(false)
      window.api.sftp.log('INFO', 'Frontend: Drag leave SftpPanel')
    }
  }, [])
 
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
 
    const files = e.dataTransfer.files
    window.api.sftp.log('INFO', `Frontend: File drop event. Files count: ${files ? files.length : 0}`)
    if (!files || files.length === 0) return
 
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const localPath = window.api.sftp.getPathForFile(file)
      const filename = file.name
      window.api.sftp.log('INFO', `Frontend: File item ${i} - name: ${filename}, path: ${localPath}, size: ${file.size}`)
      
      if (!localPath) {
        window.api.sftp.log('WARN', `Frontend: File path is empty for file: ${filename}`)
        continue
      }
 
      const transferId = Date.now().toString(36) + Math.random().toString(36).slice(2)
      await window.api.sftp.upload(sessionId, transferId, localPath, joinPath(cwd, filename))
    }
  }, [sessionId, cwd])
 
  // ---- tree render ----
  const renderTree = (nodes: TreeNode[], depth = 0): JSX.Element[] =>
    nodes.flatMap((node) => [
      <div
        key={node.path}
        className={'sftp-tree-row' + (node.path === cwd ? ' active' : '')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => handleTreeClick(node)}
      >
        <span className="sftp-tree-caret">{node.open ? '▾' : '▸'}</span>
        <span className="sftp-tree-icon">📁</span>
        <span className="sftp-tree-name">{node.name}</span>
      </div>,
      ...(node.open && node.children ? renderTree(node.children, depth + 1) : [])
    ])

  const activeTransfers = transfers.filter((t) => !t.done)
  const doneTransfers   = transfers.filter((t) => t.done)

  return (
    <div className="sftp-panel">
      {/* Top toolbar */}
      <div className="sftp-toolbar">
        {/* Path bar */}
        <button className="sftp-tb-btn" title="上级目录" onClick={() => refresh(parentPath(cwd))} disabled={cwd === '/'}>↑</button>
        <button className="sftp-tb-btn" title="刷新" onClick={() => refresh(cwd)}>↻</button>
        <div className="sftp-pathbar">
          <span className="sftp-pathbar-label">{cwd}</span>
        </div>
        <button className="sftp-tb-btn" title="新建文件夹" onClick={handleMkdir}>+ 目录</button>
        <button className="sftp-tb-btn sftp-tb-upload" title="上传文件" onClick={handleUpload}>↑ 上传</button>
      </div>

      {/* Body: tree + file list */}
      <div className="sftp-body">
        {/* Directory tree */}
        <div className="sftp-tree">
          {renderTree(treeRoots)}
        </div>

        {/* Divider */}
        <div className="sftp-tree-divider" />

        {/* File list */}
        <div
          className={`sftp-files${isDragOver ? ' drag-over' : ''}`}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragOver && (
            <div className="sftp-drag-overlay">
              <div className="sftp-drag-overlay-box">
                <span className="sftp-drag-icon">📤</span>
                <span className="sftp-drag-text">拖放文件或文件夹到此处上传</span>
              </div>
            </div>
          )}
          {loading && <div className="sftp-msg">加载中…</div>}
          {error   && <div className="sftp-msg sftp-msg-err">错误: {error}</div>}
          {!loading && !error && (
            <table className="sftp-table">
              <colgroup>
                <col style={{ minWidth: 180 }} />
                <col style={{ width: 72 }} />
                <col style={{ width: 68 }} />
                <col style={{ width: 148 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 100 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>文件名</th>
                  <th className="r">大小</th>
                  <th>类型</th>
                  <th className="r">修改时间</th>
                  <th>权限</th>
                  <th>用户/用户组</th>
                </tr>
              </thead>
              <tbody>
                {cwd !== '/' && (
                  <tr className="sftp-row" onClick={() => refresh(parentPath(cwd))}>
                    <td colSpan={6} className="sftp-dotdot"><span className="sftp-fi">📁</span>..</td>
                  </tr>
                )}
                {entries.map((e) => (
                  <tr
                    key={e.filename}
                    className={'sftp-row' + (selected === e.filename ? ' sftp-sel' : '')}
                    onClick={() => setSelected(e.filename)}
                    onDoubleClick={() => { if (e.isDir) refresh(joinPath(cwd, e.filename)) }}
                    onContextMenu={(ev) => { ev.preventDefault(); setSelected(e.filename) }}
                  >
                    <td className="sftp-col-name">
                      <span className="sftp-fi">{e.isDir ? '📁' : '📄'}</span>
                      {renaming === e.filename ? (
                        <input
                          ref={renameInputRef}
                          className="sftp-rename-inp"
                          value={renameVal}
                          onChange={(ev) => setRenameVal(ev.target.value)}
                          onKeyDown={(ev) => { if (ev.key === 'Enter') handleRename(); if (ev.key === 'Escape') setRenaming(null) }}
                          onBlur={handleRename}
                          onClick={(ev) => ev.stopPropagation()}
                        />
                      ) : <span>{e.filename}</span>}
                    </td>
                    <td className="r sftp-dim">{e.isDir ? '' : fmtSize(e.size)}</td>
                    <td className="sftp-dim">{e.isDir ? '文件夹' : (e.filename.includes('.') ? e.filename.split('.').pop()!.toUpperCase() + ' 文件' : 'File')}</td>
                    <td className="r sftp-dim">{fmtTime(e.modTime)}</td>
                    <td className="sftp-perm">{permStr(e.permissions)}</td>
                    <td className="sftp-dim">root/root</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Context action bar (shown when a file is selected) */}
      {selected && (() => {
        const entry = entries.find((e) => e.filename === selected)
        if (!entry) return null
        return (
          <div className="sftp-actionbar">
            <span className="sftp-ab-name">{entry.filename}</span>
            <button className="sftp-ab-btn" onClick={() => { setRenameVal(entry.filename); setRenaming(entry.filename) }}>✎ 重命名</button>
            {!entry.isDir && <button className="sftp-ab-btn" onClick={() => handleDownload(entry)}>↓ 下载</button>}
            <button className="sftp-ab-btn sftp-ab-danger" onClick={() => handleDelete(entry)}>✕ 删除</button>
            <button className="sftp-ab-close" onClick={() => setSelected(null)}>×</button>
          </div>
        )
      })()}

      {/* Transfer progress bar */}
      {activeTransfers.length > 0 && (
        <div className="sftp-prog-bar">
          {activeTransfers.map((t) => (
            <div key={t.id} className="sftp-prog-item">
              <span className="sftp-prog-icon">{t.direction === 'upload' ? '↑' : '↓'}</span>
              <span className="sftp-prog-name">{t.filename}</span>
              <div className="sftp-prog-track">
                <div className="sftp-prog-fill" style={{ width: t.total > 0 ? Math.round(t.transferred / t.total * 100) + '%' : '0%' }} />
              </div>
              <span className="sftp-prog-pct">{t.total > 0 ? Math.round(t.transferred / t.total * 100) + '%' : '…'}</span>
            </div>
          ))}
          {doneTransfers.length > 0 && (
            <button className="sftp-prog-clear" onClick={() => setTransfers((p) => p.filter((t) => !t.done))}>清除 {doneTransfers.length} 已完成</button>
          )}
        </div>
      )}
    </div>
  )
}
