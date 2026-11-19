import { test, expect } from '@playwright/test'
import DatabaseCtor from 'better-sqlite3'
import { launchWithExtension, panelUrl, type LaunchedExtension } from './ext'
import { seedOnboardedProfile, seedResume, STUB_RESUME } from './seed'
import { startFixtureServer } from './static-server'
import { startHost } from './hostBridge'

/**
 * Apply by email from Scan to Send (spec #66, ticket #84), in a real Chrome
 * with the real Native host. The page is the sanitised careers page: a Job
 * posting with no form, whose only route is a `mailto:` link with a subject,
 * repeated on the page, and an unrelated footer address. The Native host
 * runs from the test-only entry, which hands its start function the fake
 * Mail account driver and the fake secret store: no request reaches Google
 * and nothing touches the Keychain. The stub CLIs under e2e/bin answer the
 * Apply address pick and the Application email.
 */

const PAGE = 'careers-page.html'
/** The address the fixture's `mailto:` links name, and the one its footer names. */
const APPLY_ADDRESS = 'address-1@example.org'
const FOOTER_ADDRESS = 'address-2@example.org'
/** The fixture links' `subject` parameter, decoded. */
const PAGE_SUBJECT = 'Sollicitatie: Senior full-stack developer'
/** The fake Mail account driver's account. */
const ACCOUNT = 'ada@example.com'

/** The tab showing `needle`, looked up from an extension page, as full-loop.spec.ts does. */
async function tabIdForUrl(ext: LaunchedExtension, needle: string): Promise<number> {
  const lookup = await ext.context.newPage()
  await lookup.goto(`chrome-extension://${ext.extensionId}/manifest.json`)
  const id = await lookup.evaluate(async (n) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((t) => (t.url ?? '').includes(n))?.id ?? null
  }, needle)
  await lookup.close()
  if (id === null) throw new Error(`no tab matching ${needle}`)
  return id
}

// One Chromium with the unpacked extension, a real host child process and
// three stub CLI calls: the same envelope as the full loop.
test.describe.configure({ timeout: 240_000 })

test('a Job posting with no form goes from Scan to a sent Application email and an Applied job', async () => {
  const fixtures = await startFixtureServer('fixtures/email')
  const host = await startHost({ fakeMail: true, address: 'address-1' })
  const ext = await launchWithExtension()

  try {
    seedOnboardedProfile(host.dbPath)
    await seedResume(ext)

    // Connect the fake Mail account through the Native host's own requests,
    // as the settings page does: the sign-in returns at once.
    const started = await host.request({
      requestId: crypto.randomUUID(), method: 'mail.connect.start',
      params: { clientFile: JSON.stringify({ installed: { client_id: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com' } }) },
    })
    expect(started).toMatchObject({ ok: true })
    const connected = await host.request({ requestId: crypto.randomUUID(), method: 'mail.connect.finish', params: {} })
    expect(connected).toMatchObject({ ok: true, result: { state: 'connected', address: ACCOUNT } })

    // The page under test has no form Field, and both addresses are on it.
    const target = await ext.context.newPage()
    await target.goto(`${fixtures.origin}/${PAGE}`)
    await expect(target.locator('input, textarea, select')).toHaveCount(0)
    await expect(target.locator(`a[href^="mailto:${APPLY_ADDRESS}"]`)).toHaveCount(3)
    await expect(target.locator(`a[href="mailto:${FOOTER_ADDRESS}"]`)).toHaveCount(1)
    const tabId = await tabIdForUrl(ext, PAGE)

    // The panel, bridged to the real host. It scans on open; nothing below
    // clicks until Send.
    const panel = await ext.context.newPage()
    await panel.exposeFunction('__jffHostBridge', (req: { requestId: string; method: string; params: unknown }) => host.request(req))
    await panel.goto(panelUrl(ext.extensionId, `?jffFakeHost=1&tabId=${tabId}`))
    await expect(panel.locator('[data-jff-banner="ok"]')).toBeVisible()

    // SCAN: no Field, so the Apply address pick runs, and the pick starts the Draft.
    await expect(panel.locator('[data-jff-status]')).toHaveAttribute('data-jff-status', 'email', { timeout: 60_000 })
    const to = panel.locator('[data-jff-email-to] input')
    await expect(to).toHaveValue(APPLY_ADDRESS, { timeout: 60_000 })
    await expect(to).not.toHaveValue(FOOTER_ADDRESS)
    await expect(panel.locator('[data-jff-email-chosen]')).toHaveAttribute('data-jff-email-chosen', 'pick')

    // REVIEW: the Draft arrived, with the page's subject word for word.
    const body = panel.locator('[data-jff-email-body] textarea')
    await expect(body).toHaveValue(/I would like to apply for this role/, { timeout: 60_000 })
    await expect(body).toHaveValue(/Ada Lovelace\s*$/)
    await expect(panel.locator('[data-jff-email-subject] input')).toHaveValue(PAGE_SUBJECT)
    await expect(panel.locator('[data-jff-email-attachment]')).toContainText(STUB_RESUME.name)

    // SEND: one button that names the fake account's address and the Apply address.
    const send = panel.locator('button[data-jff-email-sendmail]')
    await expect(send).toHaveText(`Send from ${ACCOUNT} to ${APPLY_ADDRESS}`, { timeout: 30_000 })
    await expect(send).toBeEnabled()
    expect(host.sentMail()).toEqual([])
    await send.click()

    // The Send went out and ended the Session.
    await expect(panel.locator('[data-jff-applied]')).toContainText('Marked as applied', { timeout: 60_000 })
    await expect(body).toHaveCount(0)

    // The fake driver sent one message, from the account to the Apply
    // address, with the page's subject and the Resume attached.
    const sent = host.sentMail()
    expect(sent).toHaveLength(1)
    expect(sent[0]!).toMatchObject({
      account: ACCOUNT,
      from: { address: ACCOUNT, displayName: 'Ada Lovelace' },
      to: APPLY_ADDRESS,
      subject: PAGE_SUBJECT,
      attachment: { name: STUB_RESUME.name, mimeType: STUB_RESUME.mimeType, dataBase64: STUB_RESUME.dataBase64 },
    })
    expect(sent[0]!.body).toMatch(/I would like to apply for this role/)

    // The Applied job, by email, with its Application email and Gmail's ids.
    const db = new DatabaseCtor(host.dbPath, { readonly: true })
    const jobs = db.prepare('SELECT id, url, channel FROM applied_jobs').all() as { id: number; url: string; channel: string }[]
    const emails = db.prepare('SELECT applied_job_id, apply_address, sender_address, subject, attachment_names, route, gmail_message_id FROM application_emails').all()
    db.close()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.url).toContain(PAGE)
    expect(jobs[0]!.channel).toBe('email')
    expect(emails).toEqual([{
      applied_job_id: jobs[0]!.id, apply_address: APPLY_ADDRESS, sender_address: ACCOUNT, subject: PAGE_SUBJECT,
      attachment_names: JSON.stringify([STUB_RESUME.name]), route: 'tool', gmail_message_id: 'MESSAGE_ID_PLACEHOLDER_1',
    }])

    // The Applications view shows the Applied job with the channel email,
    // and opens its Application email read only.
    await panel.locator('[data-jff-nav-apps]').click()
    const row = panel.locator('[data-jff-apps="1"] li', { has: panel.locator('[data-jff-app-channel="email"]') })
    await expect(row).toHaveCount(1, { timeout: 30_000 })
    await row.getByRole('button', { name: 'Show the Application email' }).click()
    const shown = row.locator('[data-jff-app-email]')
    await expect(shown).toHaveCount(1, { timeout: 30_000 })
    await expect(shown.locator('[data-jff-app-email-to]')).toContainText(APPLY_ADDRESS)
    await expect(shown.locator('[data-jff-app-email-from]')).toContainText(ACCOUNT)
    await expect(shown.locator('[data-jff-app-email-subject]')).toHaveText(PAGE_SUBJECT)
    await expect(shown.locator('[data-jff-app-email-attachments]')).toContainText(STUB_RESUME.name)

    // The real Native host ran, from the test-only entry, and no request
    // left it: the fake driver makes none, and the entry refuses any other.
    expect(host.stderr.join('')).toMatch(/test-only entry: fake Mail account/)
    expect(host.stderr.join('')).toMatch(/host started/)
    expect(host.networkCalls()).toEqual([])
    expect(ext.consoleErrors).toEqual([])
  } finally {
    await ext.close()
    await host.stop()
    await fixtures.stop()
  }
})
