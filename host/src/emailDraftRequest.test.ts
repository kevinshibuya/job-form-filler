import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { EmailDraftResultSchema, type EmailDraftParams, type HostRequest, type HostResponse } from '@jff/shared'
import { openDb, setProfile } from './db/repos.js'
import { handleRaw, handleRequest, type HandlerDeps } from './handlers.js'
import { ClaudeError } from './llm/claudeCli.js'
import { resolveModels } from './llm/models.js'

// Ticket #72 at the Native host's request seam: `email.draft` goes through the
// request handler with a real in-memory database and fake model runners. What
// is asserted is what the request answers and what each model was shown.

const PROSE = 'Hello,\n\nI would like to apply for the analyst role at Acme. I spent five years as an analyst at Example Ltd.'

// One Claude runner serves the writer and the Draft check: a prompt that opens
// as the Draft check's goes to `checkComplete`, every other to `claudeComplete`.
const claudeComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ subject: 'Application', body: PROSE, links: [] }))
const checkComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ draft: PROSE, unsupported: [] }))
const isCheckPrompt = (prompt: string): boolean => prompt.startsWith('You review ONE drafted answer')
const claudeRunner = async (prompt: string, schema?: unknown, opts?: unknown): Promise<unknown> =>
  isCheckPrompt(prompt) ? checkComplete(prompt, schema, opts) : claudeComplete(prompt, schema, opts)
const codexComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => { throw new Error('the Application email asks no Codex model') })

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
  checkComplete.mockReset()
  checkComplete.mockImplementation(async () => ({ draft: PROSE, unsupported: [] }))
  codexComplete.mockClear()
  setProfile(db, {
    fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100',
    linkedin: 'https://www.linkedin.com/in/ada-example', github: 'https://github.com/ada-example',
  })
  deps = {
    db,
    runner: { complete: claudeRunner } as unknown as HandlerDeps['runner'],
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

  it('hands the writer and its Draft check the stored About me as a trusted block, named where a claim may come from (spec #98)', async () => {
    const aboutMe = 'I can start in March and I prefer working in TypeScript.'
    expect(await handleRaw(deps, { requestId: crypto.randomUUID(), method: 'aboutMe.set', params: { text: aboutMe } })).toMatchObject({ ok: true })
    await drafted(POSTING)
    const writer = writerPrompt()
    const check = checkComplete.mock.calls[0]![0]
    for (const prompt of [writer, check]) {
      const at = prompt.indexOf('ABOUT ME (')
      expect(at).toBeGreaterThanOrEqual(0)
      expect(prompt.slice(at).split('\n')[0]).toMatch(/trusted/i)
      expect(prompt.slice(at)).toContain(aboutMe)
    }
    expect(writer.split('\n').find((l) => /may come ONLY from/.test(l))).toContain('ABOUT ME')
    expect(check.split('\n').find((l) => l.startsWith('The trusted blocks are'))).toContain('ABOUT ME')
  })

  it('hands the writer and its Draft check no About me block when none is stored (spec #98)', async () => {
    await drafted(POSTING)
    expect(writerPrompt()).not.toContain('ABOUT ME (')
    expect(checkComplete.mock.calls[0]![0]).not.toContain('ABOUT ME (')
  })

  it('hands the writer and its Draft check no Saved answer, reusable or not (spec #98)', async () => {
    const saved = await handleRaw(deps, {
      requestId: crypto.randomUUID(), method: 'save',
      params: {
        url: 'https://jobs.example.com/apply', company: 'Example Ltd', generatedCount: 0,
        items: [
          { handle: { frameId: 0, fid: 1, epoch: 1 }, questionRaw: 'What is your expected salary?', answer: 'SALARY-ANSWER', reusability: 'reusable', fieldKey: null },
          { handle: { frameId: 0, fid: 2, epoch: 1 }, questionRaw: 'Why Example Ltd?', answer: 'COMPANY-ANSWER', reusability: 'company_specific', fieldKey: null },
        ],
      },
    })
    expect(saved).toMatchObject({ ok: true, result: { saved: 2 } })
    await drafted(POSTING)
    const prompts = [writerPrompt(), checkComplete.mock.calls[0]![0]]
    for (const prompt of prompts) {
      expect(prompt).not.toContain('SALARY-ANSWER')
      expect(prompt).not.toContain('COMPANY-ANSWER')
      expect(prompt).not.toContain('SAVED ANSWERS (')
      expect(prompt).not.toContain('<stored_question>expected salary')
    }
  })

  it('runs the writer and the Draft check on claude-opus-5-5, and asks no Codex model', async () => {
    await drafted(POSTING)
    expect(claudeComplete).toHaveBeenCalledTimes(1)
    expect(claudeComplete.mock.calls[0]![2]).toMatchObject({ model: 'claude-opus-5-5' })
    expect(checkComplete).toHaveBeenCalledTimes(1)
    expect(checkComplete.mock.calls[0]![2]).toMatchObject({ model: 'claude-opus-5-5' })
    expect(codexComplete).not.toHaveBeenCalled()
  })

  it('runs the Draft check on the model the config names for applicationEmailCheck', async () => {
    deps = { ...deps, models: resolveModels({ applicationEmailCheck: 'claude-sonnet-5-5' }) }
    await drafted(POSTING)
    expect(checkComplete.mock.calls[0]![2]).toMatchObject({ model: 'claude-sonnet-5-5' })
    expect(claudeComplete.mock.calls[0]![2]).toMatchObject({ model: 'claude-opus-5-5' })
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
    checkComplete.mockImplementation(async () => ({ draft: prose, unsupported: ['I led the payments team at Acme.'] }))
    const out = await drafted(POSTING)
    expect(out.unsupportedClaims).toEqual(['I led the payments team at Acme.', 'Reach me at ada@example.com any time.'])
  })

  it('still answers the Draft, marked unchecked, when the Draft check fails', async () => {
    checkComplete.mockImplementation(async () => { throw new ClaudeError('rate_limit', 'slow down') })
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

// Ticket #73: the Draft's language, and Regenerate's instruction.

const PT_POSTING: EmailDraftParams = {
  ...POSTING,
  jobText: 'A Acme está contratando uma pessoa analista. Você vai trabalhar com o nosso time de finanças. Envie seu currículo e o link do seu GitHub para o e-mail da vaga.',
}
const ES_POSTING: EmailDraftParams = {
  ...POSTING,
  jobText: 'Acme busca una persona analista para su equipo. Trabajarás con los equipos de producto y finanzas. Envía tu currículum y un enlace a tu GitHub a la dirección del puesto.',
}

describe('email.draft, the language', () => {
  it('drafts a Portuguese posting in Portuguese: the writer is told so, the sign-off is Portuguese, and the reply names the language', async () => {
    const out = await drafted(PT_POSTING)
    expect(out.language).toBe('pt')
    expect(writerPrompt()).toMatch(/Write in Portuguese/)
    expect(out.body).toMatch(/Atenciosamente,\nAda Lovelace$/)
  })

  it('drafts an English posting in English', async () => {
    const out = await drafted(POSTING)
    expect(out.language).toBe('en')
    expect(writerPrompt()).toMatch(/Write in English/)
    expect(out.body).toMatch(/Best regards,\nAda Lovelace$/)
  })

  it('drafts a posting in a language the Profile does not list in English', async () => {
    const out = await drafted(ES_POSTING)
    expect(out.language).toBe('en')
    expect(writerPrompt()).toMatch(/Write in English/)
  })

  it('drafts in the language the request names, whatever the posting is in', async () => {
    expect((await drafted({ ...PT_POSTING, language: 'en' })).language).toBe('en')
    expect(writerPrompt()).toMatch(/Write in English/)
    claudeComplete.mockClear()
    expect((await drafted({ ...POSTING, language: 'pt' })).language).toBe('pt')
    expect(writerPrompt()).toMatch(/Write in Portuguese/)
  })

  it('refuses a language other than English and Portuguese', async () => {
    expect(await draft({ ...POSTING, language: 'es' })).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(claudeComplete).not.toHaveBeenCalled()
  })
})

describe('email.draft, the instruction', () => {
  it('reaches the writer as the user\'s own text, outside the untrusted fence', async () => {
    await drafted({ ...POSTING, instruction: 'Lead with the payments work, and keep it shorter.' })
    const prompt = writerPrompt()
    expect(prompt).toContain('Lead with the payments work, and keep it shorter.')
    const fenced = prompt.match(/<job_post>[\s\S]*<\/job_post>/)![0]
    expect(fenced).not.toContain('payments work')
    expect(prompt.indexOf('payments work')).toBeGreaterThan(prompt.indexOf('</job_post>'))
    expect(prompt).toMatch(/instruction[^\n]*\(trusted, typed by the candidate/i)
  })

  it('leaves the prompt without an instruction block when there is none, or only blanks', async () => {
    await drafted(POSTING)
    expect(writerPrompt()).not.toMatch(/candidate's instruction/i)
    claudeComplete.mockClear()
    await drafted({ ...POSTING, instruction: '   ' })
    expect(writerPrompt()).not.toMatch(/candidate's instruction/i)
  })

  it('is refused over the cap, and no model is asked', async () => {
    const r = await draft({ ...POSTING, instruction: 'x'.repeat(301) })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(claudeComplete).not.toHaveBeenCalled()
    expect((await drafted({ ...POSTING, instruction: 'x'.repeat(300) })).body.length).toBeGreaterThan(0)
  })

  it('has no place in the request for a Prose Field\'s Generation', async () => {
    const r = await handleRaw(deps, {
      requestId: crypto.randomUUID(), method: 'generate',
      params: { handle: { frameId: 0, fid: 1, epoch: 1 }, questionRaw: 'Why Acme?', jobText: POSTING.jobText, company: 'Acme', instruction: 'shorter' },
    })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(claudeComplete).not.toHaveBeenCalled()
  })
})
