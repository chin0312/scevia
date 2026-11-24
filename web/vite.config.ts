import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Design tokens live outside the app (../design-system) — the single source of truth.
const designSystem = fileURLToPath(new URL('../design-system', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@ds': designSystem } },
  server: { port: 5173, fs: { allow: ['..'] } },
})
