import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * One server per fixture ROOT. Called twice it binds two random ports, which is
 * the only way to get a genuinely CROSS-ORIGIN iframe out of a static harness
 * (127.0.0.1:a embedding 127.0.0.1:b). The default keeps every existing caller
 * unchanged.
 */
export async function startFixtureServer(root = 'fixtures/greenhouse-apply'): Promise<{ origin: string; stop: () => Promise<void>; server: Server }> {
  const ROOT = resolve(here, root)
  const server = createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '') || 'fixture-form.html'
    if (name.includes('..')) { res.writeHead(400).end('bad path'); return }
    // Chromium's new headless mode auto-requests /favicon.ico on every navigation.
    // A 404 there surfaces as a page console error and would fail the smoke's
    // zero-console-errors assertion for a reason that has nothing to do with the
    // extension. Answer it with an empty 204 instead.
    if (name === 'favicon.ico') { res.writeHead(204).end(); return }
    readFile(resolve(ROOT, name))
      .then((buf) => {
        const type = extname(name) === '.json' ? 'application/json' : 'text/html; charset=utf-8'
        res.writeHead(200, { 'content-type': type }).end(buf)
      })
      .catch(() => res.writeHead(404).end('not found'))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr == null || typeof addr === 'string') throw new Error('server did not bind a port')
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    server,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }
}
