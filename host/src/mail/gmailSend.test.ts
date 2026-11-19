import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asMailError, type OutgoingEmail, type SignedInAccount } from './account.js'
import { createGmailDriver } from './gmail.js'
import type { HttpRequest, HttpResponse } from './net.js'

/**
 * The Gmail driver's send (spec #66, ticket #82), against the transcripts the
 * research ticket recorded under `e2e/fixtures/gmail/`, with the network call
 * injected: a token refresh, a send Gmail accepted and a send it refused. The
 * message the driver hands Gmail is decoded here and read back: its headers,
 * its plain-text part and its one attachment.
 */

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../../..')
interface Transcript { request: HttpRequest; response: HttpResponse }
const transcript = (name: string): Transcript =>
  JSON.parse(readFileSync(resolve(REPO, 'e2e/fixtures/gmail', name), 'utf8')) as Transcript

const REFRESH = transcript('token-refresh.json')
const SEND_OK = transcript('send-ok.json')
const SEND_REFUSED = transcript('send-refused.json')

const ACCOUNT: SignedInAccount = {
  address: 'ada@example.com',
  clientId: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com',
  clientSecret: 'CLIENT_SECRET_PLACEHOLDER',
  refreshToken: 'REFRESH_TOKEN_PLACEHOLDER',
}

/** A Resume with every byte value in it, so a lossy encoding shows. */
const RESUME = Buffer.from([...Array(256).keys(), 0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0x00, 0xff])

const EMAIL: OutgoingEmail = {
  from: { address: 'ada@example.com', displayName: 'Ada Lovelace' },
  to: 'jobs@example.org',
  subject: 'Application: Analyst',
  body: 'Hello,\n\nI would like to apply for the analyst role.\n\nBest regards,\nAda Lovelace',
  attachment: { name: 'Ada Lovelace - Resume.pdf', mimeType: 'application/pdf', data: RESUME },
}

/** The network: the refresh, then the send's recorded answer. */
function recorded(send: Transcript = SEND_OK): { calls: HttpRequest[]; http: (req: HttpRequest) => Promise<HttpResponse> } {
  const calls: HttpRequest[] = []
  return {
    calls,
    http: async (req) => {
      calls.push(req)
      if (req.url === REFRESH.request.url) return REFRESH.response
      if (req.url === send.request.url) return send.response
      throw new Error(`no recording for ${req.url}`)
    },
  }
}

async function failure(p: Promise<unknown>): Promise<{ kind: string; message: string }> {
  try { await p } catch (e) {
    const mail = asMailError(e)
    if (mail === null) throw e
    return mail
  }
  throw new Error('expected a failure')
}

/* ------------------------------------------------- reading a message back */

interface Part { headers: Map<string, string[]>; body: string }

/** Splits a header block, unfolding continuation lines, into lowercase names. */
function readHeaders(block: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of block.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    if (line === '') continue
    const colon = line.indexOf(':')
    expect(colon, `a header line with no colon: ${line}`).toBeGreaterThan(0)
    const name = line.slice(0, colon).toLowerCase()
    out.set(name, [...(out.get(name) ?? []), line.slice(colon + 1).trim()])
  }
  return out
}

function readPart(text: string): Part {
  const end = text.indexOf('\r\n\r\n')
  expect(end, 'a part with no blank line after its headers').toBeGreaterThan(0)
  return { headers: readHeaders(text.slice(0, end)), body: text.slice(end + 4) }
}

const one = (p: Part, name: string): string => {
  const v = p.headers.get(name) ?? []
  expect(v, `header ${name}`).toHaveLength(1)
  return v[0]!
}

/** A parameter of a structured header, such as `boundary` or `filename`. */
function param(header: string, name: string): string | null {
  const m = new RegExp(`;\\s*${name}="([^"]*)"`, 'i').exec(header) ?? new RegExp(`;\\s*${name}=([^;\\s]+)`, 'i').exec(header)
  return m === null ? null : m[1]!
}

/** RFC 2047 encoded words, B or Q, back to text. */
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_all, _cs: string, enc: string, text: string) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'))
}

/** The decoded bytes of a part, by its transfer encoding. */
function bytesOf(p: Part): Buffer {
  const enc = (p.headers.get('content-transfer-encoding')?.[0] ?? '7bit').toLowerCase()
  if (enc === 'base64') {
    return Buffer.from(p.body.replace(/\r\n/g, ''), 'base64')
  }
  return Buffer.from(p.body, 'utf8')
}

/** A whole message from Gmail's `raw`: its headers and its MIME parts. */
function readMessage(raw: string): { top: Part; parts: Part[] } {
  const text = Buffer.from(raw, 'base64url').toString('latin1')
  // Every line ends in CRLF and none is longer than RFC 5322's 998.
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  for (const line of text.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998)
  const top = readPart(text)
  const type = one(top, 'content-type')
  expect(type.toLowerCase()).toMatch(/^multipart\/mixed/)
  const boundary = param(type, 'boundary')!
  expect(boundary).toBeTruthy()
  const chunks = top.body.split(`--${boundary}`)
  expect(chunks.at(-1)!.startsWith('--'), 'the closing boundary').toBe(true)
  const parts = chunks.slice(1, -1).map((c) => readPart(c.replace(/^\r\n/, '').replace(/\r\n$/, '')))
  return { top, parts }
}

const rawOf = (req: HttpRequest): string => (JSON.parse(req.body!) as { raw: string }).raw

async function sentMessage(email: OutgoingEmail = EMAIL): Promise<{ top: Part; parts: Part[]; request: HttpRequest }> {
  const net = recorded()
  await createGmailDriver({ http: net.http }).send(ACCOUNT, email)
  const request = net.calls.find((c) => c.url === SEND_OK.request.url)!
  return { ...readMessage(rawOf(request)), request }
}

/* ------------------------------------------------------------------ tests */

describe('the reader in this file', () => {
  it('reads the message Gmail accepted in the research transcript', () => {
    const { top, parts } = readMessage(rawOf(SEND_OK.request))
    expect(one(top, 'from')).toBe('Ada Lovelace <ada@example.com>')
    expect(parts).toHaveLength(2)
    expect(bytesOf(parts[0]!).toString('utf8')).toMatch(/^A probe message/)
  })
})

describe('the Gmail driver sends', () => {
  it('to the send endpoint, with the access token and the JSON body the transcript recorded', async () => {
    const { request } = await sentMessage()
    expect(request.method).toBe(SEND_OK.request.method)
    expect(request.url).toBe(SEND_OK.request.url)
    expect(request.headers).toEqual(SEND_OK.request.headers)
    expect(Object.keys(JSON.parse(request.body!) as object)).toEqual(['raw'])
    expect(rawOf(request)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("answers Gmail's message id and thread id", async () => {
    const net = recorded()
    const out = await createGmailDriver({ http: net.http }).send(ACCOUNT, EMAIL)
    expect(out).toEqual({ messageId: 'MESSAGE_ID_PLACEHOLDER', threadId: 'THREAD_ID_PLACEHOLDER' })
  })

  it('one message whose From carries the display name, with one To and the subject', async () => {
    const { top } = await sentMessage()
    expect(decodeWords(one(top, 'from')).replace(/"/g, '')).toBe('Ada Lovelace <ada@example.com>')
    expect(one(top, 'to')).toBe('jobs@example.org')
    expect(decodeWords(one(top, 'subject'))).toBe('Application: Analyst')
    expect(one(top, 'mime-version')).toBe('1.0')
  })

  it('a UTF-8 plain-text part equal to the body, and one attachment equal to the Resume byte for byte', async () => {
    const { parts } = await sentMessage()
    const text = parts.filter((p) => one(p, 'content-type').toLowerCase().startsWith('text/'))
    expect(text).toHaveLength(1)
    expect(one(text[0]!, 'content-type').toLowerCase()).toMatch(/^text\/plain;\s*charset="?utf-8"?$/)
    expect(bytesOf(text[0]!).toString('utf8').replace(/\r\n/g, '\n')).toBe(EMAIL.body)

    const attached = parts.filter((p) => (p.headers.get('content-disposition')?.[0] ?? '').toLowerCase().startsWith('attachment'))
    expect(attached).toHaveLength(1)
    expect(parts).toHaveLength(2)
    const a = attached[0]!
    expect(one(a, 'content-type').toLowerCase()).toMatch(/^application\/pdf/)
    expect(param(one(a, 'content-disposition'), 'filename')).toBe('Ada Lovelace - Resume.pdf')
    expect(bytesOf(a).equals(RESUME)).toBe(true)
    // RFC 2045: base64 lines are at most 76 characters.
    for (const p of parts) for (const line of p.body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
  })

  it('keeps a subject, a display name, a body and a file name with non-ASCII text intact', async () => {
    const email: OutgoingEmail = {
      ...EMAIL,
      from: { address: 'ada@example.com', displayName: 'Ada Lovelace — Condessa de Lovelace' },
      subject: 'Candidatura: Analista de Motores Analíticos — São Paulo, 100% remoto, ação já! '.repeat(2).trim(),
      body: 'Olá equipe,\n\nGostaria de me candidatar à vaga. Já construí motores analíticos & muito mais: 🚂\n\nAtenciosamente,\nAda Lovelace',
      attachment: { ...EMAIL.attachment, name: 'Currículo Ada.pdf' },
    }
    const { top, parts } = await sentMessage(email)
    // Header text is ASCII on the wire: the non-ASCII travels encoded.
    for (const [, values] of top.headers) for (const v of values) expect(v).toMatch(/^[\x20-\x7e]*$/)
    expect(decodeWords(one(top, 'subject'))).toBe(email.subject)
    expect(decodeWords(one(top, 'from')).replace(/^"|"(?= <)/g, '')).toBe(`${email.from.displayName} <ada@example.com>`)
    expect(bytesOf(parts[0]!).toString('utf8').replace(/\r\n/g, '\n')).toBe(email.body)
    const disposition = one(parts[1]!, 'content-disposition')
    const star = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)
    expect(star === null ? param(disposition, 'filename') : decodeURIComponent(star[1]!)).toBe('Currículo Ada.pdf')
  })

  it('has no HTML part, no Cc and no Bcc', async () => {
    const { top, parts } = await sentMessage()
    expect(top.headers.has('cc')).toBe(false)
    expect(top.headers.has('bcc')).toBe(false)
    for (const p of parts) expect(one(p, 'content-type').toLowerCase()).not.toMatch(/html/)
    expect(Buffer.from(rawOf((await sentMessage()).request), 'base64url').toString('latin1')).not.toMatch(/text\/html/i)
  })

  it('refuses a header that would carry a line break, and calls nothing', async () => {
    for (const bad of [
      { ...EMAIL, to: 'jobs@example.org\r\nBcc: someone@example.net' },
      { ...EMAIL, subject: 'Application\r\nBcc: someone@example.net' },
      { ...EMAIL, from: { ...EMAIL.from, displayName: 'Ada\nBcc: someone@example.net' } },
    ]) {
      const net = recorded()
      const err = await failure(createGmailDriver({ http: net.http }).send(ACCOUNT, bad))
      expect(err.kind).toBe('bad_request')
      expect(net.calls.filter((c) => c.url === SEND_OK.request.url)).toEqual([])
    }
  })

  it('reports a send Gmail refuses as a failure with its reason', async () => {
    const net = recorded(SEND_REFUSED)
    const err = await failure(createGmailDriver({ http: net.http }).send(ACCOUNT, EMAIL))
    expect(err.kind).toBe('process')
    expect(err.message).toContain('Recipient address required')
    expect(err.message).toContain('400')
  })

  it('reports a sign-in Google refuses as not_authed, and sends nothing', async () => {
    const dead = transcript('refresh-invalid-grant.json')
    const calls: HttpRequest[] = []
    const http = async (req: HttpRequest): Promise<HttpResponse> => { calls.push(req); return dead.response }
    const err = await failure(createGmailDriver({ http }).send(ACCOUNT, EMAIL))
    expect(err.kind).toBe('not_authed')
    expect(calls.filter((c) => c.url === SEND_OK.request.url)).toEqual([])
  })

  it('reports Google out of reach as a failure that names no Resume byte', async () => {
    const http = async (req: HttpRequest): Promise<HttpResponse> => {
      if (req.url === REFRESH.request.url) return REFRESH.response
      throw new Error('getaddrinfo ENOTFOUND gmail.googleapis.com')
    }
    const err = await failure(createGmailDriver({ http }).send(ACCOUNT, EMAIL))
    expect(err.kind).toBe('process')
    expect(err.message).not.toContain(RESUME.toString('base64').slice(0, 40))
  })
})
