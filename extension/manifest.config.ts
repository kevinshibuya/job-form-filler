import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineManifest } from '@crxjs/vite-plugin'

const here = dirname(fileURLToPath(import.meta.url))
const key = readFileSync(resolve(here, 'key.pub.b64'), 'utf8').trim()

// defineManifest (not `as const`): crx() wants mutable arrays, and the helper
// typechecks the manifest shape for us.
export default defineManifest({
  manifest_version: 3,
  name: 'job-form-filler',
  version: '1.0.0',
  description: 'Fills job application forms from a local answer memory. Never submits.',
  // Pins the extension ID. Native messaging allowed_origins cannot wildcard, so a
  // drifting ID silently breaks the host connection.
  key,
  permissions: ['nativeMessaging', 'sidePanel', 'storage', 'scripting', 'tabs'],
  // <all_urls> (not activeTab): embedded ATS forms are cross-origin iframes, which
  // activeTab deliberately excludes. Injection is still on demand (Scan button).
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background.ts', type: 'module' },
  side_panel: { default_path: 'src/panel/index.html' },
  action: { default_title: 'Open job-form-filler' },
  // NO web_accessible_resources: content.js is injected with
  // executeScript({ files }), which reads the extension's own bundle directly.
})
