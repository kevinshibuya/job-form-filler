import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MailWizard } from './MailWizard'
import { installFakeBrowser } from './testing/fakeBrowser'

/**
 * The Mail wizard (spec #66, ticket #77): one card per console step of the
 * research document, in its order, each with its deep link, the values to
 * paste with a copy action, and a mark for done that survives closing the
 * page and restarting the browser.
 */

const browser = installFakeBrowser()

/** The research document as a reader sees it, read from disk. */
const DOC = readFileSync(resolve(__dirname, '../../../docs/research/apply-by-email-facts.md'), 'utf8')
const CONSOLE = DOC.slice(DOC.indexOf('## Console steps'))
const DOC_STEPS = CONSOLE.split(/^### /m).slice(1).map((block) => {
  const heading = block.slice(0, block.indexOf('\n'))
  const link = /^Link: (.*)$/m.exec(block)![1]!
  const paste = block.slice(block.indexOf('Paste:'), block.indexOf('Done when:'))
  return {
    title: heading.replace(/^\d+\.\s*/, ''),
    link: link.startsWith('https://') ? link : null,
    values: [...new Set([...paste.matchAll(/`([^`]+)`/g)].map((m) => m[1]!))],
  }
})

const PROJECT = 'ada-jff-4242'

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-jff-step]')]
const cardTitled = (title: string): HTMLElement => cards().find((c) => c.querySelector('h3')?.textContent?.endsWith(title))!
const titles = (): string[] => cards().map((c) => c.querySelector('h3')!.textContent!.replace(/^\d+\.\s*/, ''))
const consoleLink = (card: HTMLElement): HTMLAnchorElement | null =>
  within(card).queryByRole('link', { name: 'Open in Google Cloud' }) as HTMLAnchorElement | null
const values = (card: HTMLElement): string[] => [...card.querySelectorAll('[data-jff-paste] code')].map((c) => c.textContent!)
const doneSwitch = (card: HTMLElement): HTMLElement => within(card).getByRole('switch')

async function mount(): Promise<ReturnType<typeof render>> {
  const view = render(<MailWizard />)
  await waitFor(() => expect(document.querySelector('[data-jff-wizard-loaded]')).not.toBeNull())
  return view
}

async function typeProject(id = PROJECT): Promise<void> {
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: id } })
}

describe('the Mail wizard shows the console steps', () => {
  it('one card per step of the research document, in its order', async () => {
    await mount()
    expect(DOC_STEPS).toHaveLength(8)
    expect(titles()).toEqual(DOC_STEPS.map((s) => s.title))
    expect(titles()[0]).toBe('Create a Google Cloud project')
    expect(titles()[6]).toBe('Publish the app')
  })

  it('each card links to the document\'s console page, on the typed project', async () => {
    await mount()
    await typeProject()
    DOC_STEPS.forEach((step, i) => {
      const link = consoleLink(cards()[i]!)
      if (step.link === null) expect(link).toBeNull()
      else expect(link!.getAttribute('href')).toBe(step.link.replace('<PROJECT_ID>', PROJECT))
    })
    expect(consoleLink(cardTitled('Turn on the Gmail API'))!.getAttribute('href'))
      .toBe('https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=ada-jff-4242')
    expect(consoleLink(cardTitled('Turn on the Gmail API'))!.getAttribute('target')).toBe('_blank')
  })

  it('a link that needs the project waits for its ID', async () => {
    await mount()
    expect(consoleLink(cardTitled('Create a Google Cloud project'))!.getAttribute('href'))
      .toBe('https://console.cloud.google.com/projectcreate')
    expect(consoleLink(cardTitled('Turn on the Gmail API'))).toBeNull()
    expect(cardTitled('Turn on the Gmail API').textContent).toContain('Type your Project ID in step 1 first.')
  })

  it('each card holds the document\'s values to paste', async () => {
    await mount()
    DOC_STEPS.forEach((step, i) => expect(values(cards()[i]!)).toEqual(step.values))
    expect(values(cardTitled('Add the Gmail permissions'))).toEqual([
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.settings.basic',
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
    ])
    expect(values(cardTitled('Turn on the Gmail API'))).toEqual([])
    // Branding names `github.com` twice; it is one value to copy.
    expect(values(cardTitled('Fill in Branding')).filter((v) => v === 'github.com')).toHaveLength(1)
  })

  it('the copy action puts the value on the clipboard', async () => {
    await mount()
    const scopes = cardTitled('Add the Gmail permissions')
    fireEvent.click(within(scopes).getByRole('button', { name: 'Copy openid' }))
    await waitFor(() => expect(browser.clipboard).toEqual(['openid']))
    expect(within(scopes).getByRole('button', { name: 'Copy openid' }).textContent).toBe('Copied')
  })

  it('the "Publish app" card says why, and a card says to expect the unverified-app screen', async () => {
    await mount()
    expect(cardTitled('Publish the app').textContent).toContain('a client left in Testing gets sign-ins that expire seven days after consent')
    const signIn = cards().find((c) => /has not verified the app/.test(c.textContent ?? ''))!
    expect(signIn.textContent).toContain('Click "Go to Job Form Filler (unsafe)"')
  })
})

describe('the Mail wizard remembers finished steps', () => {
  it('a step marked done is still marked after the page is closed and opened again', async () => {
    const first = await mount()
    await typeProject()
    fireEvent.click(doneSwitch(cardTitled('Create a Google Cloud project')))
    fireEvent.click(doneSwitch(cardTitled('Add the Gmail permissions')))
    await waitFor(() => expect(doneSwitch(cardTitled('Add the Gmail permissions')).getAttribute('aria-checked')).toBe('true'))
    first.unmount()

    await mount()
    await waitFor(() => expect(doneSwitch(cardTitled('Create a Google Cloud project')).getAttribute('aria-checked')).toBe('true'))
    expect(doneSwitch(cardTitled('Add the Gmail permissions')).getAttribute('aria-checked')).toBe('true')
    expect(doneSwitch(cardTitled('Turn on the Gmail API')).getAttribute('aria-checked')).toBe('false')
    expect((screen.getByLabelText('Project ID') as HTMLInputElement).value).toBe(PROJECT)
  })

  it('a step marked done is still marked after a browser restart', async () => {
    const first = await mount()
    await typeProject()
    fireEvent.click(doneSwitch(cardTitled('Publish the app')))
    await waitFor(() => expect(doneSwitch(cardTitled('Publish the app')).getAttribute('aria-checked')).toBe('true'))
    first.unmount()

    browser.restart()

    await mount()
    await waitFor(() => expect(doneSwitch(cardTitled('Publish the app')).getAttribute('aria-checked')).toBe('true'))
    expect((screen.getByLabelText('Project ID') as HTMLInputElement).value).toBe(PROJECT)
  })

  it('a second click on the mark takes it back', async () => {
    await mount()
    const mark = doneSwitch(cardTitled('Fill in Branding'))
    fireEvent.click(mark)
    await waitFor(() => expect(mark.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(mark)
    await waitFor(() => expect(mark.getAttribute('aria-checked')).toBe('false'))
  })
})
