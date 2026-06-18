import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

interface Props {
  sessionId: string
  active: boolean
}

export default function TerminalView({ sessionId, active }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#1b1d23',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current!)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // Keystrokes -> remote shell.
    const inputSub = term.onData((data) => window.api.session.write(sessionId, data))

    // Remote output for this session -> terminal.
    const dataSub = window.api.onSessionData((e) => {
      if (e.id === sessionId) term.write(e.data)
    })

    const statusSub = window.api.onSessionStatus((e) => {
      if (e.id !== sessionId) return
      if (e.status === 'connecting') term.write('\r\n\x1b[90m连接主机...\x1b[0m\r\n')
      if (e.status === 'error') term.write(`\r\n\x1b[31m连接错误: ${e.message ?? ''}\x1b[0m\r\n`)
      if (e.status === 'closed') term.write('\r\n\x1b[90m连接已断开\x1b[0m\r\n')
    })

    const pushResize = (): void => {
      try {
        fit.fit()
        window.api.session.resize(sessionId, term.cols, term.rows)
      } catch {
        /* container not measurable yet */
      }
    }
    const ro = new ResizeObserver(pushResize)
    ro.observe(containerRef.current!)

    return () => {
      inputSub.dispose()
      dataSub()
      statusSub()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  // Re-fit when this tab becomes visible (hidden containers measure as 0).
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit) return
      try {
        fit.fit()
        window.api.session.resize(sessionId, term.cols, term.rows)
        term.focus()
      } catch {
        /* ignore */
      }
    }, 30)
    return () => clearTimeout(t)
  }, [active, sessionId])

  return <div className="terminal-wrap" ref={containerRef} />
}
