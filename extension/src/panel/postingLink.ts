import { captureJobText } from '../content/jobpost'
import { POSTING_FETCH_TIMEOUT_MS, type FetchLike } from '../content/postingFetch'

/**
 * The posting's link (spec #98, ticket #104): the address of a Job posting
 * that sits on another page, typed by the user into its own box. The Side
 * panel fetches only that address, never a link found on a page.
 */

/** The largest body the read accepts, in bytes. */
export const POSTING_LINK_MAX_BYTES = 2 * 1024 * 1024

/** The one message for a link that gives no posting, whatever the reason. */
export const LINK_FAILED = 'No job description could be read at that link. Paste the text instead.'

/** The message for an address the box refuses: nothing is fetched. */
export const LINK_REFUSED = 'Only an http or https address can be read.'

/** The typed address, normalised, when it is an `http` or `https` address;
 *  null for any other scheme and for text that is no address. */
export function postingLinkAddress(typed: string): string | null {
  let url: URL
  try { url = new URL(typed.trim()) } catch { return null }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}

/** The body as text, or null when it is, or says it is, over the cap. */
async function bodyUpTo(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) return null
  const chunks: Uint8Array[] = []
  let size = 0
  if (res.body === null) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > max) return null
    chunks.push(bytes)
  } else {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) { void reader.cancel().catch(() => {}); return null }
      chunks.push(value)
    }
  }
  const decoder = decoderFor(res.headers.get('content-type'))
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode()
}

/** The decoder of the reply's declared charset, or UTF-8. */
function decoderFor(contentType: string | null): TextDecoder {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType ?? '')?.[1]
  try { return new TextDecoder(charset ?? 'utf-8') } catch { return new TextDecoder('utf-8') }
}

async function read(address: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<string | null> {
  const res = await fetchImpl(address, { credentials: 'omit', redirect: 'follow', signal })
  if (!res.ok) return null
  const html = await bodyUpTo(res, POSTING_LINK_MAX_BYTES)
  if (html === null) return null
  // A parsed document runs no script and loads nothing.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // No form element's content counts as Job posting text.
  for (const form of Array.from(doc.querySelectorAll('form'))) form.remove()
  // The page heuristic, held to the minimum and cut to the cap.
  const reply = captureJobText(doc, null, [])
  return reply.source === 'heuristic' ? reply.text : null
}

/**
 * The Job posting text at the address the user typed, or null. The fetch
 * sends no cookies, follows redirects, and is given up, body included, after
 * the posting-page read's timeout; a body over POSTING_LINK_MAX_BYTES is
 * refused. Any failure is null. Never throws.
 */
export async function readPostingLink(address: string, fetchImpl: FetchLike): Promise<string | null> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => { abort.abort(); resolve(null) }, POSTING_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([read(address, abort.signal, fetchImpl), limit])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
