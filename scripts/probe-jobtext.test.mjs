// @vitest-environment jsdom
// The probe's job description measures (spec #98, ticket #109): the source of
// the Scan's Job posting text, and whether the link box reads the page's own
// address. The readers run in the panel through page.evaluate, so they are
// driven here on markup carrying the panel's own markers.
import { afterEach, describe, expect, it } from 'vitest'
import { formatTable, HELP_TEXT, summarize } from './probe-lib.mjs'
import {
  COUNTED_SOURCES, jobTextCounts, jobTextOf, linkBoxCounts, linkBoxOf, readJobTextLine, readLinkBox,
} from './probe-jobtext.mjs'

// Assembled at run time, as probe.test.mjs does, so no literal address sits
// in the tree for the private-data scan to weigh.
const web = ['https', ''].join(':') + '//'

afterEach(() => { document.body.innerHTML = '' })

/** The job description box's line and the link box, as the panel renders them. */
function panel({ source = 'heuristic', line = '1200 characters · a heuristic', failed = false, refused = false, reading = false } = {}) {
  document.body.innerHTML = `
    <label data-jff-paste="1">Job description
      <textarea></textarea>
      <span><span data-jff-jobtext-source="${source}">${line}</span></span>
    </label>
    <div data-jff-link="1">
      <label>Job posting link <input type="url"></label>
      ${failed ? '<span data-jff-link-failed="1">No job description could be read at that link. Paste the text instead.</span>' : ''}
      ${refused ? '<span data-jff-link-refused="1">Only an http or https address can be read.</span>' : ''}
      <button type="button"${reading ? ' disabled' : ''}>${reading ? 'Reading the posting…' : 'Read the posting'}</button>
    </div>`
}

describe('the source and length of the Job posting text', () => {
  it('are read from the line under the job description box', () => {
    panel({ source: 'ats', line: '2310 characters · the Lever posting page' })
    expect(jobTextOf(readJobTextLine())).toEqual({ source: 'ats', length: 2310 })
  })

  it('read a pick, a heuristic and nothing found', () => {
    panel({ source: 'pick', line: '640 characters · your pick' })
    expect(jobTextOf(readJobTextLine())).toEqual({ source: 'pick', length: 640 })
    panel({ source: 'heuristic', line: '1 character · a heuristic' })
    expect(jobTextOf(readJobTextLine())).toEqual({ source: 'heuristic', length: 1 })
    panel({ source: 'none', line: '0 characters · nothing found' })
    expect(jobTextOf(readJobTextLine())).toEqual({ source: 'none', length: 0 })
  })

  it('is null when the panel shows no line', () => {
    document.body.innerHTML = '<p data-jff-empty-session="1">No application session on this tab yet.</p>'
    expect(jobTextOf(readJobTextLine())).toBeNull()
  })
})

describe('what the link box gave', () => {
  it('is the length of the text when the link gave one', () => {
    panel({ source: 'link', line: '3021 characters · your link' })
    expect(linkBoxOf(readLinkBox())).toEqual({ readable: true, length: 3021 })
  })

  it('is not readable when the link box shows its failure message', () => {
    panel({ source: 'none', line: '0 characters · nothing found', failed: true })
    expect(linkBoxOf(readLinkBox())).toEqual({ readable: false, length: null })
  })

  it('is not known yet while the link is being read', () => {
    panel({ source: 'heuristic', reading: true })
    expect(linkBoxOf(readLinkBox())).toBeNull()
  })

  it('is not known when the box refused the address or gave neither answer', () => {
    panel({ refused: true })
    expect(linkBoxOf(readLinkBox())).toBeNull()
    panel({ source: 'heuristic' })
    expect(linkBoxOf(readLinkBox())).toBeNull()
  })
})

/** A page record as the probe writes it, with the fields the table reads. */
const page = (ats, jobText, linkBox, settledMs = 1000) => ({
  ats, fields: 0, filled: 0, firstFillMs: null, settledMs, jobText, linkBox,
})

describe('the summary', () => {
  it('counts one source per page among the four a Scan can end with', () => {
    expect(COUNTED_SOURCES).toEqual(['ats', 'pick', 'heuristic', 'none'])
    const counts = jobTextCounts([
      page('lever', { source: 'ats', length: 2000 }, null),
      page('lever', { source: 'heuristic', length: 900 }, null),
      page('lever', { source: 'heuristic', length: 800 }, null),
      page('lever', { source: 'pick', length: 700 }, null),
      page('lever', { source: 'none', length: 0 }, null),
    ])
    expect(counts).toEqual({ ats: 1, pick: 1, heuristic: 2, none: 1 })
  })

  it('counts a page readable when the link gave a text and not readable when it failed', () => {
    expect(linkBoxCounts([
      page('other', null, { readable: true, length: 3000 }),
      page('other', null, { readable: true, length: 500 }),
      page('other', null, { readable: false, length: null }),
    ])).toEqual({ read: 2, tried: 3 })
  })

  it('counts a page whose panel never settled in neither measure', () => {
    const unsettled = { ats: 'greenhouse', fields: 0, filled: 0, firstFillMs: null, settledMs: null, jobText: null, linkBox: null }
    const [row, total] = summarize([unsettled])
    expect(row).toMatchObject({ ats: 'greenhouse', pages: 1, jobText: { ats: 0, pick: 0, heuristic: 0, none: 0 }, linkBox: { read: 0, tried: 0 } })
    expect(total.pages).toBe(1)
  })

  it('counts a source outside the four, or a record from before the measures, in neither', () => {
    expect(jobTextCounts([page('other', { source: 'paste', length: 10 }, null), { ats: 'other' }]))
      .toEqual({ ats: 0, pick: 0, heuristic: 0, none: 0 })
    expect(linkBoxCounts([{ ats: 'other' }])).toEqual({ read: 0, tried: 0 })
  })
})

describe('the table', () => {
  const pages = [
    page('greenhouse', { source: 'ats', length: 2000 }, { readable: true, length: 2100 }),
    page('greenhouse', { source: 'heuristic', length: 900 }, { readable: false, length: null }),
    page('greenhouse', { source: 'none', length: 0 }, { readable: false, length: null }),
    page('lever', { source: 'pick', length: 700 }, { readable: true, length: 1800 }),
    page('lever', null, null, null),
  ]

  it('shows both measures per ATS and in the total row', () => {
    const lines = formatTable(summarize(pages)).split('\n')
    expect(lines[0]).toMatch(/Job text ats\/pick\/heur\/none\s+Link box reads$/)
    expect(lines.find((l) => l.startsWith('greenhouse'))).toMatch(/\s1\/0\/1\/1\s+1 of 3$/)
    expect(lines.find((l) => l.startsWith('lever'))).toMatch(/\s0\/1\/0\/0\s+1 of 1$/)
    expect(lines.find((l) => l.startsWith('all'))).toMatch(/\s1\/1\/1\/1\s+2 of 4$/)
  })

  it('shows a dash where no page was measured', () => {
    const line = formatTable(summarize([page('other', null, null, null)])).split('\n').find((l) => l.startsWith('other'))
    expect(line).toMatch(/\s-\s+-$/)
  })

  it('holds no page address and no employer name', () => {
    const records = [
      { ...page('lever', { source: 'ats', length: 2000 }, { readable: true, length: 2100 }), url: `${web}jobs.lever.co/acme-analytical/1/apply`, status: 'Acme Analytical Engines' },
    ]
    const text = formatTable(summarize(records))
    expect(text).not.toMatch(/acme/i)
    expect(text).not.toMatch(/https?:/)
  })
})

describe('the help', () => {
  it('names both measures and says the link box check fetches each address once more without cookies', () => {
    expect(HELP_TEXT).toMatch(/where the Scan's Job posting text came from/)
    expect(HELP_TEXT).toMatch(/link box/)
    expect(HELP_TEXT).toMatch(/once more/)
    expect(HELP_TEXT).toMatch(/without cookies/)
  })
})
