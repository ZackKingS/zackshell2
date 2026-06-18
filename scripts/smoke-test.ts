// Live smoke test: drives the same code paths the Electron main process uses
// (ssh2 connect + shell channel + the real monitor command & parser) against a
// real server. Credentials come from env so they are never written to disk:
//
//   SSH_HOST=.. SSH_USER=.. SSH_PASS=.. npx tsx scripts/smoke-test.ts
//
import { Client } from 'ssh2'
import { MONITOR_CMD, parseMonitorOutput, type MonitorState } from '../src/main/sshManager'

const host = process.env.SSH_HOST ?? ''
const port = Number(process.env.SSH_PORT ?? 22)
const username = process.env.SSH_USER ?? 'root'
const password = process.env.SSH_PASS ?? ''

function exec(client: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', () => {})
      stream.on('close', () => resolve(out))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const client = new Client()

client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) =>
  finish(prompts.map(() => password))
)

client.on('error', (e) => {
  console.error('❌ [阶段二] 连接失败:', e.message)
  process.exit(1)
})

client.on('ready', async () => {
  console.log('✅ [阶段二] SSH 连接成功（密码认证）')

  // 1) exec channel
  const info = (await exec(client, 'whoami; hostname; uname -srm')).trim()
  console.log('✅ [阶段二] 远程命令 exec 正常:\n   ' + info.replace(/\n/g, '\n   '))

  // 2) monitor: two samples 2s apart so CPU% / net rates are real deltas
  const state: MonitorState = {}
  parseMonitorOutput(await exec(client, MONITOR_CMD), state) // prime
  await delay(2000)
  const snap = parseMonitorOutput(await exec(client, MONITOR_CMD), state)
  if (!snap) {
    console.error('❌ [阶段三] 监控解析失败（无 CPU 段）')
  } else {
    console.log('✅ [阶段三] 监控采集 + 解析正常:')
    console.log(
      `   CPU ${snap.cpu}%  内存 ${snap.mem.used}/${snap.mem.total}M  ` +
        `交换 ${snap.swap.used}/${snap.swap.total}M`
    )
    console.log(`   运行 ${Math.floor(snap.uptimeSec / 86400)}天  负载 ${snap.load.join(', ')}`)
    console.log(`   网络 ↑${snap.net.tx}B/s ↓${snap.net.rx}B/s   IP ${snap.ip}`)
    console.log('   网卡: ' + snap.interfaces.map((i) => `${i.name}(↑${i.tx} ↓${i.rx})`).join(', '))
    console.log(`   磁盘 ${snap.disks.length} 个挂载点, 进程 ${snap.procs.length} 个`)
    console.log('   TOP 进程: ' + snap.procs.slice(0, 3).map((p) => p.cmd).join(', '))
    console.log('   磁盘示例: ' + snap.disks.slice(0, 3).map((d) => `${d.mount}(${d.usePct}%)`).join(', '))
  }

  // 3) interactive shell channel
  client.shell({ term: 'xterm-256color' }, (err, stream) => {
    if (err) {
      console.error('❌ [阶段二] 开 shell 通道失败:', err.message)
      client.end()
      return
    }
    let buf = ''
    stream.on('data', (d: Buffer) => (buf += d.toString()))
    stream.write('echo SHELL_OK_$((40 + 2))\n')
    setTimeout(() => {
      console.log(
        buf.includes('SHELL_OK_42')
          ? '✅ [阶段二] 交互式 shell 通道正常（命令回显 + 执行）'
          : '⚠️ [阶段二] shell 未匹配预期输出:\n' + buf.slice(-300)
      )
      stream.end()
      client.end()
      console.log('\n— 测试结束 —')
    }, 1500)
  })
})

console.log(`连接 ${username}@${host}:${port} ...`)
client.connect({ host, port, username, password, readyTimeout: 20000, tryKeyboard: true })
