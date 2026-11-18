import { beforeEach, describe, expect, it } from 'vitest'
import { cleanForPrivacy, cutToFixture } from '@jff/shared'

// The cleaning code the page script will run on its copy of the page, run here
// in the extension's own test DOM: this proves the page script can import it.

const PAGE = `<head><title>Apply</title><script>window.cfg = {}</script></head><body>
  <header id="top"><nav><a id="home" href="https://acme.example.org/">Home</a></nav></header>
  <main>
    <div class="job-description"><p>Long posting prose.</p></div>
    <form id="apply" action="https://acme.example.org/apply">
      <label for="name">Name</label><input id="name" name="name" type="text">
      <label><input id="agree" type="checkbox" name="agree" value="yes">I agree</label>
      <select id="country" name="country"><option>Brazil</option><option>Canada</option></select>
      <a id="privacy" href="https://acme.example.org/privacy" data-url="https://acme.example.org/x">Privacy</a>
      <script>track()</script>
      <!-- rendered for this board -->
    </form>
  </main>
  <footer id="bottom"><p>1 Main Street</p></footer>
</body>`

/** The page as the applicant left it: a typed Value, a ticked box, a chosen Option. */
function loadFilledPage(): void {
  document.documentElement.innerHTML = PAGE
  ;(document.getElementById('name') as HTMLInputElement).value = 'Ada Lovelace'
  ;(document.getElementById('agree') as HTMLInputElement).checked = true
  ;(document.getElementById('country') as HTMLSelectElement).value = 'Canada'
}

function commentsIn(root: Node): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  let count = 0
  while (walker.nextNode()) count += 1
  return count
}

beforeEach(loadFilledPage)

describe('cleanForPrivacy in the test DOM', () => {
  it('removes a typed Value, a ticked box, a chosen Option, a script and an address attribute', () => {
    cleanForPrivacy(document)
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('')
    expect((document.getElementById('agree') as HTMLInputElement).checked).toBe(false)
    const options = Array.from((document.getElementById('country') as HTMLSelectElement).options)
    expect(options.filter((o) => o.selected).map((o) => o.text)).not.toContain('Canada')
    expect(document.querySelector('script')).toBeNull()
    expect(document.getElementById('apply')?.getAttribute('action') ?? '').toBe('')
    expect(document.getElementById('privacy')?.getAttribute('href') ?? '').toBe('')
    expect(document.getElementById('privacy')?.getAttribute('data-url') ?? '').toBe('')
    expect(document.documentElement.outerHTML).not.toContain('acme.example.org')
    expect(commentsIn(document)).toBe(0)
  })

  it('keeps the whole page\'s structure', () => {
    cleanForPrivacy(document)
    for (const id of ['top', 'home', 'apply', 'name', 'agree', 'country', 'privacy', 'bottom']) {
      expect(document.getElementById(id)).not.toBeNull()
    }
    expect(document.querySelector('.job-description')?.textContent).toContain('Long posting prose.')
  })
})

describe('cutToFixture in the test DOM', () => {
  it('cuts the page to the form and its ancestors', () => {
    cleanForPrivacy(document)
    expect(cutToFixture(document, [])).toBe(true)
    const form = document.getElementById('apply')!
    expect(form).not.toBeNull()
    const outside = Array.from(document.body.querySelectorAll('*')).filter((el) => !form.contains(el) && !el.contains(form))
    expect(outside.map((el) => el.tagName)).toEqual([])
    expect(document.getElementById('top')).toBeNull()
    expect(document.getElementById('bottom')).toBeNull()
    expect(document.title).toContain('Acme')
  })
})
