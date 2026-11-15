/**
 * Test helper: loads a real-page fixture into the test DOM. A real-page fixture
 * is the application form of a public page and nothing else of it, cut by
 * `scripts/sanitize-capture.mjs` and kept in `e2e/fixtures/real/`. Tests only:
 * nothing the extension ships imports this.
 */

// Vite inlines every fixture as a string at transform time, so the helper needs
// no file system and type-checks with the extension's own types.
const PAGES = import.meta.glob<string>('../../../../e2e/fixtures/real/*.html', { query: '?raw', import: 'default', eager: true })

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.html$/, '')
}

const BY_NAME = new Map(Object.entries(PAGES).map(([path, html]) => [nameOf(path), html]))

/** The names `loadRealFixture` accepts, without the `.html`. */
export const REAL_FIXTURES: readonly string[] = [...BY_NAME.keys()].sort()

/** Replaces the test document with the named fixture; `name` may carry `.html`. */
export function loadRealFixture(name: string): void {
  const html = BY_NAME.get(name.replace(/\.html$/, ''))
  if (html === undefined) throw new Error(`no real-page fixture named ${name}; there are: ${REAL_FIXTURES.join(', ')}`)
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '')
}
