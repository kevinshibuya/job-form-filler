import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MailError } from './account.js'

/**
 * The listener Google's sign-in returns to (spec #66). It binds to loopback
 * only, on a port the system picks, and takes one return: the first request
 * for `/` settles it, and the listener closes. A return whose `state` is not
 * the one this sign-in sent is refused, and it connects nothing.
 */
export interface LoopbackListener {
  /** `http://127.0.0.1:<port>`, the sign-in's return address. */
  redirectUri: string
  /** The authorization code, once the sign-in returns with the right state. */
  code: Promise<string>
  /** Closes the listener; `code` rejects with this error unless it settled. */
  close(reason: MailError): void
}

const LOOPBACK = '127.0.0.1'

function page(res: ServerResponse, status: number, text: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>job-form-filler</title><p>${text}</p>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
  res.end(html)
}

export async function startLoopbackListener(expectedState: string): Promise<LoopbackListener> {
  const server = createServer()
  let resolve!: (code: string) => void
  let reject!: (e: MailError) => void
  const code = new Promise<string>((ok, fail) => { resolve = ok; reject = fail })
  let settled = false

  const settle = (outcome: () => void, now = false): void => {
    if (settled) return
    settled = true
    outcome()
    server.close()
    // A return's own connection ends after its page (connection: close); an
    // early close also cuts the connections still open.
    if (now) server.closeAllConnections()
  }

  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`)
    if (settled || req.method !== 'GET' || url.pathname !== '/') {
      page(res, 404, 'Not found.')
      return
    }
    const q = url.searchParams
    if (q.get('state') !== expectedState) {
      page(res, 400, 'This sign-in is not the one the settings page started. Nothing was connected. Go back to the settings page and click Connect again.')
      settle(() => reject(new MailError('bad_request', 'The sign-in came back with a state that does not match the one sent. Nothing was connected. Click Connect again.')))
      return
    }
    const error = q.get('error')
    if (error !== null) {
      page(res, 200, 'The sign-in was not completed. Nothing was connected. You can close this tab.')
      settle(() => reject(new MailError('not_authed', `Google did not complete the sign-in (${error}). Nothing was connected.`)))
      return
    }
    const got = q.get('code')
    if (got === null || got === '') {
      page(res, 400, 'The sign-in came back without a code. Nothing was connected.')
      settle(() => reject(new MailError('bad_request', 'The sign-in came back without a code. Nothing was connected. Click Connect again.')))
      return
    }
    page(res, 200, 'Signed in. You can close this tab.')
    settle(() => resolve(got))
  })

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, LOOPBACK, () => { server.off('error', fail); ok() })
  })
  const { port } = server.address() as AddressInfo

  return {
    redirectUri: `http://${LOOPBACK}:${port}`,
    code,
    close: (reason) => settle(() => reject(reason), true),
  }
}
