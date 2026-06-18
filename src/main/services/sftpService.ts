import { appendFileSync, promises as fsPromises } from 'fs'
import { join } from 'path'
import { SFTPWrapper } from 'ssh2'
import { logger } from './logger'
import type { SftpEntry } from '@shared/types'
import type { Session, Sender } from '../sshManager'

export interface TransferTask {
  id: string
  parentId?: string
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

export interface DirectoryTask {
  sessionId: string
  id: string
  direction: 'upload' | 'download'
  filename: string
  queuedFileIds: Set<string>
  completedFileIds: Set<string>
  failedFileIds: Set<string>
  cancelledFileIds: Set<string>
  fileProgresses: Map<string, { transferred: number; total: number; done: boolean }>
  walkCompleted: boolean
  send: Sender
}

class TransferQueueManager {
  private queue: TransferTask[] = []
  private activeCount = 0
  private maxConcurrency = 3
  private directoryTasks = new Map<string, DirectoryTask>()

  registerDirectoryTask(
    sessionId: string,
    transferId: string,
    direction: 'upload' | 'download',
    filename: string,
    send: Sender
  ) {
    this.directoryTasks.set(transferId, {
      sessionId,
      id: transferId,
      direction,
      filename,
      queuedFileIds: new Set(),
      completedFileIds: new Set(),
      failedFileIds: new Set(),
      cancelledFileIds: new Set(),
      fileProgresses: new Map(),
      walkCompleted: false,
      send
    })
  }

  completeDirectoryWalk(parentId: string) {
    const dirTask = this.directoryTasks.get(parentId)
    if (dirTask) {
      dirTask.walkCompleted = true
      this.checkDirectoryCompletion(parentId)
    }
  }

  failDirectoryWalk(parentId: string, errorMsg: string) {
    const dirTask = this.directoryTasks.get(parentId)
    if (dirTask) {
      // Cancel all child tasks that might have been queued
      const childTasks = this.queue.filter((t) => t.parentId === parentId && t.sessionId === dirTask.sessionId)
      for (const child of childTasks) {
        this.cancel(dirTask.sessionId, child.id)
      }
      dirTask.walkCompleted = true
      dirTask.send('sftp:progress', {
        sessionId: dirTask.sessionId,
        transferId: dirTask.id,
        direction: dirTask.direction,
        filename: dirTask.filename,
        transferred: 0,
        total: 0,
        done: true,
        error: errorMsg
      })
      this.directoryTasks.delete(parentId)
    }
  }

  private handleFileEnd(task: TransferTask, status: 'completed' | 'failed' | 'cancelled', _errorMsg?: string) {
    if (task.parentId) {
      const dirTask = this.directoryTasks.get(task.parentId)
      if (dirTask) {
        dirTask.queuedFileIds.delete(task.id)
        if (status === 'completed') dirTask.completedFileIds.add(task.id)
        if (status === 'failed') dirTask.failedFileIds.add(task.id)
        if (status === 'cancelled') dirTask.cancelledFileIds.add(task.id)

        const fp = dirTask.fileProgresses.get(task.id)
        if (fp) {
          fp.done = true
          if (status === 'completed') {
            fp.transferred = fp.total
          }
        }
        this.checkDirectoryCompletion(task.parentId)
      }
    }
  }

  private checkDirectoryCompletion(parentId: string) {
    const dirTask = this.directoryTasks.get(parentId)
    if (!dirTask) return

    if (dirTask.walkCompleted && dirTask.queuedFileIds.size === 0) {
      const totalFailed = dirTask.failedFileIds.size
      const totalCancelled = dirTask.cancelledFileIds.size

      let finalStatus: 'completed' | 'failed' | 'cancelled' = 'completed'
      let finalError: string | undefined = undefined

      if (totalCancelled > 0) {
        finalStatus = 'cancelled'
        finalError = 'Cancelled by user'
      } else if (totalFailed > 0) {
        finalStatus = 'failed'
        finalError = `${totalFailed} files failed to upload`
      }

      dirTask.send('sftp:progress', {
        sessionId: dirTask.sessionId,
        transferId: dirTask.id,
        direction: dirTask.direction,
        filename: dirTask.filename,
        transferred: finalStatus === 'completed' ? -1 : 0,
        total: finalStatus === 'completed' ? -1 : 0,
        done: true,
        error: finalError
      })

      this.directoryTasks.delete(parentId)
    } else {
      this.updateDirectoryProgress(parentId)
    }
  }

  private updateDirectoryProgress(parentId: string) {
    const dirTask = this.directoryTasks.get(parentId)
    if (!dirTask) return

    let totalTransferred = 0
    let totalSize = 0

    for (const fp of dirTask.fileProgresses.values()) {
      totalTransferred += fp.transferred
      totalSize += fp.total
    }

    dirTask.send('sftp:progress', {
      sessionId: dirTask.sessionId,
      transferId: dirTask.id,
      direction: dirTask.direction,
      filename: dirTask.filename,
      transferred: totalTransferred,
      total: totalSize,
      done: false
    })
  }

  add(task: TransferTask) {
    if (task.parentId) {
      const dirTask = this.directoryTasks.get(task.parentId)
      if (dirTask) {
        dirTask.queuedFileIds.add(task.id)
        dirTask.fileProgresses.set(task.id, { transferred: 0, total: 0, done: false })
      }
    }
    logger.info('SFTP', `添加传输任务: [${task.direction === 'upload' ? '上传' : '下载'}] 远程: ${task.remotePath} 本地: ${task.localPath} (任务ID: ${task.id})`)
    this.queue.push(task)
    this.schedule()
  }

  cancel(sessionId: string, transferId: string) {
    const dirTask = this.directoryTasks.get(transferId)
    if (dirTask) {
      logger.info('SFTP', `取消目录传输任务: sessionId=${sessionId}, transferId=${transferId}`)
      const childTasks = this.queue.filter((t) => t.parentId === transferId && t.sessionId === sessionId)
      for (const child of childTasks) {
        this.cancel(sessionId, child.id)
      }
      dirTask.walkCompleted = true
      this.checkDirectoryCompletion(transferId)
      return
    }

    const task = this.queue.find((t) => t.id === transferId && t.sessionId === sessionId)
    if (!task) return

    logger.info('SFTP', `取消单个文件传输任务: sessionId=${sessionId}, transferId=${transferId}, 文件名=${task.filename}, 状态=${task.status}`)

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
      this.handleFileEnd(task, 'cancelled')
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
    for (const [dirId, dirTask] of this.directoryTasks.entries()) {
      if (dirTask.sessionId === sessionId) {
        this.cancel(sessionId, dirId)
      }
    }
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
    logger.info('SFTP', `启动传输任务: [${task.direction === 'upload' ? '上传' : '下载'}] 文件名: ${task.filename}, 远程: ${task.remotePath}, 本地: ${task.localPath} (任务ID: ${task.id})`)

    task.client.sftp((err: any, sftp: SFTPWrapper) => {
      if (task.status === 'cancelled') {
        logger.info('SFTP', `任务已被取消(SFTP初始化前): [${task.direction === 'upload' ? '上传' : '下载'}] ${task.filename}`)
        sftp?.end()
        this.activeCount--
        this.remove(task.id)
        this.handleFileEnd(task, 'cancelled')
        this.schedule()
        return
      }

      if (err) {
        logger.error('SFTP', `传输通道打开失败: [${task.direction === 'upload' ? '上传' : '下载'}] ${task.filename}`, err)
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
        this.handleFileEnd(task, 'failed', err.message)
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
        if (task.parentId) {
          const dirTask = this.directoryTasks.get(task.parentId)
          if (dirTask) {
            const fp = dirTask.fileProgresses.get(task.id)
            if (fp) {
              fp.transferred = transferred
              fp.total = total
            }
            this.updateDirectoryProgress(task.parentId)
          }
        }
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
          logger.info('SFTP', `传输任务已取消: [${task.direction === 'upload' ? '上传' : '下载'}] ${task.filename}`)
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
          this.handleFileEnd(task, 'cancelled')
          this.schedule()
          return
        }

        if (transferErr) {
          logger.error('SFTP', `文件传输失败: [${task.direction === 'upload' ? '上传' : '下载'}] ${task.filename}`, transferErr)
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
          this.handleFileEnd(task, 'failed', transferErr.message)
        } else {
          logger.info('SFTP', `文件传输完成: [${task.direction === 'upload' ? '上传' : '下载'}] ${task.filename}`)
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
          this.handleFileEnd(task, 'completed')
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
  if (level === 'ERROR') {
    logger.error('SFTP', msg, err)
  } else if (level === 'WARN') {
    logger.warn('SFTP', msg, err)
  } else {
    logger.info('SFTP', msg)
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
  parentId: string,
  localPath: string,
  remotePath: string
): Promise<void> {
  const id = session.id
  const logInfo = (msg: string) => {
    logger.info('SFTP', msg)
  }
  const logWarn = (msg: string, errMessage: string) => {
    logger.warn('SFTP', `${msg} : ${errMessage}`)
  }
  const logError = (msg: string, err: any) => {
    logger.error('SFTP', msg, err)
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
          parentId,
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
        transferQueue.registerDirectoryTask(id, transferId, 'upload', filename, send)

        send('sftp:progress', {
          sessionId: id,
          transferId,
          direction: 'upload',
          filename,
          transferred: 0,
          total: 100,
          done: false
        })

        walkDirectoryAndQueue(session, send, transferId, localPath, remotePath)
          .then(() => {
            transferQueue.completeDirectoryWalk(transferId)
          })
          .catch((err) => {
            transferQueue.failDirectoryWalk(transferId, err.message)
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
