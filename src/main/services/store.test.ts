import { vi, describe, it, expect, afterAll } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

// Mock Electron modules BEFORE importing the store
vi.mock('electron', () => {
  const testPath = join(__dirname, 'test-userdata')
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return testPath
        return './tmp'
      }
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (str: string) => Buffer.from('enc:' + str),
      decryptString: (buf: Buffer) => buf.toString().replace('enc:', '')
    }
  }
})

import { hostStore } from '../store'
import type { HostInput } from '@shared/types'

describe('store - hostStore', () => {
  const testDir = join(__dirname, 'test-userdata')

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('should save a new host and read it back without plain secrets', () => {
    const input: HostInput = {
      name: 'Test Server',
      group: 'production',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'mypassword'
    }

    const saved = hostStore.save(input)
    expect(saved.id).toBeDefined()
    expect(saved.name).toBe('Test Server')
    expect(saved.hasPassword).toBe(true)

    // Check list
    const list = hostStore.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(saved.id)
    expect((list[0] as any).password).toBeUndefined()

    // Get for connect
    const full = hostStore.getForConnect(saved.id)
    expect(full).toBeDefined()
    expect(full?.password).toBe('mypassword')
    expect(full?.username).toBe('root')
  })

  it('should update host details and preserve password if not updated', () => {
    const list = hostStore.list()
    const original = list[0]
    expect(original).toBeDefined()

    const updateInput: HostInput = {
      id: original.id,
      name: 'Updated Server Name',
      group: 'production',
      host: '1.2.3.4',
      port: 2222,
      username: 'root',
      authType: 'password'
    }

    const updated = hostStore.save(updateInput)
    expect(updated.name).toBe('Updated Server Name')
    expect(updated.port).toBe(2222)
    expect(updated.hasPassword).toBe(true)

    const full = hostStore.getForConnect(original.id)
    expect(full?.password).toBe('mypassword')
  })

  it('should overwrite password if a new password is provided', () => {
    const list = hostStore.list()
    const original = list[0]

    const updateInput: HostInput = {
      id: original.id,
      name: 'Updated Server Name',
      group: 'production',
      host: '1.2.3.4',
      port: 2222,
      username: 'root',
      authType: 'password',
      password: 'newsecretpassword'
    }

    hostStore.save(updateInput)
    const full = hostStore.getForConnect(original.id)
    expect(full?.password).toBe('newsecretpassword')
  })

  it('should delete a host configuration successfully', () => {
    const listBefore = hostStore.list()
    expect(listBefore).toHaveLength(1)
    const id = listBefore[0].id

    hostStore.remove(id)
    const listAfter = hostStore.list()
    expect(listAfter).toHaveLength(0)

    const full = hostStore.getForConnect(id)
    expect(full).toBeUndefined()
  })
})
