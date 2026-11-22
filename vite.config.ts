import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'))

export default defineConfig({
  root: resolve(import.meta.dirname, 'web-src'),
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'web-src/src') },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:6098',
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'web'),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
  },
})
