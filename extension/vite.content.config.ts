import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false, // runs AFTER the crxjs build; must not wipe it
    target: 'chrome120',
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      name: 'JffContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
    rollupOptions: { output: { extend: true } },
  },
})
