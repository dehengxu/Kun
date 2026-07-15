import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const scriptsRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptsRoot, '..')
const requestedPort = Number(process.env.KUN_ELECTRON_VITE_PORT)

if (!Number.isSafeInteger(requestedPort) || requestedPort <= 0 || requestedPort > 65_535) {
  throw new Error('KUN_ELECTRON_VITE_PORT must select a valid development renderer port')
}

export default defineConfig({
  root: resolve(repositoryRoot, 'src', 'renderer'),
  resolve: {
    alias: {
      '@renderer': resolve(repositoryRoot, 'src', 'renderer', 'src'),
      '@shared': resolve(repositoryRoot, 'src', 'shared')
    }
  },
  server: {
    host: '127.0.0.1',
    port: requestedPort,
    strictPort: true
  },
  plugins: [react()]
})
