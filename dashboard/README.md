
# Beatair Dashboard (v3)

This build fixes the "Failed to fetch" issue by:
- Preferring **relative** API calls in dev (so Vite **proxy** handles CORS and WebSocket).
- Removing `credentials: 'include'` to avoid strict CORS.
- Proxying **/socket.io** WS in `vite.config.js`.

## Quickstart
```bash
cd dashboard
cp .env.example .env   # leave VITE_SERVER_URL empty in dev, use the proxy to http://localhost:3001
npm i
npm run dev
```

If your server is on another host:
- Set `VITE_SERVER_URL=http://<server>:3001` in `.env`.
- The app will use that for both REST and Socket.IO.

Troubleshooting tips show in the sidebar (API bases tried, socket base, last error).
