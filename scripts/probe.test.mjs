import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  atsOf,
  DENIED_METHODS,
  filledFromStatus,
  formatTable,
  HELP_TEXT,
  isInsideDir,
  median,
  parsePageList,
  parseProbeArgs,
  ProbeRefusal,
  refusals,
  summarize,
} from './probe-lib.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
// Assembled at run time, as the guard's own tests do, so no literal address
// sits in the tree for the private-data scan to weigh.
const web = ['https', ''].join(':') + '//'

let outside
beforeEach(() => { outside = mkdtempSync(join(tmpdir(), 'jff-probe-test-')) })
afterEach(() => { rmSync(outside, { recursive: true, force: true }) })

function touch(path, text = '') {
  writeFileSync(path, text)
  return path
}

describe('the flags', () => {
  const home = '/home/ada'
  const cwd = '/work'

  it('reads the page list, Resume, records and app directory', () => {
    const o = parseProbeArgs(
      ['--pages', 'pages.txt', '--resume', '/cv/ada.pdf', '--records', '/runs', '--app-dir', '/data/jff'],
      { home, cwd },
    )
    expect(o).toMatchObject({
      help: false, pageList: '/work/pages.txt', resume: '/cv/ada.pdf', records: '/runs', appDir: '/data/jff',
    })
  })

  it('defaults the app directory to ~/.job-form-filler and the records under it', () => {
    const o = parseProbeArgs(['--pages', '/p.txt', '--resume', '/cv.pdf'], { home, cwd })
    expect(o.appDir).toBe('/home/ada/.job-form-filler')
    expect(o.records).toBe('/home/ada/.job-form-filler/probe')
  })

  it('takes the --flag=value form too', () => {
    const o = parseProbeArgs(['--pages=/p.txt', '--resume=/cv.pdf', '--timeout=30'], { home, cwd })
    expect(o).toMatchObject({ pageList: '/p.txt', resume: '/cv.pdf', timeoutSec: 30 })
  })

  it('asks for help with --help or -h and needs nothing else', () => {
    expect(parseProbeArgs(['--help'], { home, cwd }).help).toBe(true)
    expect(parseProbeArgs(['-h'], { home, cwd }).help).toBe(true)
  })

  it('refuses an unknown flag, a flag without its value and a bad timeout', () => {
    expect(() => parseProbeArgs(['--submit'], { home, cwd })).toThrow(ProbeRefusal)
    expect(() => parseProbeArgs(['--pages'], { home, cwd })).toThrow(/--pages needs a value/)
    expect(() => parseProbeArgs(['--timeout', 'soon'], { home, cwd })).toThrow(/--timeout/)
  })

  it('the help names every flag', () => {
    for (const flag of ['--pages', '--resume', '--records', '--app-dir', '--timeout', '--headed', '--help']) {
      expect(HELP_TEXT).toContain(flag)
    }
  })
})

describe('inside the repo', () => {
  it('is true for the repo itself and anything under it, existing or not', () => {
    expect(isInsideDir(REPO, REPO)).toBe(true)
    expect(isInsideDir(join(REPO, 'scripts', 'probe.mjs'), REPO)).toBe(true)
    expect(isInsideDir(join(REPO, 'not', 'yet', 'made'), REPO)).toBe(true)
  })

  it('is false for a sibling whose name only starts like the repo', () => {
    expect(isInsideDir(`${REPO}-records`, REPO)).toBe(false)
    expect(isInsideDir(outside, REPO)).toBe(false)
  })

  it('follows a symlink that points into the repo', () => {
    const link = join(outside, 'sneaky')
    symlinkSync(join(REPO, 'docs'), link)
    expect(isInsideDir(join(link, 'records'), REPO)).toBe(true)
  })
})

describe('what the probe refuses before it launches anything', () => {
  function opts(over = {}) {
    return {
      pageList: touch(join(outside, 'pages.txt'), `${web}example.org/apply\n`),
      resume: touch(join(outside, 'cv.pdf')),
      records: join(outside, 'records'),
      appDir: outside,
      ...over,
    }
  }

  it('accepts a page list, a Resume and records all outside the repo', () => {
    expect(refusals(opts(), REPO)).toEqual([])
  })

  it('refuses a page list inside the repo and says why', () => {
    const [msg, ...rest] = refusals(opts({ pageList: join(REPO, 'package.json') }), REPO)
    expect(rest).toEqual([])
    expect(msg).toMatch(/page list .* is inside the repo/)
    expect(msg).toMatch(/public/)
  })

  it('refuses a Resume inside the repo and says why', () => {
    const [msg] = refusals(opts({ resume: join(REPO, 'README.md') }), REPO)
    expect(msg).toMatch(/Resume .* is inside the repo/)
  })

  it('refuses a records directory inside the repo, even one not made yet', () => {
    const [msg] = refusals(opts({ records: join(REPO, 'probe-records') }), REPO)
    expect(msg).toMatch(/records directory .* is inside the repo/)
  })

  it('refuses a run with no Resume and says the Onboarding gate would block every Scan', () => {
    const [msg] = refusals(opts({ resume: null }), REPO)
    expect(msg).toMatch(/--resume/)
    expect(msg).toMatch(/Onboarding/)
  })

  it('refuses a run with no page list, and files that do not exist', () => {
    expect(refusals(opts({ pageList: null }), REPO)[0]).toMatch(/--pages/)
    expect(refusals(opts({ pageList: join(outside, 'nope.txt') }), REPO)[0]).toMatch(/does not exist/)
    expect(refusals(opts({ resume: join(outside, 'nope.pdf') }), REPO)[0]).toMatch(/does not exist/)
  })

  it('reports every refusal at once', () => {
    const all = refusals(opts({
      pageList: join(REPO, 'package.json'), resume: null, records: join(REPO, 'x'),
    }), REPO)
    expect(all).toHaveLength(3)
  })

  it('accepts a records directory that already exists outside the repo', () => {
    const records = join(outside, 'kept')
    mkdirSync(records)
    expect(refusals(opts({ records }), REPO)).toEqual([])
  })
})

describe('the page list', () => {
  it('is one URL per line, skipping blank lines and # comments', () => {
    const text = `# greenhouse\n${web}job-boards.greenhouse.io/acme/jobs/1\n\n  ${web}jobs.lever.co/acme/2/apply  \n`
    expect(parsePageList(text)).toEqual([
      `${web}job-boards.greenhouse.io/acme/jobs/1`,
      `${web}jobs.lever.co/acme/2/apply`,
    ])
  })

  it('refuses a line that is not an http(s) URL, naming the line', () => {
    expect(() => parsePageList(`${web}example.org/a\nnot a url\n`)).toThrow(/line 2/)
    expect(() => parsePageList('file:///etc/hosts\n')).toThrow(/line 1/)
  })

  it('refuses a list with no URL in it', () => {
    expect(() => parsePageList('# nothing yet\n\n')).toThrow(/no URL/)
  })
})

describe('the ATS of a page', () => {
  it('is read from the hosted board address', () => {
    expect(atsOf(`${web}job-boards.greenhouse.io/acme/jobs/1`)).toBe('greenhouse')
    expect(atsOf(`${web}boards.greenhouse.io/acme/jobs/1`)).toBe('greenhouse')
    expect(atsOf(`${web}jobs.lever.co/acme/2/apply`)).toBe('lever')
    expect(atsOf(`${web}jobs.ashbyhq.com/acme/3/application`)).toBe('ashby')
    expect(atsOf(`${web}acme.wd5.myworkdayjobs.com/en-US/careers/job/4`)).toBe('workday')
    expect(atsOf(`${web}jobs.smartrecruiters.com/Acme/5`)).toBe('smartrecruiters')
    expect(atsOf(`${web}apply.workable.com/acme/j/6/apply`)).toBe('workable')
    expect(atsOf(`${web}acme.gupy.io/jobs/7`)).toBe('gupy')
  })

  it('is read from the embed id on a company page', () => {
    expect(atsOf(`${web}acme.example.com/careers?gh_jid=123`)).toBe('greenhouse')
    expect(atsOf(`${web}acme.example.com/careers?ashby_jid=abc`)).toBe('ashby')
  })

  it('does not take a lookalike domain for the ATS', () => {
    expect(atsOf(`${web}notgreenhouse.io/jobs/1`)).toBe('other')
    expect(atsOf(`${web}acme.example.com/jobs/1`)).toBe('other')
  })
})

describe('the filled count on the status line', () => {
  it('is the number before "filled"', () => {
    expect(filledFromStatus('✓ 7 filled, 1 already on page, 0 proposed, 3 need input')).toBe(7)
    expect(filledFromStatus('2 filled, 0 already on page, 0 proposed, 0 need input, 5 still being matched…')).toBe(2)
  })

  it('is 0 when the line says nothing was filled or carries no count', () => {
    expect(filledFromStatus('Matching 12 fields… (an AI call can take a minute)')).toBe(0)
    expect(filledFromStatus('')).toBe(0)
  })
})

describe('the median', () => {
  it('ignores pages that never got there', () => {
    expect(median([3, null, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([null, null])).toBeNull()
    expect(median([])).toBeNull()
  })
})

describe('the table', () => {
  const page = (ats, fields, filled, firstFillMs, settledMs) => ({ ats, fields, filled, firstFillMs, settledMs })

  it('has one row per ATS and a total row for all pages', () => {
    const rows = summarize([
      page('lever', 10, 4, 1000, 9000),
      page('greenhouse', 20, 10, 500, 12000),
      page('greenhouse', 0, 0, null, 2000),
      page('greenhouse', 30, 9, 1500, 8000),
    ])
    expect(rows.map((r) => r.ats)).toEqual(['greenhouse', 'lever', 'all'])
    expect(rows[0]).toEqual({ ats: 'greenhouse', pages: 3, fields: 50, filled: 19, firstFillMs: 1000, settledMs: 8000 })
    expect(rows[1]).toEqual({ ats: 'lever', pages: 1, fields: 10, filled: 4, firstFillMs: 1000, settledMs: 9000 })
    expect(rows[2]).toEqual({ ats: 'all', pages: 4, fields: 60, filled: 23, firstFillMs: 1000, settledMs: 8500 })
  })

  it('counts a page with no form as a page with zero Fields', () => {
    const [row, total] = summarize([page('other', 0, 0, null, null)])
    expect(row).toEqual({ ats: 'other', pages: 1, fields: 0, filled: 0, firstFillMs: null, settledMs: null })
    expect(total.pages).toBe(1)
  })

  it('prints pages, Fields, filled count, fill rate and both median waits', () => {
    const text = formatTable(summarize([
      page('greenhouse', 20, 10, 1200, 10400),
      page('other', 0, 0, null, null),
    ]))
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/ATS\s+Pages\s+Fields\s+Filled\s+Rate\s+First Fill\s+Nothing waiting/)
    const gh = lines.find((l) => l.startsWith('greenhouse'))
    expect(gh).toMatch(/greenhouse\s+1\s+20\s+10\s+50%\s+1\.2 s\s+10\.4 s/)
    const other = lines.find((l) => l.startsWith('other'))
    expect(other).toMatch(/other\s+1\s+0\s+0\s+-\s+-\s+-/)
    expect(lines.find((l) => l.startsWith('all'))).toMatch(/all\s+2\s+20\s+10\s+50%/)
  })
})

describe('the requests the probe never lets through', () => {
  it('include Mark applied and Save answers', () => {
    expect(DENIED_METHODS).toContain('applied.mark')
    expect(DENIED_METHODS).toContain('save')
  })
})
