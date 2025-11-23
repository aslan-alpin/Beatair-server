// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// If you want to tweak ports, do it here.
const API_TARGET = process.env.VITE_BEATAIR_API_PROXY || 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // everything your dashboard needs from the Beatair server
      '/health':  { target: API_TARGET, changeOrigin: true },
      '/auth':    { target: API_TARGET, changeOrigin: true },
      '/pair':    { target: API_TARGET, changeOrigin: true },
      '/admin':   { target: API_TARGET, changeOrigin: true },
      '/state':   { target: API_TARGET, changeOrigin: true, ws: true },
      '/devices': { target: API_TARGET, changeOrigin: true },
      '/search':  { target: API_TARGET, changeOrigin: true },
      '/vote':    { target: API_TARGET, changeOrigin: true },
      '/skip':    { target: API_TARGET, changeOrigin: true },
      '/pause':   { target: API_TARGET, changeOrigin: true },
      '/resume':  { target: API_TARGET, changeOrigin: true },
      '/identify':{ target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    outDir: 'dist',
  },
});