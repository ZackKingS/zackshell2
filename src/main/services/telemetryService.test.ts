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

  it('should calculate real-time process CPU usage using cumulative ticks (utime + stime) format', () => {
    const mockOutputWithTicks1 = [
      '@@CPU',
      'cpu  10000 200 3000 80000 200 0 0 0 0 0',
      '@@MEM',
      'MemTotal:        16384000 kB',
      'MemAvailable:     8192000 kB',
      'SwapTotal:        4194304 kB',
      'SwapFree:         2097152 kB',
      '@@NET',
      ' eth0: 1000000 1000 0 0 0 0 0 0 2000000 2000 0 0 0 0 0 0',
      '@@UP',
      '12345.67 24691.34',
      '@@LOAD',
      '0.50 0.25 0.10 1/150 12345',
      '@@DISK',
      'Filesystem 1K-blocks Used Available Use% Mounted on',
      '/dev/sda1 100000000 40000000 60000000 40% /',
      '@@PROC',
      '  PID  UTIME  STIME   RSS COMMAND',
      ' 1001     50     30 102400 nginx', // 80 ticks
      ' 1002    700    100  51200 node',  // 800 ticks
      '@@IP',
      '192.168.1.100',
      '@@END'
    ].join('\n')

    const mockOutputWithTicks2 = [
      '@@CPU',
      'cpu  15000 200 3000 85000 200 0 0 0 0 0',
      '@@MEM',
      'MemTotal:        16384000 kB',
      'MemAvailable:     8192000 kB',
      'SwapTotal:        4194304 kB',
      'SwapFree:         2097152 kB',
      '@@NET',
      ' eth0: 1000000 1000 0 0 0 0 0 0 2000000 2000 0 0 0 0 0 0',
      '@@UP',
      '12347.67 24695.34',
      '@@LOAD',
      '0.50 0.25 0.10 1/150 12345',
      '@@DISK',
      'Filesystem 1K-blocks Used Available Use% Mounted on',
      '/dev/sda1 100000000 40000000 60000000 40% /',
      '@@PROC',
      '  PID  UTIME  STIME   RSS COMMAND',
      // dt = 2.0s
      ' 1001     70     50 102400 nginx', // 120 ticks (delta = 40 ticks -> 40 / 2.0 = 20% CPU)
      ' 1002    800    200  51200 node',  // 1000 ticks (delta = 200 ticks -> 200 / 2.0 = 100% CPU)
      '@@IP',
      '192.168.1.100',
      '@@END'
    ].join('\n')

    const state: MonitorState = {}
    
    // First sample (sets baseline)
    state.prevTime = Date.now() - 2000
    parseMonitorOutput(mockOutputWithTicks1, state)
    
    // Second sample (exactly 2.0 seconds later)
    state.prevTime = Date.now() - 2000
    const snapshot = parseMonitorOutput(mockOutputWithTicks2, state)

    expect(snapshot).not.toBeNull()
    if (!snapshot) return

    expect(snapshot.procs).toHaveLength(2)
    // Sorted by CPU descending: pid 1002 (100.0% CPU) comes first, then pid 1001 (20.0% CPU)
    expect(snapshot.procs[0].pid).toBe(1002)
    expect(snapshot.procs[0].cpu).toBe(100.0)
    expect(snapshot.procs[1].pid).toBe(1001)
    expect(snapshot.procs[1].cpu).toBe(20.0)
  })

  it('should handle edge cases: CPU sorting, tie-breaking, command name spaces, PID reuse, and process exit', () => {
    const mockOutputEdge1 = [
      '@@CPU',
      'cpu  10000 200 3000 80000 200 0 0 0 0 0',
      '@@MEM',
      'MemTotal:        16384000 kB',
      'MemAvailable:     8192000 kB',
      'SwapTotal:        4194304 kB',
      'SwapFree:         2097152 kB',
      '@@NET',
      ' eth0: 1000000 1000 0 0 0 0 0 0 2000000 2000 0 0 0 0 0 0',
      '@@UP',
      '12345.67 24691.34',
      '@@LOAD',
      '0.50 0.25 0.10 1/150 12345',
      '@@DISK',
      '/dev/sda1 100000000 40000000 60000000 40% /',
      '@@PROC',
      '  PID  UTIME  STIME   RSS COMMAND',
      ' 2001     10     10  10000 process A with spaces', // 20 ticks
      ' 2002     30     20  50000 process B',             // 50 ticks
      ' 2003    100    100  20000 process C',             // 200 ticks
      ' 2004     50     50  30000 process D',             // 100 ticks
      '@@IP',
      '192.168.1.100',
      '@@END'
    ].join('\n')

    const mockOutputEdge2 = [
      '@@CPU',
      'cpu  15000 200 3000 85000 200 0 0 0 0 0',
      '@@MEM',
      'MemTotal:        16384000 kB',
      'MemAvailable:     8192000 kB',
      'SwapTotal:        4194304 kB',
      'SwapFree:         2097152 kB',
      '@@NET',
      ' eth0: 1000000 1000 0 0 0 0 0 0 2000000 2000 0 0 0 0 0 0',
      '@@UP',
      '12347.67 24695.34',
      '@@LOAD',
      '0.50 0.25 0.10 1/150 12345',
      '@@DISK',
      '/dev/sda1 100000000 40000000 60000000 40% /',
      '@@PROC',
      '  PID  UTIME  STIME   RSS COMMAND',
      // dt = 2.0s
      ' 2001     50     50  10000 process A with spaces', // 100 ticks (delta = 80 ticks -> 40.0% CPU)
      ' 2002     70     60  50000 process B',             // 130 ticks (delta = 80 ticks -> 40.0% CPU) -> Same CPU, higher RSS, should sort higher!
      ' 2003      5      5  20000 process C',             // PID Reuse: ticks dropped from 200 to 10! -> delta = -190 ticks -> CPU should clamp to 0.0%
      // 2004 (process D) exited / disappeared!
      '@@IP',
      '192.168.1.100',
      '@@END'
    ].join('\n')

    const state: MonitorState = {}
    
    // First sample (sets baseline)
    state.prevTime = Date.now() - 2000
    parseMonitorOutput(mockOutputEdge1, state)
    
    expect(state.prevProcs).toBeDefined()
    expect(state.prevProcs?.[2004]).toBe(100)

    // Second sample (exactly 2.0 seconds later)
    state.prevTime = Date.now() - 2000
    const snapshot = parseMonitorOutput(mockOutputEdge2, state)

    expect(snapshot).not.toBeNull()
    if (!snapshot) return

    // Verify process D (pid 2004) was pruned from state.prevProcs since it exited
    expect(state.prevProcs?.[2004]).toBeUndefined()

    // 3 processes remain
    expect(snapshot.procs).toHaveLength(3)

    // Sorted by CPU descending, then RSS descending:
    // 1st: process B (pid 2002, 40.0% CPU, 50000 RSS) - due to memory tie-break!
    expect(snapshot.procs[0].pid).toBe(2002)
    expect(snapshot.procs[0].cpu).toBe(40.0)
    expect(snapshot.procs[0].rss).toBe(50000)
    expect(snapshot.procs[0].cmd).toBe('process B')

    // 2nd: process A (pid 2001, 40.0% CPU, 10000 RSS) - command name with spaces parsed correctly!
    expect(snapshot.procs[1].pid).toBe(2001)
    expect(snapshot.procs[1].cpu).toBe(40.0)
    expect(snapshot.procs[1].rss).toBe(10000)
    expect(snapshot.procs[1].cmd).toBe('process A with spaces')

    // 3rd: process C (pid 2003, 0.0% CPU due to PID reuse clamping, 20000 RSS)
    expect(snapshot.procs[2].pid).toBe(2003)
    expect(snapshot.procs[2].cpu).toBe(0.0)
    expect(snapshot.procs[2].rss).toBe(20000)
  })
})
