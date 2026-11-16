import { atsModule, findAts, JOB_TEXT_MAX, JOB_TEXT_MIN, type AtsModule, type JobTextReply } from '@jff/shared'
import { fetchPostingText, type FetchLike } from './postingFetch'
import { textOf } from './textOf'

export const MIN_JOB_TEXT = JOB_TEXT_MIN
const MAX_JOB_TEXT = JOB_TEXT_MAX

/** Hard ceiling on a pending element pick. A JFF_PICK promise that never settles
 *  would pin the runtime message channel open for the life of the frame. */
export const PICK_TIMEOUT_MS = 120_000

/** Ordered by specificity: a job-description-ish container beats a generic main. */
const HEURISTIC_TIERS = [
  '[class*="job-description" i], [id*="job-description" i], [class*="job_description" i], [id*="job_description" i], [data-testid*="description" i], [class*="descricao" i]',
  '[class*="job-post" i], [id*="job-post" i], [class*="posting" i], [class*="vaga" i]',
  'article, main, [role="main"]',
]


/** What the page script needs to read the Job posting text from the
 *  posting's own page: this frame's ATS module, its address, and a fetch. */
export interface PostingReader {
  readonly module: AtsModule
  readonly formPageUrl: string
  readonly fetch: FetchLike
}

/** The reader for the frame at `href`: the module of its own ATS, found from
 *  its own hostname as Enumeration finds it, so an embedded form's frame and
 *  the page around it never borrow each other's rule. */
export function postingReaderFor(href: string, fetch: FetchLike): PostingReader {
  let hostname = ''
  try { hostname = new URL(href).hostname } catch { /* no address, no ATS */ }
  return { module: atsModule(findAts(hostname)?.id), formPageUrl: href, fetch }
}

/**
 * The Job posting text of this frame (spec #41), in the page's part of the
 * order: the ATS module's posting page, then the spot the user picked, then a
 * heuristic. A posting page that gives nothing, or cannot be read in time,
 * hands over to the next source and never fails the Scan.
 */
export async function readJobText(root: Document, learnedSelector: string | null, posting: PostingReader): Promise<JobTextReply> {
  const fromAts = await fetchPostingText(posting.module, posting.formPageUrl, posting.fetch)
  if (fromAts !== null) return { text: fromAts, selector: null, source: 'ats' }
  return captureJobText(root, learnedSelector)
}

/**
 * The Job posting text on this page itself: the spot the user picked, then a
 * heuristic. Every source here must reach the minimum, and the text is cut to
 * the cap.
 */
export function captureJobText(root: Document, learnedSelector: string | null): JobTextReply {
  if (learnedSelector !== null && learnedSelector !== '') {
    try {
      const el = root.querySelector(learnedSelector)
      if (el !== null) {
        const t = textOf(el)
        if (t.length >= MIN_JOB_TEXT) return { text: t.slice(0, MAX_JOB_TEXT), selector: learnedSelector, source: 'learned' }
      }
    } catch {
      // an invalid stored selector must never throw the whole scan
    }
  }

  for (const tier of HEURISTIC_TIERS) {
    let best: { el: Element; text: string } | null = null
    for (const el of Array.from(root.querySelectorAll(tier))) {
      const t = textOf(el)
      if (t.length < MIN_JOB_TEXT) continue
      if (best === null || t.length > best.text.length) best = { el, text: t }
    }
    if (best !== null) return { text: best.text.slice(0, MAX_JOB_TEXT), selector: cssPathOf(best.el), source: 'heuristic' }
  }

  return { text: '', selector: null, source: 'none' }
}

/**
 * `CSS.escape` when the runtime provides it (every real browser this content script
 * ever runs in); jsdom, the extension unit-test environment, does not define a
 * global `CSS`, so this falls back to a minimal escape covering the identifier
 * characters ids/classes actually use. Production behavior is unaffected.
 */
function escapeIdent(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1')
}

/** A stable-enough selector for one element: id, else an nth-of-type path. */
export function cssPathOf(el: Element): string {
  if (el.id !== '') return `#${escapeIdent(el.id)}`
  const parts: string[] = []
  let node: Element | null = el
  while (node !== null && node !== document.documentElement) {
    if (node.id !== '') { parts.unshift(`#${escapeIdent(node.id)}`); break }
    const tag = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (parent === null) { parts.unshift(tag); break }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag)
    node = parent
  }
  return parts.join(' > ')
}

const HIGHLIGHT_STYLE = '2px solid #2f5bea'

/**
 * Element picker: the user clicks the element that holds the job text. The chosen
 * selector is saved per hostname so future scans on this host find it directly.
 *
 * `onPick` fires EXACTLY once: with the pick on click, or with `null` on Escape.
 * The null case is load-bearing — the JFF_PICK handler awaits this callback, and a
 * cancel that never called back would leave that promise pending forever.
 */
export function startPicker(root: Document, onPick: (pick: { selector: string; text: string } | null) => void): () => void {
  let last: HTMLElement | null = null
  const restore = new Map<HTMLElement, string>()

  const over = (e: Event): void => {
    const el = e.target
    if (!(el instanceof HTMLElement)) return
    if (last !== null && restore.has(last)) { last.style.outline = restore.get(last)!; restore.delete(last) }
    restore.set(el, el.style.outline)
    el.style.outline = HIGHLIGHT_STYLE
    last = el
  }

  const click = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.target
    if (!(el instanceof HTMLElement)) return
    stop()
    onPick({ selector: cssPathOf(el), text: textOf(el).slice(0, MAX_JOB_TEXT) })
  }

  const key = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    stop()
    onPick(null) // cancel, not silence: the caller's promise must settle
  }

  function stop(): void {
    for (const [el, outline] of restore) el.style.outline = outline
    restore.clear()
    last = null
    root.removeEventListener('mouseover', over, true)
    root.removeEventListener('click', click, true)
    root.removeEventListener('keydown', key as EventListener, true)
  }

  root.addEventListener('mouseover', over, true)
  root.addEventListener('click', click, true)
  root.addEventListener('keydown', key as EventListener, true)
  return stop
}
