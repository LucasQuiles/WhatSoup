import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFleetTokenForDevProxy } from './vite.fleet-token.ts'

// Read fleet token for dev proxy auth injection
const fleetToken = readFleetTokenForDevProxy()

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // SSE auth endpoint needs special handling — no response buffering
      '/api/lines': {
        target: 'http://127.0.0.1:9099',
        changeOrigin: true,
        headers: fleetToken ? { 'Authorization': `Bearer ${fleetToken}` } : {},
        configure: (proxy) => {
          // Disable response buffering for SSE streams
          proxy.on('proxyRes', (proxyRes) => {
            const ct = proxyRes.headers['content-type'] ?? ''
            if (ct.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache'
              proxyRes.headers['x-accel-buffering'] = 'no'
            }
          })
        },
      },
      '/api': {
        target: 'http://127.0.0.1:9099',
        changeOrigin: true,
        headers: fleetToken ? { 'Authorization': `Bearer ${fleetToken}` } : {},
      },
    },
  },
})
