import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { EmailDraftResultSchema, type EmailDraftParams, type HostRequest, type HostResponse } from '@jff/shared'
import { openDb, setProfile } from './db/repos.js'
import { handleRaw, handleRequest, type HandlerDeps } from './handlers.js'
import { ClaudeError } from './llm/claudeCli.js'
import { CodexError } from './llm/codexCli.js'
import { resolveModels } from './llm/models.js'

// Ticket #72 at the Native host's request seam: `email.draft` goes through the
// request handler with a real in-memory database and fake model runners. What
// is asserted is what the request answers and what each model was shown.

const PROSE = 'Hello,\n\nI would like to apply for the analyst role at Acme. I spent five years as an analyst at Example Ltd.'

const claudeComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ subject: 'Application', body: PROSE, links: [] }))
const codexComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ draft: PROSE, unsupported: [] }))

let db: Database.Database
let deps: HandlerDeps

const CONFIG: HandlerDeps['config'] = {
  claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json',
  capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {},
}

beforeEach(() => {
  db = openDb(':memory:')
  claudeComplete.mockReset()
  claudeComplete.mockImplementation(async () => ({ subject: 'Application', body: PROSE, links: [] }))
  codexComplete.mockReset()
  codexComplete.mockImplementation(async () => ({ draft: PROSE, unsupported: [] }))
  setProfile(db, {
    fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100',
    linkedin: 'https://www.linkedin.com/in/ada-example', github: 'https://github.com/ada-example',
  })
  deps = {
    db,
    runner: { complete: claudeComplete } as unknown as HandlerDeps['runner'],
    codex: { complete: codexComplete } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: CONFIG,
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

const POSTING: EmailDraftParams = {
  jobText: 'Acme is hiring an analyst. Send your CV and a link to your GitHub to jobs@example.org.',
  company: 'Acme',
  title: 'Analyst at Acme',
  pageSubject: null,
  cvText: 'Analyst at Example Ltd, 2019 to 2024.',
}

async function draft(params: unknown): Promise<HostResponse> {
  return handleRaw(deps, { requestId: crypto.randomUUID(), method: 'email.draft', params })
}
async function drafted(params: unknown) {
  const r = await draft(params)
  if (!r.ok) throw new Error(`failed: ${r.error.message}`)
  return EmailDraftResultSchema.parse(r.result)
}

const writerPrompt = (): string => claudeComplete.mock.calls[0]![0]

describe('email.draft', () => {
  it('answers a subject, a body that ends with the stored links and the Profile name, and the model', async () => {
    claudeComplete.mockImplementation(async () => ({ subject: 'Application: Analyst', body: PROSE, links: ['github', 'linkedin'] }))
    const out = await drafted(POSTING)
    expect(out.subject).toBe('Application: Analyst')
    expect(out.model).toBe('claude-opus-5-5')
    expect(out.body.startsWith(PROSE)).toBe(true)
    const lines = out.body.split('\n').filter((l) => l.trim() !== '')
    expect(lines.at(-1)).toBe('Ada Lovelace')
    expect(out.body).toContain('https://www.linkedin.com/in/ada-example')
    expect(out.body).toContain('https://github.com/ada-example')
    expect(out.body.indexOf('https://github.com/ada-example')).toBeLessThan(out.body.lastIndexOf('Ada Lovelace'))
    expect(out.missingLinks).toEqual([])
    expect(out.unchecked).toBe(false)
  })

  it('leaves out a requested link the Profile does not hold, and names it', async () => {
    claudeComplete.mockImplementation(async () => ({ subject: 'Application', body: PROSE, links: ['portfolio'] }))
    const out = await drafted(POSTING)
    expect(out.missingLinks).toEqual(['portfolio'])
    expect(out.body).not.toMatch(/portfolio/i)
  })

  it('uses the page subject character for character, and asks the writer for none', async () => {
    claudeComplete.mockImplementation(async () => ({ body: PROSE, links: [] }))
    const out = await drafted({ ...POSTING, pageSubject: 'Ref 42 · Analyst  (Lisbon)' })
    expect(out.subject).toBe('Ref 42 · Analyst  (Lisbon)')
    expect(writerPrompt()).not.toContain('"subject"')
  })

  it('shows the writer the Job posting text and the page subject fenced, the Resume text and the stored facts', async () => {
    claudeComplete.mockImplementation(async () => ({ body: PROSE, links: [] }))
    await drafted({ ...POSTING, pageSubject: 'Application: Analyst' })
    const prompt = writerPrompt()
    expect(prompt).toContain(`<job_post>${POSTING.jobText}</job_post>`)
    expect(prompt).toContain('<email_subject>Application: Analyst</email_subject>')
    expect(prompt).toContain('Analyst at Example Ltd, 2019 to 2024.')
    expect(prompt).toContain('fullName: Ada Lovelace')
  })

  it('runs the writer on claude-opus-5-5 and the Draft check on its own model', async () => {
    await drafted(POSTING)
    expect(claudeComplete).toHaveBeenCalledTimes(1)
    expect(claudeComplete.mock.calls[0]![2]).toMatchObject({ model: 'claude-opus-5-5' })
    expect(codexComplete).toHaveBeenCalledTimes(1)
    expect(codexComplete.mock.calls[0]![2]).toMatchObject({ model: 'gpt-6.1-sol' })
  })

  it('runs the writer on the model the config names for applicationEmail', async () => {
    deps = { ...deps, models: resolveModels({ applicationEmail: 'claude-sonnet-5-5' }) }
    const out = await drafted(POSTING)
    expect(claudeComplete.mock.calls[0]![2]).toMatchObject({ model: 'claude-sonnet-5-5' })
    expect(out.model).toBe('claude-sonnet-5-5')
  })

  it('flags the Draft check\'s unsupported claims and a sentence with a link or an address', async () => {
    const prose = 'I led the payments team at Acme. Reach me at ada@example.com any time. Thank you for reading.'
    claudeComplete.mockImplementation(async () => ({ subject: 'Application', body: prose, links: [] }))
    codexComplete.mockImplementation(async () => ({ draft: prose, unsupported: ['I led the payments team at Acme.'] }))
    const out = await drafted(POSTING)
    expect(out.unsupportedClaims).toEqual(['I led the payments team at Acme.', 'Reach me at ada@example.com any time.'])
  })

  it('still answers the Draft, marked unchecked, when the Draft check fails', async () => {
    codexComplete.mockImplementation(async () => { throw new CodexError('rate_limit', 'slow down') })
    const out = await drafted(POSTING)
    expect(out.unchecked).toBe(true)
    expect(out.body.startsWith(PROSE)).toBe(true)
  })

  it('refuses a request with no Job posting text and asks no model', async () => {
    const r = await draft({ ...POSTING, jobText: '   ' })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(claudeComplete).not.toHaveBeenCalled()
  })

  it('a writer that fails answers an error the panel can name, and is not replayed', async () => {
    claudeComplete.mockImplementationOnce(async () => { throw new ClaudeError('timeout', 'claude timed out') })
    const req = { requestId: crypto.randomUUID(), method: 'email.draft', params: POSTING } as HostRequest
    expect(await handleRequest(deps, req)).toMatchObject({ ok: false, error: { kind: 'timeout' } })
    expect(await handleRequest(deps, req)).toMatchObject({ ok: true })
  })
})
