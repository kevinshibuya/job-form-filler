import { randomBytes } from 'node:crypto'
import { MailError, type OutgoingEmail } from './account.js'

/**
 * The one message an Application email is (spec #66): RFC 5322 headers and a
 * `multipart/mixed` body of two parts, a UTF-8 plain-text part and the Resume
 * as one attachment. No HTML part, no Cc, no Bcc. Every line ends in CRLF,
 * header text is ASCII on the wire, and non-ASCII travels as RFC 2047 encoded
 * words (the subject, the display name) or RFC 2231 (the file name).
 */

const CRLF = '\r\n'

/** RFC 2047 caps an encoded word at 75 characters. */
const WORD_MAX = 75

const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s)

/** A header value with a line break could add a header of its own. */
function oneLine(what: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw new MailError('bad_request', `The ${what} holds a line break, so the email was not sent.`)
  return value
}

/** An address with no space, line break, angle bracket or comma: one mailbox. */
function address(what: string, value: string): string {
  const v = value.trim()
  if (!/^[^\s<>,;"@]+@[^\s<>,;"@]+$/.test(v)) throw new MailError('bad_request', `The ${what} is not one email address, so the email was not sent.`)
  return v
}

/**
 * Text as RFC 2047 B encoded words, each at most 75 characters, split
 * between characters so no word ends inside one. Words are joined by a
 * folding space, which a reader drops between two encoded words.
 */
function encodedWords(text: string): string {
  const head = '=?UTF-8?B?'
  const room = Math.floor((WORD_MAX - head.length - 2) / 4) * 3 // UTF-8 bytes per word
  const words: string[] = []
  let chunk = ''
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > room) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk !== '' || words.length === 0) words.push(chunk)
  return words.map((w) => `${head}${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `)
}

/** An unstructured header's text (the subject): as is when ASCII and short,
 *  encoded otherwise. */
const unstructured = (text: string): string => (isAscii(text) && text.length <= 900 ? text : encodedWords(text))

/** A display name as an RFC 5322 phrase: bare when it is only atoms, quoted
 *  when it holds a special, encoded when it holds non-ASCII. */
function phrase(name: string): string {
  if (!isAscii(name)) return encodedWords(name)
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return name
  return `"${name.replace(/(["\\])/g, '\\$1')}"`
}

/** Base64 in lines of 76 characters (RFC 2045). */
function base64Lines(data: Buffer): string {
  const b64 = data.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))
  return lines.join(CRLF)
}

/** A MIME parameter: quoted when ASCII, RFC 2231 `name*=UTF-8''…` otherwise. */
function mimeParam(name: string, value: string): string {
  if (isAscii(value)) return `${name}="${value.replace(/(["\\])/g, '\\$1')}"`
  const pct = encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${name}*=UTF-8''${pct}`
}

/** A media type the attachment can carry, or the generic one. */
const mediaType = (t: string): string => (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(t.trim()) ? t.trim() : 'application/octet-stream')

/** The message's text, ready for Gmail's `raw`. `boundary` is for tests. */
export function buildMessage(email: OutgoingEmail, boundary: string = `jff_${randomBytes(12).toString('hex')}`): string {
  const from = address('Sender address', oneLine('Sender address', email.from.address))
  const to = address('To address', oneLine('To address', email.to))
  const name = oneLine('display name', email.from.displayName).trim()
  const subject = oneLine('subject', email.subject)
  const fileName = oneLine('Resume file name', email.attachment.name)
  const body = email.body.replace(/\r\n|\r|\n/g, CRLF)

  const headers = [
    `From: ${name === '' ? from : `${phrase(name)} <${from}>`}`,
    `To: ${to}`,
    `Subject: ${unstructured(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ]
  const text = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(body, 'utf8')),
  ]
  const type = mediaType(email.attachment.mimeType)
  const attachment = [
    `Content-Type: ${type}; ${mimeParam('name', fileName)}`,
    `Content-Disposition: attachment; ${mimeParam('filename', fileName)}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(email.attachment.data),
  ]
  return [
    ...headers,
    '',
    `--${boundary}`,
    ...text,
    `--${boundary}`,
    ...attachment,
    `--${boundary}--`,
    '',
  ].join(CRLF)
}
