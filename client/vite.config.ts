import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the React app runs on :5173 and forwards API + WebSocket traffic
// to the backend (a single server, or the load balancer when using `npm run cluster`).
const backend = process.env.BACKEND_URL ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1500 },
  // Pre-bundle lazily imported libraries so their first use doesn't trigger a dev-server reload.
  optimizeDeps: { include: ['pdfmake/build/pdfmake', 'pdfmake/build/vfs_fonts', 'mammoth/mammoth.browser', 'marked'] },
  server: {
    port: 5173,
    // Listen on the local network too, so other laptops/phones on the same Wi-Fi can open
    // http://<this-computer's-IP>:5173 (Vite prints the "Network:" address when it starts).
    host: true,
    // Allow tunnel hostnames (ngrok / Cloudflare Tunnel) for demos over the internet.
    allowedHosts: true,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
})
