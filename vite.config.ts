/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves this as a project site under /kcell-stock-optimizer/, not the
// domain root — the build workflow sets GH_PAGES=true so asset URLs resolve there.
// Netlify and local dev both serve from root, so this stays '/' for them.
const base = process.env.GH_PAGES === 'true' ? '/kcell-stock-optimizer/' : '/'

export default defineConfig({
  base,
  plugins: [react()],
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
  },
})
