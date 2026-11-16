/**
 * Test helper for the `listing-language-dropdown` fixture (#53): a job listing
 * page that holds a language dropdown and no application form. Tests only.
 */
import { loadRealFixture } from './real'

export const LISTING_FIXTURE = 'listing-language-dropdown'

/**
 * Loads the listing fixture with its dropdown holding a Value. The fixture
 * command clears every selection, so a dropdown whose first Option is a prompt
 * holds no Value after the cut; the live page always shows its language, so
 * the first real Option is selected, as the page would have.
 */
export function loadListingFixture(): void {
  loadRealFixture(LISTING_FIXTURE)
  for (const select of Array.from(document.querySelectorAll('select'))) {
    const current = select.selectedOptions[0]
    if (current !== undefined && current.value !== '' && !current.disabled) continue
    const real = Array.from(select.options).find((o) => o.value !== '' && !o.disabled)
    if (real !== undefined) real.selected = true
  }
}
