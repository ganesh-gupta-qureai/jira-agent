import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone: served at '/'. Behind a reverse proxy, set VITE_BASE.
// `base` makes built asset URLs prefix-aware; the same prefix is used
// for /api/* fetches via `import.meta.env.BASE_URL` in code.
const BASE = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base: BASE,
  plugins: [react()],
  server: {
    host: true,
    // Allow requests proxied from qhive's backend container.
    allowedHosts: true,
    // When dev-running standalone, Vite still proxies /api → FastAPI.
    // Path is rewritten so requests like `${BASE}api/chat` reach `/api/chat` upstream.
    proxy: {
      [`${BASE}api`]: {
        target: process.env.BACKEND_URL ?? 'http://127.0.0.1:4003',
        changeOrigin: true,
        rewrite: (p) => p.replace(new RegExp(`^${BASE}api`), '/api'),
      },
    },
  },
})
