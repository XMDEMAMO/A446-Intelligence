import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function lanAccessGuard(): Plugin {
  return {
    name: 'a446-lan-access-guard',
    configureServer(server) {
      server.middlewares.use('/api', (request, response, next) => {
        if (process.env.VITE_LAN_MODE !== 'true') return next()
        const expected = process.env.HUB_TOKEN?.trim()
        if (!expected) return next()
        const raw = request.headers['x-a446-lan-token']
        const supplied = Array.isArray(raw) ? raw[0] : raw
        if (supplied === expected) return next()
        response.statusCode = 401
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({ error: 'LAN pairing token required', code: 'LAN_TOKEN_REQUIRED' }))
      })
    },
  }
}

export default defineConfig({
  plugins: [lanAccessGuard(), react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.HUB_HTTP_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        headers: process.env.HUB_TOKEN?.trim()
          ? { Authorization: `Bearer ${process.env.HUB_TOKEN.trim()}` }
          : undefined,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
