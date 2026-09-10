/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The whole app (React/ExcelJS bundle, CSS, the process worker, and the default
// template) builds into ONE self-contained index.html with no external requests —
// so it works identically hosted on GitHub Pages and opened locally via file://
// (double-click, no server, no install) for colleagues whose network blocks
// *.github.io outright. See process.worker.ts's `?worker&inline` import and
// template-zalivka.xlsx's `?inline` import for the other two pieces of this.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // .xlsx isn't one of Vite's built-in recognized asset extensions — without this,
  // the `?inline` import of the bundled template is parsed as JS instead of treated
  // as a static asset to inline.
  assetsInclude: ['**/*.xlsx'],
  worker: {
    // Self-contained (no ES import statements) so it inlines cleanly as a data: URL
    // worker — an ES-module worker loaded from a data: URL is flaky across browsers.
    format: 'iife',
  },
  test: {
    environment: 'node',
  },
})
