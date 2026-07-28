#!/usr/bin/env node
// Installs the native-messaging host. This is a CLI, not the host: printing is fine.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNativeManifest, buildWrapperScript, nativeManifestPath } from '../dist/install/templates.js'

const here = dirname(fileURLToPath(import.meta.url))
const hostRoot = resolve(here, '..')
const repoRoot = resolve(hostRoot, '..')

// 1) Node: use the interpreter running this script, and require >= 20.
const nodePath = process.execPath
const major = Number(process.version.replace(/^v/, '').split('.')[0])
if (!Number.isFinite(major) || major < 20) {
  console.error(`Node ${process.version} is too old. job-form-filler requires Node >= 20.`)
  process.exit(1)
}

// 2) claude: resolve through a login shell, since this script may run from one.
let claudePath = ''
try {
  claudePath = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim()
} catch {
  claudePath = ''
}
if (claudePath === '') {
  console.error('Could not find the `claude` CLI on PATH. Install it, then re-run this script.')
  process.exit(1)
}

// 3) the built host entry point must exist
const entryPath = resolve(hostRoot, 'dist/index.js')
if (!existsSync(entryPath)) {
  console.error(`Missing ${entryPath}. Run \`npm run build -w @jff/host\` first.`)
  process.exit(1)
}

// 4) the pinned extension id
const extensionIdPath = resolve(repoRoot, 'extension/extension-id.txt')
if (!existsSync(extensionIdPath)) {
  console.error(`Missing ${extensionIdPath}. Generate the extension key first (plan Task 3, Step 1).`)
  process.exit(1)
}
const extensionId = readFileSync(extensionIdPath, 'utf8').trim()
if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error(`extension-id.txt does not look like a Chrome extension id: ${extensionId}`)
  process.exit(1)
}

// 5) write the wrapper
const wrapperPath = resolve(hostRoot, 'bin/jff-host.sh')
mkdirSync(dirname(wrapperPath), { recursive: true })
writeFileSync(wrapperPath, buildWrapperScript({ nodePath, entryPath }))
chmodSync(wrapperPath, 0o755)

// 6) write the host config (claude path + db path)
const homeDir = resolve(homedir(), '.job-form-filler')
mkdirSync(homeDir, { recursive: true })
writeFileSync(resolve(homeDir, 'config.json'), JSON.stringify({
  claudePath,
  dbPath: resolve(homeDir, 'db.sqlite'),
}, null, 2) + '\n')

// 7) register with Chrome
const manifestPath = nativeManifestPath(homedir())
mkdirSync(dirname(manifestPath), { recursive: true })
writeFileSync(manifestPath, buildNativeManifest({ wrapperPath, extensionId }))

console.log('job-form-filler host installed.')
console.log(`  node        ${nodePath} (${process.version})`)
console.log(`  claude      ${claudePath}`)
console.log(`  wrapper     ${wrapperPath}`)
console.log(`  db          ${resolve(homeDir, 'db.sqlite')}`)
console.log(`  chrome      ${manifestPath}`)
console.log(`  extension   ${extensionId}`)
console.log('')
console.log('Next: fully quit and reopen Chrome, load extension/dist as an unpacked extension,')
console.log('then open the side panel and confirm the self-check banner is green.')
