import { beforeEach, describe, expect, it } from 'vitest'
import { countryCandidates, yesNoCandidates, type EnumField, type FieldHandle } from '@jff/shared'
import { enumerateFields } from './enumerate'
import { fillFields } from './fill'
import { loadRealFixture } from './fixtures/real'
import { matchOption } from './optionMatch'

// Ticket #26: Fill picks the one Option equal to the Value or to one of its
// candidate words. The first block states the rule; the second runs Fill over
// real-page fixtures (spec #6, testing decision 1), sending the candidate words
// the rule table gives, as the Side panel does.

describe('matchOption', () => {
  it('picks the one Option equal to the Value', () => {
    expect(matchOption(['Brazil', 'Germany'], 'Germany')).toEqual({ found: 'one', index: 1 })
  })

  it('picks the one Option equal to a candidate word', () => {
    expect(matchOption(['Selecione', 'Alemanha', 'Brasil'], 'Germany', ['Germany', 'Alemanha'])).toEqual({ found: 'one', index: 1 })
  })

  it('compares as Fill does: case and spacing ignored, accents kept', () => {
    expect(matchOption(['  ESTADOS   unidos '], 'x', ['Estados Unidos'])).toEqual({ found: 'one', index: 0 })
    expect(matchOption(['Nao'], 'x', ['Não'])).toEqual({ found: 'none' })
  })

  it('matches candidate words by equality only, never by substring', () => {
    expect(matchOption(['United States Minor Outlying Islands'], 'United States', ['US', 'USA'])).toEqual({ found: 'none' })
  })

  it('finds none when no Option equals the Value or a candidate', () => {
    expect(matchOption(['Yes', 'No'], 'Germany', ['Alemanha'])).toEqual({ found: 'none' })
    expect(matchOption([], 'Germany')).toEqual({ found: 'none' })
  })

  it('finds many when two Options equal candidates of the same Value', () => {
    expect(matchOption(['US', 'United States', 'Canada'], 'United States', ['US', 'USA'])).toEqual({ found: 'many' })
  })

  it('finds many when the Value and a candidate name two different Options', () => {
    expect(matchOption(['Germany', 'Alemanha'], 'Germany', ['Alemanha'])).toEqual({ found: 'many' })
  })
})

/** The enumerated Field whose label matches, from the fixture on the page. */
function fieldLabelled(re: RegExp, epoch: number, kind?: string): EnumField {
  const fields = enumerateFields({ root: document, epoch }).fields
  const f = fields.find((x) => re.test(x.label ?? '') && (kind === undefined || x.kind === kind))
  if (f === undefined) throw new Error(`no Field labelled ${String(re)}; there are: ${fields.map((x) => `${x.kind}:${x.label}`).join(' | ')}`)
  return f
}

const handle = (f: EnumField): FieldHandle => ({ frameId: 0, fid: f.fid, epoch: f.epoch })

/**
 * The enumerated select under the question that matches. Lever's selects reach
 * Enumeration with no label (a Lever label rule is the third spec's), so the
 * Field is found through its question on the page.
 */
function selectUnder(question: RegExp, epoch: number): EnumField {
  const fields = enumerateFields({ root: document, epoch }).fields
  const li = Array.from(document.querySelectorAll('li.application-question')).find((q) => question.test(q.textContent ?? ''))
  const fid = Number(li?.querySelector('select')?.getAttribute('data-jff-fid'))
  const f = fields.find((x) => x.fid === fid && x.kind === 'select')
  if (f === undefined) throw new Error(`no select under ${String(question)}`)
  return f
}

describe('Fill over real pages, with candidate words', () => {
  beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

  it('a yes fills the Portuguese "Sim" of a Lever select, and the Fill reports the page wording', async () => {
    loadRealFixture('lever-marketing-consent')
    const f = selectUnder(/LGBTQIAP/, 2)
    expect(f.options).toEqual(expect.arrayContaining(['Sim', 'Não']))
    const report = await fillFields(document, [{ handle: handle(f), value: 'yes', candidates: yesNoCandidates('yes') }])
    expect(report.failed).toEqual([])
    expect(report.filled).toMatchObject([{ handle: handle(f), committed: 'Sim' }])
    const select = document.querySelector<HTMLSelectElement>(`[data-jff-fid="${f.fid}"]`)!
    expect(select.selectedOptions[0]!.textContent).toBe('Sim')
  })

  it('a no fills the Portuguese "Não" of the same select', async () => {
    loadRealFixture('lever-marketing-consent')
    const f = selectUnder(/LGBTQIAP/, 2)
    const report = await fillFields(document, [{ handle: handle(f), value: 'no', candidates: yesNoCandidates('no') }])
    expect(report.filled).toMatchObject([{ handle: handle(f), committed: 'Não' }])
  })

  it('a country is not filled into a yes/no select, and the select stays as it was', async () => {
    loadRealFixture('lever-marketing-consent')
    const f = selectUnder(/LGBTQIAP/, 2)
    const report = await fillFields(document, [{ handle: handle(f), value: 'Germany', candidates: countryCandidates('Germany') }])
    expect(report.failed).toMatchObject([{ handle: handle(f), reason: 'no-matching-option' }])
    expect(document.querySelector<HTMLSelectElement>(`[data-jff-fid="${f.fid}"]`)!.value).toBe('')
  })

  it('a no presses the "No" of an Ashby yes/no question', async () => {
    loadRealFixture('based-in-yes-no')
    // The page's own script presses a button on click; a static fixture has none.
    for (const b of Array.from(document.querySelectorAll('button'))) {
      b.addEventListener('click', () => b.setAttribute('aria-pressed', 'true'))
    }
    const f = fieldLabelled(/based in/i, 3)
    const report = await fillFields(document, [{ handle: handle(f), value: 'Não', candidates: yesNoCandidates('no') }])
    expect(report.failed).toEqual([])
    expect(report.filled).toMatchObject([{ handle: handle(f), committed: 'No' }])
  })
})
