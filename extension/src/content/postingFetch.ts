import { JOB_TEXT_MAX, JOB_TEXT_MIN, type AtsModule } from '@jff/shared'
import { textOf } from './textOf'

/** How long the page script waits for a Job posting page, body included. */
export const POSTING_FETCH_TIMEOUT_MS = 5_000

/** The part of `fetch` the posting read uses; a test hands in a stub. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

interface Target { url: URL; spot: string }

/** The posting page the module's rule gives for this form page, or null when
 *  it gives none or gives one on another origin than the form page's. */
function targetOf(module: AtsModule, formPageUrl: string): Target | null {
  const rule = module.jobText?.postingPage
  if (rule === undefined) return null
  try {
    const posting = rule(formPageUrl)
    if (posting === null) return null
    const form = new URL(formPageUrl)
    const url = new URL(posting.url, form)
    // The page script fetches on its own frame's origin only, whatever a rule says.
    if (url.origin !== form.origin) return null
    return { url, spot: posting.spot }
  } catch {
    return null
  }
}

async function read(target: Target, origin: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<string | null> {
  const res = await fetchImpl(target.url.href, { credentials: 'omit', signal })
  if (!res.ok) return null
  // A redirect that left the origin is not the posting this frame asked for.
  if (res.url !== '' && new URL(res.url).origin !== origin) return null
  const html = await res.text()
  // A parsed document runs no script and loads nothing.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const el = doc.querySelector(target.spot)
  if (el === null) return null
  const text = textOf(el)
  return text.length >= JOB_TEXT_MIN ? text.slice(0, JOB_TEXT_MAX) : null
}

/**
 * The Job posting text from the posting's own page (spec #41), for a form page
 * that holds none, or null. The module's rule gives the page and the spot. The
 * fetch is refused unless the page has the form page's origin, sends no
 * cookies, and is given up after POSTING_FETCH_TIMEOUT_MS. Any failure is null,
 * so the order goes on to the next source. Never throws.
 */
export async function fetchPostingText(module: AtsModule, formPageUrl: string, fetchImpl: FetchLike): Promise<string | null> {
  const target = targetOf(module, formPageUrl)
  if (target === null) return null
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => { abort.abort(); resolve(null) }, POSTING_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([read(target, target.url.origin, abort.signal, fetchImpl), limit])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
