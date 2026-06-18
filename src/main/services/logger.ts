import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const LOGS_DIR = join(process.cwd(), 'logs')

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true })
  }
}

export function writeLog(
  level: 'INFO' | 'WARN' | 'ERROR',
  moduleName: string,
  msg: string,
  err?: any
): void {
  try {
    ensureLogsDir()
    const logPath = join(LOGS_DIR, 'app.log')
    const time = new Date().toISOString()
    let errStr = ''
    if (err) {
      errStr = ' | Error: ' + (err instanceof Error ? err.stack || err.message : JSON.stringify(err))
    }
    const logLine = `[${time}] [${level}] [${moduleName}] ${msg}${errStr}\n`
    appendFileSync(logPath, logLine, 'utf8')

    // Also output to original console for development debugging
    const consoleMsg = `[${level}] [${moduleName}] ${msg}${errStr}`
    if (level === 'ERROR') {
      console.error(consoleMsg)
    } else if (level === 'WARN') {
      console.warn(consoleMsg)
    } else {
      console.log(consoleMsg)
    }
  } catch (e) {
    // Fail-safe to prevent application crashing if logging fails
  }
}

export const logger = {
  info: (moduleName: string, msg: string) => writeLog('INFO', moduleName, msg),
  warn: (moduleName: string, msg: string, err?: any) => writeLog('WARN', moduleName, msg, err),
  error: (moduleName: string, msg: string, err?: any) => writeLog('ERROR', moduleName, msg, err)
}
