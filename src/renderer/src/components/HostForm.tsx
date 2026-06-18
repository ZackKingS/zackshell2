import { useState } from 'react'
import type { AuthType, HostInput, HostMeta } from '@shared/types'

interface Props {
  host: HostMeta | null
  onCancel: () => void
  onSave: (input: HostInput) => void
}

export default function HostForm({ host, onCancel, onSave }: Props): JSX.Element {
  const isEdit = !!host
  const [name, setName] = useState(host?.name ?? '')
  const [group, setGroup] = useState(host?.group ?? 'default')
  const [hostAddr, setHostAddr] = useState(host?.host ?? '')
  const [port, setPort] = useState(host?.port ?? 22)
  const [username, setUsername] = useState(host?.username ?? 'root')
  const [authType, setAuthType] = useState<AuthType>(host?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [privateKeyPath, setPrivateKeyPath] = useState(host?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!name.trim() || !hostAddr.trim()) return
    const payload: HostInput = {
      id: host?.id,
      name: name.trim(),
      group: group.trim() || 'default',
      host: hostAddr.trim(),
      port: Number(port) || 22,
      username: username.trim() || 'root',
      authType
    }
    if (authType === 'password') {
      if (!isEdit || password !== '') payload.password = password
    } else {
      payload.privateKeyPath = privateKeyPath.trim()
      if (!isEdit || passphrase !== '') payload.passphrase = passphrase
    }
    onSave(payload)
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{isEdit ? '编辑主机' : '新建主机'}</h3>

        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label>
          分组
          <input value={group} onChange={(e) => setGroup(e.target.value)} />
        </label>
        <div className="row">
          <label className="grow">
            主机地址
            <input
              value={hostAddr}
              onChange={(e) => setHostAddr(e.target.value)}
              placeholder="例如 192.168.1.10"
            />
          </label>
          <label className="port">
            端口
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
        </div>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>

        <label>
          认证方式
          <select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
            <option value="password">密码</option>
            <option value="key">私钥</option>
          </select>
        </label>

        {authType === 'password' ? (
          <label>
            密码
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isEdit && host?.hasPassword ? '留空表示不修改' : ''}
              />
              <button
                type="button"
                className="input-action-btn"
                onClick={() => setShowPassword((v) => !v)}
                title={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
        ) : (
          <>
            <label>
              私钥文件路径
              <input
                value={privateKeyPath}
                onChange={(e) => setPrivateKeyPath(e.target.value)}
                placeholder="例如 C:\\Users\\me\\.ssh\\id_rsa"
              />
            </label>
            <label>
              私钥口令（可选）
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={isEdit && host?.hasPassphrase ? '留空表示不修改' : ''}
              />
            </label>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn-primary">
            保存
          </button>
        </div>
      </form>
    </div>
  )
}
