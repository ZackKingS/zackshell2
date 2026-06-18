import { describe, it, expect } from 'vitest'
import { parseMonitorOutput, type MonitorState } from './telemetryService'

describe('telemetryService - parseMonitorOutput', () => {
  const mockOutput1 = [
    '@@CPU',
    'cpu  10000 200 3000 80000 200 0 0 0 0 0',
    '@@MEM',
    'MemTotal:        16384000 kB',
    'MemAvailable:     8192000 kB',
    'SwapTotal:        4194304 kB',
    'SwapFree:         2097152 kB',
    '@@NET',
    ' eth0: 1000000 1000 0 0 0 0 0 0 2000000 2000 0 0 0 0 0 0',
    ' lo: 50000 500 0 0 0 0 0 0 50000 500 0 0 0 0 0 0',
    '@@UP',
    '12345.67 24691.34',
    '@@LOAD',
    '0.50 0.25 0.10 1/150 12345',
    '@@DISK',
    'Filesystem 1K-blocks Used Available Use% Mounted on',
    '/dev/sda1 100000000 40000000 60000000 40% /',
    '@@PROC',
    '  PID  %CPU   RSS COMMAND',
    ' 1001   5.5 102400 nginx',
    ' 1002   1.2 51200 node',
    '@@IP',
    '192.168.1.100',
    '@@END'
  ].join('\n')

  const mockOutput2 = [
    '@@CPU',
    // 2 seconds later (dt = 2.0s)
    // CPU Total increased by 10000, Idle increased by 5000 (CPU delta total = 10000, idle = 5000, non-idle = 5000 -> 50% CPU usage)
    'cpu  15000 200 3000 85000 200 0 0 0 0 0',
    '@@MEM',
    'MemTotal:        16384000 kB',
    'MemAvailable:     4096000 kB',
    'SwapTotal:        4194304 kB',
    'SwapFree:         1048576 kB',
    '@@NET',
    // net rx increased by 200000 bytes, tx increased by 400000 bytes over 2s -> rx = 100000 B/s, tx = 200000 B/s
    ' eth0: 1200000 1200 0 0 0 0 0 0 2400000 2400 0 0 0 0 0 0',
    '@@UP',
    '12347.67 24695.34',
    '@@LOAD',
    '0.60 0.35 0.15 2/152 12346',
    '@@DISK',
    'Filesystem 1K-blocks Used Available Use% Mounted on',
    '/dev/sda1 100000000 50000000 50000000 50% /',
    '@@PROC',
    '  PID  %CPU   RSS COMMAND',
    ' 1001  12.5 153600 nginx',
    ' 1002   0.5 51200 node',
    '@@IP',
    '192.168.1.100',
    '@@END'
  ].join('\n')

  it('should parse first sample metrics with initial state', () => {
    const state: MonitorState = {}
    const snapshot = parseMonitorOutput(mockOutput1, state)

    expect(snapshot).not.toBeNull()
    if (!snapshot) return

    // Since it's the first sample, CPU and net rates should be 0 because there is no previous sample.
    expect(snapshot.cpu).toBe(0)
    expect(snapshot.net.rx).toBe(0)
    expect(snapshot.net.tx).toBe(0)

    // Memory (16384000 kB total = 16000 MB, 8192000 kB avail -> 8192000 kB used = 8000 MB)
    expect(snapshot.mem.total).toBe(16000)
    expect(snapshot.mem.used).toBe(8000)
    
    // Swap (4194304 kB total = 4096 MB, 2097152 kB free -> 2097152 kB used = 2048 MB)
    expect(snapshot.swap.total).toBe(4096)
    expect(snapshot.swap.used).toBe(2048)

    // Uptime & Load
    expect(snapshot.uptimeSec).toBe(12345)
    expect(snapshot.load).toEqual([0.5, 0.25, 0.1])

    // Disks
    expect(snapshot.disks).toHaveLength(1)
    expect(snapshot.disks[0]).toEqual({
      mount: '/',
      used: 40000000,
      avail: 60000000,
      size: 100000000,
      usePct: 40
    })

    // Processes
    expect(snapshot.procs).toHaveLength(2)
    expect(snapshot.procs[0]).toEqual({
      pid: 1001,
      cpu: 5.5,
      rss: 102400,
      cmd: 'nginx'
    })

    // IP
    expect(snapshot.ip).toBe('192.168.1.100')
  })

  it('should calculate CPU pct and Network rates correctly on second sample', () => {
    const state: MonitorState = {}
    
    // Run first sample to populate state
    const firstTime = Date.now() - 2000
    state.prevTime = firstTime
    parseMonitorOutput(mockOutput1, state)
    
    // Override prevTime to exactly 2.0s before now to ensure deterministic math
    const secondTime = Date.now()
    state.prevTime = secondTime - 2000

    const snapshot = parseMonitorOutput(mockOutput2, state)

    expect(snapshot).not.toBeNull()
    if (!snapshot) return

    // CPU calculations:
    // Total diff: 15000 - 10000 = 5000 idle/wait, cpu total increased by 10000
    // Idle diff: 85200 - 80200 = 5000
    // cpuPct = (10000 - 5000) / 10000 * 100 = 50%
    expect(snapshot.cpu).toBe(50)

    // Network calculations:
    // rx delta: 1200000 - 1000000 = 200000 bytes over 2s -> 100000 B/s
    // tx delta: 2400000 - 2000000 = 400000 bytes over 2s -> 200000 B/s
    expect(snapshot.net.rx).toBe(100000)
    expect(snapshot.net.tx).toBe(200000)

    // Memory change verification (avail went from 8G to 4G -> used memory goes from 8G to 12G)
    expect(snapshot.mem.used).toBe(12000)
    expect(snapshot.swap.used).toBe(3072) // 4096 - 1024 = 3072MB used
  })
})
