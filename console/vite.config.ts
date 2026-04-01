import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Read fleet token for dev proxy auth injection
let fleetToken = ''
try {
  fleetToken = readFileSync(join(homedir(), '.config/whatsoup/fleet-token'), 'utf-8').trim()
} catch { /* no token file — proxy will forward without auth */ }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9099',
        changeOrigin: true,
        headers: fleetToken ? { 'Authorization': `Bearer ${fleetToken}` } : {},
      },
    },
  },
})
