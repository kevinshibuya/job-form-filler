import { MailError } from './account.js'

/**
 * The Native host's outbound network, in one function (spec #66). It is the
 * host's first network use, and it reaches Google's sign-in, token and Gmail
 * endpoints and nothing else. Tests pass their own `HttpCall`.
 */
export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type HttpCall = (req: HttpRequest) => Promise<HttpResponse>

/** Google's sign-in, token and Gmail endpoints: every origin the host may call. */
export const GOOGLE_ORIGINS: readonly string[] = [
  'https://accounts.google.com',
  'https://oauth2.googleapis.com',
  'https://gmail.googleapis.com',
]

/** A call to any other origin is refused before it leaves the host. */
export function googleOnly(call: HttpCall): HttpCall {
  return async (req) => {
    let origin: string
    try { origin = new URL(req.url).origin } catch { origin = '' }
    if (!GOOGLE_ORIGINS.includes(origin)) throw new MailError('process', `refused a call outside Google's endpoints: ${origin || 'not an address'}`)
    return call(req)
  }
}

/** How long one call to Google may take. */
const CALL_TIMEOUT_MS = 30_000

/** The real network: Node's fetch. */
export const realHttp: HttpCall = async (req) => {
  const res = await fetch(req.url, {
    method: req.method, headers: req.headers, body: req.body, redirect: 'error', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() }
}
