import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from "path"

// Dev server: UI is on :5173, API usually uvicorn on another port — proxy so relative /admin and /v1 work.
const devApiTarget = process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:8000"

// https://vite.dev/config/
export default defineConfig({
  base: '/ui/',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/admin": { target: devApiTarget, changeOrigin: true },
      "/v1": { target: devApiTarget, changeOrigin: true },
      "/health": { target: devApiTarget, changeOrigin: true },
    },
  },
})
