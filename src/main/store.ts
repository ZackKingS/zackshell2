import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import type { HostInput, HostMeta } from '@shared/types'

/** On-disk shape. Secrets are base64 of safeStorage-encrypted bytes. */
interface StoredHost {
  id: string
  name: string
  group: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  encPassword?: string
  privateKeyPath?: string
  encPassphrase?: string
}

/** Host with decrypted secrets — only ever lives in the main process. */
export interface FullHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

const filePath = join(app.getPath('userData'), 'hosts.json')

function encrypt(value?: string): string | undefined {
  if (!value) return undefined
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  // Fallback when no OS keyring is available — obfuscation only, not secure.
  return 'b64:' + Buffer.from(value, 'utf8').toString('base64')
}

function decrypt(stored?: string): string | undefined {
  if (!stored) return undefined
  if (stored.startsWith('b64:')) {
    return Buffer.from(stored.slice(4), 'utf8').toString('utf8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return undefined
  }
}

function load(): StoredHost[] {
  if (!existsSync(filePath)) return []
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as StoredHost[]
  } catch {
    return []
  }
}

function persist(hosts: StoredHost[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(filePath, JSON.stringify(hosts, null, 2), 'utf8')
}

function toMeta(h: StoredHost): HostMeta {
  return {
    id: h.id,
    name: h.name,
    group: h.group,
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.authType,
    hasPassword: !!h.encPassword,
    privateKeyPath: h.privateKeyPath ?? '',
    hasPassphrase: !!h.encPassphrase
  }
}

export const hostStore = {
  list(): HostMeta[] {
    return load().map(toMeta)
  },

  save(input: HostInput): HostMeta {
    const hosts = load()
    const existing = input.id ? hosts.find((h) => h.id === input.id) : undefined

    const record: StoredHost = {
      id: existing?.id ?? randomUUID(),
      name: input.name,
      group: input.group || 'default',
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      // undefined password means "keep existing"; a provided string overwrites.
      encPassword: input.password !== undefined ? encrypt(input.password) : existing?.encPassword,
      privateKeyPath: input.privateKeyPath ?? existing?.privateKeyPath,
      encPassphrase:
        input.passphrase !== undefined ? encrypt(input.passphrase) : existing?.encPassphrase
    }

    const next = existing
      ? hosts.map((h) => (h.id === record.id ? record : h))
      : [...hosts, record]
    persist(next)
    return toMeta(record)
  },

  remove(id: string): void {
    persist(load().filter((h) => h.id !== id))
  },

  /** Full host with decrypted secrets, for establishing a connection. */
  getForConnect(id: string): FullHost | undefined {
    const h = load().find((x) => x.id === id)
    if (!h) return undefined
    return {
      id: h.id,
      name: h.name,
      host: h.host,
      port: h.port,
      username: h.username,
      authType: h.authType,
      password: decrypt(h.encPassword),
      privateKeyPath: h.privateKeyPath,
      passphrase: decrypt(h.encPassphrase)
    }
  }
}
