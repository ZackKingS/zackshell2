import { resolve } from 'path'
import { networkInterfaces } from 'os'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Pick the machine's real LAN IPv4 so the dev server is served on an IP
// instead of localhost. Falls back to 127.0.0.1. Override with RENDERER_HOST.
function lanHost(): string {
  if (process.env.RENDERER_HOST) return process.env.RENDERER_HOST
  const skip = /(loopback|tun|tap|veth|virtual|vmware|vbox|hyper|wsl|docker|simplehy)/i
  const candidates: string[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue
    for (const ni of addrs ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) candidates.push(ni.address)
    }
  }
  // Prefer common private ranges in order: 192.168.x > 10.x > 172.16-31.x.
  const rank = (ip: string): number =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3
  candidates.sort((a, b) => rank(a) - rank(b))
  return candidates[0] ?? '127.0.0.1'
}

const HOST = lanHost()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    server: {
      host: HOST,
      port: 5173,
      strictPort: true
    },
    plugins: [react()]
  }
})
