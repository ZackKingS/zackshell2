import { appendFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { SFTPWrapper } from 'ssh2'
import type { SftpEntry } from '@shared/types'
import type { Session, Sender } from '../sshManager'

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

/** Open (or reuse) an SFTP subsystem on the session. */
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
  getSftp(session)
    .then((sftp) => {
      sftp.fastGet(
        remotePath,
        localPath,
        {
          step: (transferred: number, _chunk: number, total: number) => {
            send('sftp:progress', {
              sessionId: session.id,
              transferId,
              direction: 'download',
              filename,
              transferred,
              total,
              done: false
            })
          }
        },
        (err) => {
          if (err) {
            send('sftp:progress', {
              sessionId: session.id,
              transferId,
              direction: 'download',
              filename,
              transferred: 0,
              total: 0,
              done: true,
              error: err.message
            })
          } else {
            send('sftp:progress', {
              sessionId: session.id,
              transferId,
              direction: 'download',
              filename,
              transferred: -1,
              total: -1,
              done: true
            })
          }
        }
      )
    })
    .catch((err: Error) => {
      send('sftp:progress', {
        sessionId: session.id,
        transferId,
        direction: 'download',
        filename,
        transferred: 0,
        total: 0,
        done: true,
        error: err.message
      })
    })
}

export function sftpUpload(
  session: Session,
  send: Sender,
  transferId: string,
  localPath: string,
  remotePath: string
): void {
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

  logInfo(`[SFTP Upload] Initiating upload. Session: ${id}, Transfer: ${transferId}`)
  logInfo(`[SFTP Upload] Local path: ${localPath}`)
  logInfo(`[SFTP Upload] Remote path: ${remotePath}`)

  const filename = localPath.split(/[\\/]/).pop() ?? localPath
  getSftp(session)
    .then(async (sftp) => {
      let stats
      try {
        stats = statSync(localPath)
        logInfo(
          `[SFTP Upload] Local path stats retrieved. isDirectory: ${stats.isDirectory()}, size: ${stats.size}`
        )
      } catch (err) {
        logError(`[SFTP Upload] Failed to stat local path: ${localPath}`, err)
        throw err
      }

      if (stats.isDirectory()) {
        logInfo(`[SFTP Upload] Starting recursive directory upload: ${localPath} -> ${remotePath}`)
        const uploadDir = async (localDirPath: string, remoteDirPath: string) => {
          logInfo(`[SFTP Upload] Creating remote directory: ${remoteDirPath}`)
          await new Promise<void>((resolve) => {
            sftp.mkdir(remoteDirPath, (err) => {
              if (err) {
                logWarn(
                  `[SFTP Upload] Remote directory creation warning/info (it may already exist): ${remoteDirPath}`,
                  err.message
                )
              } else {
                logInfo(`[SFTP Upload] Remote directory created successfully: ${remoteDirPath}`)
              }
              resolve()
            })
          })

          let items
          try {
            items = readdirSync(localDirPath)
            logInfo(`[SFTP Upload] Local directory read: ${localDirPath}. Items: ${JSON.stringify(items)}`)
          } catch (err) {
            logError(`[SFTP Upload] Failed to read local directory: ${localDirPath}`, err)
            throw err
          }

          for (const item of items) {
            const localItemPath = join(localDirPath, item)
            const remoteItemPath = remoteDirPath.endsWith('/')
              ? remoteDirPath + item
              : remoteDirPath + '/' + item

            let itemStats
            try {
              itemStats = statSync(localItemPath)
            } catch (err) {
              logError(`[SFTP Upload] Failed to stat local item: ${localItemPath}`, err)
              throw err
            }

            if (itemStats.isDirectory()) {
              await uploadDir(localItemPath, remoteItemPath)
            } else {
              const fileTransferId =
                Date.now().toString(36) + Math.random().toString(36).slice(2)
              logInfo(
                `[SFTP Upload] Uploading file: ${localItemPath} -> ${remoteItemPath} (ID: ${fileTransferId})`
              )
              await new Promise<void>((resolve, reject) => {
                sftp.fastPut(
                  localItemPath,
                  remoteItemPath,
                  {
                    step: (transferred, _chunk, total) => {
                      send('sftp:progress', {
                        sessionId: id,
                        transferId: fileTransferId,
                        direction: 'upload',
                        filename: item,
                        transferred,
                        total,
                        done: false
                      })
                    }
                  },
                  (err) => {
                    if (err) {
                      logError(`[SFTP Upload] Failed file upload: ${localItemPath}`, err)
                      send('sftp:progress', {
                        sessionId: id,
                        transferId: fileTransferId,
                        direction: 'upload',
                        filename: item,
                        transferred: 0,
                        total: 0,
                        done: true,
                        error: err.message
                      })
                      reject(err)
                    } else {
                      logInfo(`[SFTP Upload] Successful file upload: ${localItemPath}`)
                      send('sftp:progress', {
                        sessionId: id,
                        transferId: fileTransferId,
                        direction: 'upload',
                        filename: item,
                        transferred: -1,
                        total: -1,
                        done: true
                      })
                      resolve()
                    }
                  }
                )
              })
            }
          }
        }
        uploadDir(localPath, remotePath)
          .then(() => {
            logInfo(`[SFTP Upload] Recursive upload complete for directory: ${localPath}`)
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
            logError(`[SFTP Upload] Recursive upload failed for directory: ${localPath}`, err)
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
        logInfo(`[SFTP Upload] Starting single file upload: ${localPath} -> ${remotePath}`)
        sftp.fastPut(
          localPath,
          remotePath,
          {
            step: (transferred: number, _chunk: number, total: number) => {
              send('sftp:progress', {
                sessionId: id,
                transferId,
                direction: 'upload',
                filename,
                transferred,
                total,
                done: false
              })
            }
          },
          (err) => {
            if (err) {
              logError(`[SFTP Upload] Single file upload failed: ${localPath}`, err)
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
            } else {
              logInfo(`[SFTP Upload] Single file upload successful: ${localPath}`)
              send('sftp:progress', {
                sessionId: id,
                transferId,
                direction: 'upload',
                filename,
                transferred: -1,
                total: -1,
                done: true
              })
            }
          }
        )
      }
    })
    .catch((err: Error) => {
      logError(`[SFTP Upload] General upload failure for: ${localPath}`, err)
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
