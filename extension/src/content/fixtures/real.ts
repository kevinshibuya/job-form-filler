/**
 * Test helper: loads a real-page fixture into the test DOM. A real-page fixture
 * is the application form of a public page and nothing else of it, cut by
 * `scripts/sanitize-capture.mjs` and kept in `e2e/fixtures/real/`. A posting
 * fixture is the Job posting of a public posting page, cut with `--posting` and
 * kept apart in `e2e/fixtures/postings/`, because it holds no Field. Tests only:
 * nothing the extension ships imports this.
 */

// Vite inlines every fixture as a string at transform time, so the helper needs
// no file system and type-checks with the extension's own types.
const PAGES = import.meta.glob<string>('../../../../e2e/fixtures/real/*.html', { query: '?raw', import: 'default', eager: true })
const POSTINGS = import.meta.glob<string>('../../../../e2e/fixtures/postings/*.html', { query: '?raw', import: 'default', eager: true })

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.html$/, '')
}

function byName(pages: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(pages).map(([path, html]) => [nameOf(path), html]))
}

const BY_NAME = byName(PAGES)
const POSTINGS_BY_NAME = byName(POSTINGS)

/** The names `loadRealFixture` accepts, without the `.html`. */
export const REAL_FIXTURES: readonly string[] = [...BY_NAME.keys()].sort()

/** The names `loadPostingFixture` accepts, without the `.html`. */
export const POSTING_FIXTURES: readonly string[] = [...POSTINGS_BY_NAME.keys()].sort()

function load(html: string): void {
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '')
}

/** Replaces the test document with the named fixture; `name` may carry `.html`. */
export function loadRealFixture(name: string): void {
  const html = BY_NAME.get(name.replace(/\.html$/, ''))
  if (html === undefined) throw new Error(`no real-page fixture named ${name}; there are: ${REAL_FIXTURES.join(', ')}`)
  load(html)
}

/** The named posting fixture's file as it is on disk, as a server would send
 *  it; `name` may carry `.html`. */
export function postingFixtureHtml(name: string): string {
  const html = POSTINGS_BY_NAME.get(name.replace(/\.html$/, ''))
  if (html === undefined) throw new Error(`no posting fixture named ${name}; there are: ${POSTING_FIXTURES.join(', ') || 'none'}`)
  return html
}

/** Replaces the test document with the named posting fixture; `name` may carry `.html`. */
export function loadPostingFixture(name: string): void {
  load(postingFixtureHtml(name))
}
