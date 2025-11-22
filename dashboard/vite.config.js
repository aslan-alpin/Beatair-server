
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const proxyTarget = 'http://localhost:3001'
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/socket.io': { target: proxyTarget, ws: true },
      '/state': proxyTarget,
      '/search': proxyTarget,
      '/devices': proxyTarget,
      '/device': proxyTarget,
      '/vote': proxyTarget,
      '/skip': proxyTarget,
      '/pause': proxyTarget,
      '/resume': proxyTarget,
      '/auth': { target: proxyTarget, changeOrigin: true },
      '/admin': proxyTarget,
    }
  }
})
