import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { AppliedTexts, HandedOverEmail, HostResponse, KeptProseAnswer } from '@jff/shared'
import { openDb } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * An email Applied job keeps its Application email (spec #66, ticket #75), at
 * the Native host's request seam: an in-memory database and the request
 * handler called directly. A mark after "Open in my mail app" carries the
 * email as it was handed over; `applied.get` reads one Applied job's texts.
 */

let db: Database.Database
let deps: HandlerDeps

beforeEach(() => {
  db = openDb(':memory:')
  const unused = { complete: vi.fn(async () => { throw new Error('no model call here') }) }
  deps = {
    db,
    runner: unused as unknown as HandlerDeps['runner'],
    codex: unused as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

const HANDED: HandedOverEmail = {
  applyAddress: 'jobs@example.org',
  subject: 'Candidatura: Analista de Motores — Ada',
  body: 'Olá,\n\nGostaria de me candidatar à vaga de analista.\n\nAtenciosamente,\nAda Lovelace',
  language: 'pt',
  aiDrafted: true,
  edited: true,
  model: 'claude-opus-5-5',
}

const WHY: KeptProseAnswer = {
  question: 'Why do you want to work here?', text: 'I read the analytical engine notes.',
  aiDrafted: true, edited: false, model: 'claude-opus-5-5', kind: 'prose',
}

let seq = 0
const send = async (method: string, params: Record<string, unknown>): Promise<HostResponse> =>
  await handleRaw(deps, { requestId: `${method}-${++seq}`, method, params })

const result = <T>(r: HostResponse): T => {
  if (!r.ok) throw new Error(`request failed: ${r.error.kind}: ${r.error.message}`)
  return r.result as T
}

const markEmail = async (url: string, email: HandedOverEmail): Promise<{ id: number; channel: string; markedAt: string }> =>
  result(await send('applied.mark', { url, company: 'Acme', jobTitle: 'Analyst', channel: 'email', email }))

const texts = async (id: number): Promise<AppliedTexts> => result(await send('applied.get', { id }))

describe('applied.mark after "Open in my mail app"', () => {
  it('stores an email Applied job and one Application email that left through the mail app, as handed over', async () => {
    const job = await markEmail('https://careers.example.com/jobs/1', HANDED)
    expect(job.channel).toBe('email')

    const { emails, proseAnswers } = await texts(job.id)
    expect(proseAnswers).toEqual([])
    expect(emails).toHaveLength(1)
    const [stored] = emails
    expect(stored).toMatchObject({
      applyAddress: HANDED.applyAddress, subject: HANDED.subject, body: HANDED.body, language: 'pt',
      aiDrafted: true, edited: true, model: 'claude-opus-5-5', route: 'mail_app',
    })
    // The mail app's email has no Sender address, no attachments and no Gmail ids.
    expect(stored!.senderAddress).toBeNull()
    expect(stored!.attachmentNames).toEqual([])
    expect(stored!.gmailMessageId).toBeNull()
    expect(stored!.gmailThreadId).toBeNull()
    expect(Number.isNaN(Date.parse(stored!.sentAt))).toBe(false)
  })

  it('goes by email when the mark names no channel but carries the email', async () => {
    const r = await send('applied.mark', { url: 'https://careers.example.com/jobs/2', company: null, jobTitle: null, email: HANDED })
    const job = result<{ id: number; channel: string }>(r)
    expect(job.channel).toBe('email')
    expect((await texts(job.id)).emails).toHaveLength(1)
  })

  it.each([
    ['a Sender address', { senderAddress: 'ada@example.com' }],
    ['attachment names', { attachmentNames: ['ada-cv.pdf'] }],
    ['a Gmail message id', { gmailMessageId: '18c0ffee' }],
    ['a Gmail thread id', { gmailThreadId: '18c0ffee' }],
  ])('refuses a handed-over email that carries %s, and marks nothing', async (_what, extra) => {
    const r = await send('applied.mark', {
      url: 'https://careers.example.com/jobs/3', company: null, jobTitle: null, channel: 'email', email: { ...HANDED, ...extra },
    })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(result<{ jobs: unknown[] }>(await send('applied.list', {})).jobs).toEqual([])
  })

  it('refuses a form mark that carries an Application email', async () => {
    const r = await send('applied.mark', {
      url: 'https://careers.example.com/jobs/4', company: null, jobTitle: null, channel: 'form', email: HANDED,
    })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
  })

  it('keeps the first Application email when the same Job posting is marked again, and lists the newest first', async () => {
    const first = await markEmail('https://careers.example.com/jobs/5?utm_source=board', HANDED)
    const second: HandedOverEmail = { ...HANDED, applyAddress: 'hr@example.org', subject: 'Second try', edited: false, language: 'en' }
    const again = await markEmail('https://careers.example.com/jobs/5', second)
    expect(again.id).toBe(first.id)
    expect(again.markedAt).toBe(first.markedAt)

    const { emails } = await texts(first.id)
    expect(emails.map((e) => e.subject)).toEqual(['Second try', HANDED.subject])
    expect(emails[1]).toMatchObject({ applyAddress: 'jobs@example.org', body: HANDED.body, edited: true })
  })

  it('keeps the Application email through a later form mark', async () => {
    const job = await markEmail('https://careers.example.com/jobs/6', HANDED)
    await send('applied.mark', { url: 'https://careers.example.com/jobs/6', company: null, jobTitle: null, channel: 'form', proseAnswers: [WHY] })
    const { emails, proseAnswers } = await texts(job.id)
    expect(emails.map((e) => e.subject)).toEqual([HANDED.subject])
    expect(proseAnswers).toEqual([WHY])
  })
})

describe('applied.get and applied.list', () => {
  it('returns one Applied job\'s prose answers and Application emails, and the list carries none of them', async () => {
    const form = result<{ id: number }>(await send('applied.mark', {
      url: 'https://jobs.example.com/form', company: 'Acme', jobTitle: 'Engineer', channel: 'form', proseAnswers: [WHY],
    }))
    const email = await markEmail('https://careers.example.com/jobs/7', HANDED)

    expect(await texts(form.id)).toEqual({ id: form.id, proseAnswers: [WHY], emails: [] })
    expect((await texts(email.id)).emails.map((e) => e.body)).toEqual([HANDED.body])

    const list = await send('applied.list', {})
    expect(result<{ jobs: unknown[] }>(list).jobs).toHaveLength(2)
    const listed = JSON.stringify(list)
    for (const text of [WHY.text, WHY.question, HANDED.subject, HANDED.body]) expect(listed).not.toContain(text)
  })

  it('answers a bad request for an id no Applied job has', async () => {
    const r = await send('applied.get', { id: 4242 })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
  })
})
