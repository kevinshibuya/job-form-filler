import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  // Order matters: tailwindcss() must run BEFORE crx(), which rewrites HTML
  // entries and asset URLs. React first so JSX is transformed for class scanning.
  plugins: [react(), tailwindcss(), crx({ manifest })],
  // Compile-time test seam (Task 18): a release build (JFF_TEST_SEAM unset) defines
  // this false, which dead-code-eliminates the fake host port from the bundle.
  // Browser smokes build with JFF_TEST_SEAM=1. No runtime switch ships.
  define: { __JFF_TEST_SEAM__: JSON.stringify(process.env.JFF_TEST_SEAM === '1') },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
  },
})
