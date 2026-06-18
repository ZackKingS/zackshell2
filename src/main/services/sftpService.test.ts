import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { sftpDownload, sftpUpload, sftpCancel, transferQueue } from './sftpService'

describe('sftpService - TransferQueue & Operations', () => {
  let mockClient: any
  let mockSession: any
  let progressEvents: any[]
  const sendSpy = (channel: string, payload: any) => {
    if (channel === 'sftp:progress') {
      progressEvents.push(payload)
    }
  }

  const testQueueDir = join(__dirname, 'test-queue-dir')
  const file1 = join(testQueueDir, 'file1.txt')
  const file2 = join(testQueueDir, 'file2.txt')
  const file3 = join(testQueueDir, 'file3.txt')
  const file4 = join(testQueueDir, 'file4.txt')

  beforeEach(() => {
    progressEvents = []
    ;(transferQueue as any).queue = []
    ;(transferQueue as any).activeCount = 0

    if (existsSync(testQueueDir)) {
      rmSync(testQueueDir, { recursive: true, force: true })
    }
    mkdirSync(testQueueDir)
    writeFileSync(file1, 'content 1')
    writeFileSync(file2, 'content 2')
    writeFileSync(file3, 'content 3')
    writeFileSync(file4, 'content 4')

    mockClient = {
      sftp: vi.fn((callback: (err: any, sftp: any) => void) => {
        const mockSftp = {
          fastPut: vi.fn((_local: string, _remote: string, options: any, cb: (err?: any) => void) => {
            setTimeout(() => {
              if (options?.step) {
                options.step(50, 50, 100)
              }
              setTimeout(() => cb(null), 500) // 500ms transfer time to prevent race conditions in queue verification
            }, 10)
          }),
          fastGet: vi.fn((_remote: string, _local: string, options: any, cb: (err?: any) => void) => {
            setTimeout(() => {
              if (options?.step) {
                options.step(50, 50, 100)
              }
              setTimeout(() => cb(null), 500)
            }, 10)
          }),
          mkdir: vi.fn((_remote: string, cb: (err?: any) => void) => {
            cb(null)
          }),
          readdir: vi.fn((_remote: string, cb: (err?: any, list?: any[]) => void) => {
            cb(null, [])
          }),
          on: vi.fn(),
          end: vi.fn()
        }
        callback(null, mockSftp)
      })
    }

    mockSession = {
      id: 'session-1',
      client: mockClient,
      sftp: undefined
    }
  })

  afterEach(() => {
    if (existsSync(testQueueDir)) {
      rmSync(testQueueDir, { recursive: true, force: true })
    }
  })

  it('should queue and run a download job, updating progress', async () => {
    sftpDownload(mockSession, sendSpy, 't-1', '/remote/file.txt', '/local/file.txt')

    // Wait until download finishes (done event sent)
    await new Promise<void>((resolve) => {
      const check = () => {
        if (progressEvents.some(e => e.transferId === 't-1' && e.done)) {
          resolve()
        } else {
          setTimeout(check, 2)
        }
      }
      check()
    })

    expect(mockClient.sftp).toHaveBeenCalledTimes(1)
    expect(progressEvents.length).toBeGreaterThanOrEqual(2)
    
    const intermediate = progressEvents.find(e => !e.done)
    expect(intermediate).toBeDefined()
    expect(intermediate.transferred).toBe(50)
    expect(intermediate.total).toBe(100)

    const completed = progressEvents.find(e => e.done)
    expect(completed).toBeDefined()
    expect(completed.error).toBeUndefined()
  })

  it('should limit active transfers to max concurrency of 3', async () => {
    sftpUpload(mockSession, sendSpy, 't-1', file1, '/remote/file1.txt')
    sftpUpload(mockSession, sendSpy, 't-2', file2, '/remote/file2.txt')
    sftpUpload(mockSession, sendSpy, 't-3', file3, '/remote/file3.txt')
    sftpUpload(mockSession, sendSpy, 't-4', file4, '/remote/file4.txt')

    // Wait until task 4 is queued
    await new Promise<void>((resolve) => {
      const check = () => {
        const queuedTask = (transferQueue as any).queue.find((t: any) => t.id === 't-4' && t.status === 'queued')
        if (queuedTask) {
          resolve()
        } else {
          setTimeout(check, 2)
        }
      }
      check()
    })

    expect((transferQueue as any).activeCount).toBe(3)

    const runningJobs = (transferQueue as any).queue.filter((t: any) => t.status === 'running')
    const queuedJobs = (transferQueue as any).queue.filter((t: any) => t.status === 'queued')
    expect(runningJobs).toHaveLength(3)
    expect(queuedJobs).toHaveLength(1)
    expect(queuedJobs[0].id).toBe('t-4')

    // Abort them to clean up instantly
    sftpCancel('session-1', 't-1')
    sftpCancel('session-1', 't-2')
    sftpCancel('session-1', 't-3')
    sftpCancel('session-1', 't-4')
  })

  it('should cancel a queued task instantly', async () => {
    sftpUpload(mockSession, sendSpy, 't-1', file1, '/remote/file1.txt')
    sftpUpload(mockSession, sendSpy, 't-2', file2, '/remote/file2.txt')
    sftpUpload(mockSession, sendSpy, 't-3', file3, '/remote/file3.txt')
    sftpUpload(mockSession, sendSpy, 't-4', file4, '/remote/file4.txt')

    // Wait until task 4 is queued
    await new Promise<void>((resolve) => {
      const check = () => {
        const queuedTask = (transferQueue as any).queue.find((t: any) => t.id === 't-4' && t.status === 'queued')
        if (queuedTask) {
          resolve()
        } else {
          setTimeout(check, 2)
        }
      }
      check()
    })

    expect((transferQueue as any).activeCount).toBe(3)

    sftpCancel('session-1', 't-4')

    const cancelProgress = progressEvents.find(e => e.transferId === 't-4' && e.done)
    expect(cancelProgress).toBeDefined()
    expect(cancelProgress.error).toContain('Cancelled')

    const task4 = (transferQueue as any).queue.find((t: any) => t.id === 't-4')
    expect(task4).toBeUndefined()

    // Clean up
    sftpCancel('session-1', 't-1')
    sftpCancel('session-1', 't-2')
    sftpCancel('session-1', 't-3')
  })

  it('should abort an active task by closing its sftp channel', async () => {
    sftpUpload(mockSession, sendSpy, 't-1', file1, '/remote/file1.txt')

    const activeJob = await new Promise<any>((resolve) => {
      const check = () => {
        const job = (transferQueue as any).queue.find((t: any) => t.id === 't-1' && t.status === 'running')
        if (job) {
          resolve(job)
        } else {
          setTimeout(check, 2)
        }
      }
      check()
    })

    expect(activeJob).toBeDefined()
    expect(activeJob.sftpChannel).toBeDefined()

    const endSpy = vi.spyOn(activeJob.sftpChannel, 'end')

    sftpCancel('session-1', 't-1')

    expect(activeJob.status).toBe('cancelled')
    expect(endSpy).toHaveBeenCalledTimes(1)
  })
})

describe('sftpService - walkDirectoryAndQueue', () => {
  let mockClient: any
  let mockSession: any
  let progressEvents: any[]
  const sendSpy = (channel: string, payload: any) => {
    if (channel === 'sftp:progress') {
      progressEvents.push(payload)
    }
  }

  const testTempDir = join(__dirname, 'test-upload-dir')

  beforeEach(() => {
    progressEvents = []
    ;(transferQueue as any).queue = []
    ;(transferQueue as any).activeCount = 0

    if (existsSync(testTempDir)) {
      rmSync(testTempDir, { recursive: true, force: true })
    }
    mkdirSync(testTempDir)
    mkdirSync(join(testTempDir, 'sub'))
    writeFileSync(join(testTempDir, 'file1.txt'), 'hello')
    writeFileSync(join(testTempDir, 'sub', 'file2.txt'), 'world')

    mockClient = {
      sftp: vi.fn((callback: (err: any, sftp: any) => void) => {
        const mockSftp = {
          fastPut: vi.fn((_local: string, _remote: string, _options: any, cb: (err?: any) => void) => {
            cb(null)
          }),
          fastGet: vi.fn((_remote: string, _local: string, _options: any, cb: (err?: any) => void) => {
            cb(null)
          }),
          mkdir: vi.fn((_remote: string, cb: (err?: any) => void) => {
            cb(null)
          }),
          readdir: vi.fn((_remote: string, cb: (err?: any, list?: any[]) => void) => {
            cb(null, [])
          }),
          on: vi.fn(),
          end: vi.fn()
        }
        callback(null, mockSftp)
      })
    }

    mockSession = {
      id: 'session-1',
      client: mockClient,
      sftp: undefined
    }
  })

  afterEach(() => {
    if (existsSync(testTempDir)) {
      rmSync(testTempDir, { recursive: true, force: true })
    }
  })

  it('should recursively traverse local folders and queue all individual files', async () => {
    sftpUpload(mockSession, sendSpy, 't-dir', testTempDir, '/remote/dest')

    // Wait until the parent folder done event is sent
    await new Promise<void>((resolve) => {
      const check = () => {
        const doneEvent = progressEvents.find(e => e.transferId === 't-dir' && e.done)
        if (doneEvent) {
          resolve()
        } else {
          setTimeout(check, 2)
        }
      }
      check()
    })

    // Check that we got completed progress events for both nested files
    const file1Complete = progressEvents.find(e => e.filename === 'file1.txt' && e.done)
    expect(file1Complete).toBeDefined()
    expect(file1Complete.error).toBeUndefined()

    const file2Complete = progressEvents.find(e => e.filename === 'file2.txt' && e.done)
    expect(file2Complete).toBeDefined()
    expect(file2Complete.error).toBeUndefined()

    const parentCompleteEvent = progressEvents.find(e => e.transferId === 't-dir' && e.done)
    expect(parentCompleteEvent).toBeDefined()
  })

  it('should wait for nested files to complete before parent directory upload is done', async () => {
    // Override fastPut to take 100ms
    mockClient.sftp = vi.fn((callback: (err: any, sftp: any) => void) => {
      const mockSftp = {
        fastPut: vi.fn((_local: string, _remote: string, _options: any, cb: (err?: any) => void) => {
          setTimeout(() => cb(null), 100)
        }),
        fastGet: vi.fn((_remote: string, _local: string, _options: any, cb: (err?: any) => void) => {
          cb(null)
        }),
        mkdir: vi.fn((_remote: string, cb: (err?: any) => void) => cb(null)),
        readdir: vi.fn((_remote: string, cb: (err?: any, list?: any[]) => void) => cb(null, [])),
        on: vi.fn(),
        end: vi.fn()
      }
      callback(null, mockSftp)
    })

    sftpUpload(mockSession, sendSpy, 't-dir', testTempDir, '/remote/dest')

    // Wait until the parent folder done event is sent
    await new Promise<void>((resolve) => {
      const check = () => {
        const doneEvent = progressEvents.find(e => e.transferId === 't-dir' && e.done)
        if (doneEvent) {
          resolve()
        } else {
          setTimeout(check, 2)
        }
      }
      check()
    })

    // At this point, the parent folder reported done: true.
    // Let's check if the nested files have finished transferring.
    const file1Complete = progressEvents.find(e => e.filename === 'file1.txt' && e.done)
    const file2Complete = progressEvents.find(e => e.filename === 'file2.txt' && e.done)

    console.log('BUG 1 FIXED CHECK: Parent directory reported done: true')
    console.log(`file1.txt done? ${!!file1Complete}`)
    console.log(`file2.txt done? ${!!file2Complete}`)

    // Since the bug is fixed, the files must be done when the directory reports done.
    expect(file1Complete).toBeDefined()
    expect(file2Complete).toBeDefined()
  })

  it('should cancel all queued files when parent directory upload is cancelled', async () => {
    const activeCallbacks: any[] = []
    mockClient.sftp = vi.fn((callback: (err: any, sftp: any) => void) => {
      const mockSftp = {
        fastPut: vi.fn((_local: string, _remote: string, _options: any, cb: (err?: any) => void) => {
          activeCallbacks.push(cb)
        }),
        fastGet: vi.fn((_local: string, _remote: string, _options: any, cb: (err?: any) => void) => cb(null)),
        mkdir: vi.fn((_remote: string, cb: (err?: any) => void) => cb(null)),
        readdir: vi.fn((_remote: string, cb: (err?: any, list?: any[]) => void) => cb(null, [])),
        on: vi.fn(),
        end: vi.fn(() => {
          const cbs = [...activeCallbacks]
          activeCallbacks.length = 0
          for (const cb of cbs) {
            cb(new Error('Channel closed'))
          }
        })
      }
      callback(null, mockSftp)
    })

    sftpUpload(mockSession, sendSpy, 't-dir', testTempDir, '/remote/dest')

    // Wait 20ms to allow readdir/traverse walk and task queuing
    await new Promise(r => setTimeout(r, 20))

    // Check that we have files in the transfer queue
    const queuedTasks = (transferQueue as any).queue.filter((t: any) => t.sessionId === 'session-1')
    expect(queuedTasks.length).toBeGreaterThan(0)

    // Attempt to cancel the directory upload
    sftpCancel('session-1', 't-dir')

    // Check if the queued tasks for this session were cancelled
    const remainingTasks = (transferQueue as any).queue.filter((t: any) => t.sessionId === 'session-1')
    console.log(`BUG 2 FIXED CHECK: Cancelled 't-dir'. Remaining queued files count: ${remainingTasks.length}`)

    // Since the bug is fixed, there should be no remaining tasks in the queue for this session.
    expect(remainingTasks).toHaveLength(0)

    // Clean up remaining tasks manually to avoid hanging tests (should be 0)
    for (const task of remainingTasks) {
      sftpCancel('session-1', task.id)
    }
  })
})
