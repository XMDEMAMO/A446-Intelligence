import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.HUB_HTTP_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest) => {
            const token = process.env.HUB_TOKEN
            if (token) proxyRequest.setHeader('Authorization', 'Bearer ' + token)
          })
        },
      },
    },
  },
})
