import { appendFileSync, promises as fsPromises } from 'fs'
import { join } from 'path'
import { SFTPWrapper } from 'ssh2'
import type { SftpEntry } from '@shared/types'
import type { Session, Sender } from '../sshManager'

export interface TransferTask {
  id: string
  sessionId: string
  client: any
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  filename: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  transferred: number
  total: number
  sftpChannel?: SFTPWrapper
  error?: string
  send: Sender
}

class TransferQueueManager {
  private queue: TransferTask[] = []
  private activeCount = 0
  private maxConcurrency = 3

  add(task: TransferTask) {
    this.queue.push(task)
    this.schedule()
  }

  cancel(sessionId: string, transferId: string) {
    const task = this.queue.find((t) => t.id === transferId && t.sessionId === sessionId)
    if (!task) return

    if (task.status === 'queued') {
      task.status = 'cancelled'
      task.send('sftp:progress', {
        sessionId: task.sessionId,
        transferId: task.id,
        direction: task.direction,
        filename: task.filename,
        transferred: 0,
        total: 0,
        done: true,
        error: 'Cancelled by user'
      })
      this.remove(task.id)
    } else if (task.status === 'running') {
      task.status = 'cancelled'
      try {
        task.sftpChannel?.end()
      } catch (e) {
        // ignore
      }
    }
  }

  cancelSession(sessionId: string) {
    const sessionTasks = this.queue.filter((t) => t.sessionId === sessionId)
    for (const task of sessionTasks) {
      this.cancel(sessionId, task.id)
    }
  }

  private remove(id: string) {
    this.queue = this.queue.filter((t) => t.id !== id)
  }

  private schedule() {
    if (this.activeCount >= this.maxConcurrency) return

    const nextTask = this.queue.find((t) => t.status === 'queued')
    if (!nextTask) return

    this.activeCount++
    this.runTask(nextTask)
  }

  private runTask(task: TransferTask) {
    task.status = 'running'

    task.client.sftp((err: any, sftp: SFTPWrapper) => {
      if (task.status === 'cancelled') {
        sftp?.end()
        this.activeCount--
        this.remove(task.id)
        this.schedule()
        return
      }

      if (err) {
        task.status = 'failed'
        task.error = err.message
        task.send('sftp:progress', {
          sessionId: task.sessionId,
          transferId: task.id,
          direction: task.direction,
          filename: task.filename,
          transferred: 0,
          total: 0,
          done: true,
          error: err.message
        })
        this.activeCount--
        this.remove(task.id)
        this.schedule()
        return
      }

      task.sftpChannel = sftp

      const step = (transferred: number, _chunk: number, total: number) => {
        if (task.status === 'cancelled') return
        task.transferred = transferred
        task.total = total
        task.send('sftp:progress', {
          sessionId: task.sessionId,
          transferId: task.id,
          direction: task.direction,
          filename: task.filename,
          transferred,
          total,
          done: false
        })
      }

      const callback = (transferErr: any) => {
        try {
          sftp.end()
        } catch {
          // ignore
        }
        task.sftpChannel = undefined

        this.activeCount--
        this.remove(task.id)

        if (task.status === 'cancelled') {
          task.send('sftp:progress', {
            sessionId: task.sessionId,
            transferId: task.id,
            direction: task.direction,
            filename: task.filename,
            transferred: 0,
            total: 0,
            done: true,
            error: 'Cancelled by user'
          })
          this.schedule()
          return
        }

        if (transferErr) {
          task.status = 'failed'
          task.error = transferErr.message
          task.send('sftp:progress', {
            sessionId: task.sessionId,
            transferId: task.id,
            direction: task.direction,
            filename: task.filename,
            transferred: 0,
            total: 0,
            done: true,
            error: transferErr.message
          })
        } else {
          task.status = 'completed'
          task.send('sftp:progress', {
            sessionId: task.sessionId,
            transferId: task.id,
            direction: task.direction,
            filename: task.filename,
            transferred: -1,
            total: -1,
            done: true
          })
        }

        this.schedule()
      }

      if (task.direction === 'upload') {
        sftp.fastPut(task.localPath, task.remotePath, { step }, callback)
      } else {
        sftp.fastGet(task.remotePath, task.localPath, { step }, callback)
      }
    })
  }
}

export const transferQueue = new TransferQueueManager()

export function logToFile(level: 'INFO' | 'ERROR' | 'WARN', msg: string, err?: any): void {
  try {
    const logPath = join(process.cwd(), 'sftp_upload.log')
    const time = new Date().toISOString()
    let errStr = ''
    if (err) {
      errStr = ' | Error: ' + (err instanceof Error ? err.stack || err.message : JSON.stringify(err))
    }
    appendFileSync(logPath, `[${time}] [${level}] ${msg}${errStr}\n`, 'utf8')
  } catch (e) {
    // ignore
  }
}

export function getSftp(session: Session): Promise<SFTPWrapper> {
  if (!session) return Promise.reject(new Error('Session not found'))
  if (session.sftp) return Promise.resolve(session.sftp)
  return new Promise((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) return reject(err)
      session.sftp = sftp
      sftp.on('error', () => {
        session.sftp = undefined
      })
      resolve(sftp)
    })
  })
}

export async function sftpList(session: Session, remotePath: string): Promise<SftpEntry[]> {
  const sftp = await getSftp(session)
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) return reject(err)
      const entries: SftpEntry[] = list.map((item) => {
        const attrs = item.attrs as {
          size: number
          mtime: number
          mode: number
          isDirectory: () => boolean
          isSymbolicLink: () => boolean
        }
        return {
          filename: item.filename,
          longname: item.longname ?? '',
          isDir:
            typeof attrs.isDirectory === 'function'
              ? attrs.isDirectory()
              : !!(attrs.mode & 0o040000),
          isSymlink:
            typeof attrs.isSymbolicLink === 'function'
              ? attrs.isSymbolicLink()
              : !!(attrs.mode & 0o120000),
          size: attrs.size ?? 0,
          modTime: attrs.mtime ?? 0,
          permissions: attrs.mode ?? 0
        }
      })
      resolve(entries)
    })
  })
}

export async function sftpMkdir(session: Session, remotePath: string): Promise<void> {
  const sftp = await getSftp(session)
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()))
  })
}

export async function sftpRename(
  session: Session,
  oldPath: string,
  newPath: string
): Promise<void> {
  const sftp = await getSftp(session)
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()))
  })
}

export async function sftpRemove(
  session: Session,
  remotePath: string,
  isDir: boolean
): Promise<void> {
  const sftp = await getSftp(session)
  return new Promise((resolve, reject) => {
    if (isDir) {
      sftp.rmdir(remotePath, (err) => (err ? reject(err) : resolve()))
    } else {
      sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve()))
    }
  })
}

export async function sftpChmod(session: Session, remotePath: string, mode: number): Promise<void> {
  const sftp = await getSftp(session)
  return new Promise((resolve, reject) => {
    sftp.chmod(remotePath, mode, (err) => (err ? reject(err) : resolve()))
  })
}

export function sftpDownload(
  session: Session,
  send: Sender,
  transferId: string,
  remotePath: string,
  localPath: string
): void {
  const filename = remotePath.split('/').pop() ?? remotePath
  transferQueue.add({
    id: transferId,
    sessionId: session.id,
    client: session.client,
    direction: 'download',
    localPath,
    remotePath,
    filename,
    status: 'queued',
    transferred: 0,
    total: 0,
    send
  })
}

async function walkDirectoryAndQueue(
  session: Session,
  send: Sender,
  localPath: string,
  remotePath: string
): Promise<void> {
  const id = session.id
  const logInfo = (msg: string) => {
    console.log(msg)
    logToFile('INFO', msg)
  }
  const logWarn = (msg: string, errMessage: string) => {
    console.warn(msg + ' : ' + errMessage)
    logToFile('WARN', msg + ' : ' + errMessage)
  }
  const logError = (msg: string, err: any) => {
    console.error(msg, err)
    logToFile('ERROR', msg, err)
  }

  logInfo(`[SFTP Upload] Starting recursive async walk: ${localPath} -> ${remotePath}`)

  let sftp: SFTPWrapper
  try {
    sftp = await getSftp(session)
  } catch (err) {
    logError(`[SFTP Upload] Failed to open SFTP channel for directory creation`, err)
    throw err
  }

  const mkdirRemote = async (remoteDirPath: string) => {
    return new Promise<void>((resolve) => {
      sftp.mkdir(remoteDirPath, (err) => {
        if (err) {
          logWarn(`[SFTP Upload] Remote mkdir warning (may already exist): ${remoteDirPath}`, err.message)
        } else {
          logInfo(`[SFTP Upload] Remote directory created: ${remoteDirPath}`)
        }
        resolve()
      })
    })
  }

  const traverse = async (localDirPath: string, remoteDirPath: string) => {
    await mkdirRemote(remoteDirPath)

    let items
    try {
      items = await fsPromises.readdir(localDirPath)
    } catch (err) {
      logError(`[SFTP Upload] Failed to read directory: ${localDirPath}`, err)
      throw err
    }

    for (const item of items) {
      const localItemPath = join(localDirPath, item)
      const remoteItemPath = remoteDirPath.endsWith('/')
        ? remoteDirPath + item
        : remoteDirPath + '/' + item

      let itemStats
      try {
        itemStats = await fsPromises.stat(localItemPath)
      } catch (err) {
        logError(`[SFTP Upload] Failed to stat: ${localItemPath}`, err)
        throw err
      }

      if (itemStats.isDirectory()) {
        await traverse(localItemPath, remoteItemPath)
      } else {
        const fileTransferId = Date.now().toString(36) + Math.random().toString(36).slice(2)
        logInfo(`[SFTP Upload] Queueing file: ${localItemPath} -> ${remoteItemPath} (ID: ${fileTransferId})`)
        transferQueue.add({
          id: fileTransferId,
          sessionId: id,
          client: session.client,
          direction: 'upload',
          localPath: localItemPath,
          remotePath: remoteItemPath,
          filename: item,
          status: 'queued',
          transferred: 0,
          total: 0,
          send
        })
      }
    }
  }

  await traverse(localPath, remotePath)
  logInfo(`[SFTP Upload] Finished walk and queued all items for: ${localPath}`)
}

export function sftpUpload(
  session: Session,
  send: Sender,
  transferId: string,
  localPath: string,
  remotePath: string
): void {
  const id = session.id
  const filename = localPath.split(/[\\/]/).pop() ?? localPath

  fsPromises.stat(localPath)
    .then((stats) => {
      if (stats.isDirectory()) {
        send('sftp:progress', {
          sessionId: id,
          transferId,
          direction: 'upload',
          filename,
          transferred: 0,
          total: 100,
          done: false
        })

        walkDirectoryAndQueue(session, send, localPath, remotePath)
          .then(() => {
            send('sftp:progress', {
              sessionId: id,
              transferId,
              direction: 'upload',
              filename,
              transferred: -1,
              total: -1,
              done: true
            })
          })
          .catch((err) => {
            send('sftp:progress', {
              sessionId: id,
              transferId,
              direction: 'upload',
              filename,
              transferred: 0,
              total: 0,
              done: true,
              error: err.message
            })
          })
      } else {
        transferQueue.add({
          id: transferId,
          sessionId: id,
          client: session.client,
          direction: 'upload',
          localPath,
          remotePath,
          filename,
          status: 'queued',
          transferred: 0,
          total: 0,
          send
        })
      }
    })
    .catch((err) => {
      send('sftp:progress', {
        sessionId: id,
        transferId,
        direction: 'upload',
        filename,
        transferred: 0,
        total: 0,
        done: true,
        error: err.message
      })
    })
}

export function sftpCancel(sessionId: string, transferId: string): void {
  transferQueue.cancel(sessionId, transferId)
}

export function sftpCancelSession(sessionId: string): void {
  transferQueue.cancelSession(sessionId)
}
