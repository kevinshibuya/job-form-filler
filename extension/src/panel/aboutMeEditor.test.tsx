import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ABOUT_ME_MAX } from '@jff/shared'
import { App } from './App'
import { AboutMeEditor } from './AboutMeEditor'
import { installHeldMappingHost } from './testing/heldMapping'

// Ticket #106 (spec #98): About me, one text the user writes about themselves
// for what no Known key holds, edited beside the Profile editor. The persona
// is Ada Lovelace.

const host = installHeldMappingHost()

const ABOUT_ME = 'I can be on site in London two days a week. I prefer TypeScript and Postgres.'

const box = (): HTMLTextAreaElement => screen.getByLabelText('About me') as HTMLTextAreaElement
const saveBtn = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save About me' }) as HTMLButtonElement
const count = (): string => document.querySelector('[data-jff-about-me-count]')?.textContent ?? ''
const problem = (): string | null => document.querySelector('[data-jff-about-me-problem]')?.textContent ?? null

describe('The About me editor', () => {
  it('is a labelled text area that shows the stored text and how many of the 4,000 characters it uses', () => {
    render(<AboutMeEditor text={ABOUT_ME} loaded={true} onSave={vi.fn(async () => true)} />)
    expect(box().tagName).toBe('TEXTAREA')
    expect(box().value).toBe(ABOUT_ME)
    expect(count()).toBe(`${ABOUT_ME.length} / 4,000 characters`)
  })

  it('saves on the user\'s act only, and counts as the user types', async () => {
    const onSave = vi.fn(async () => true)
    render(<AboutMeEditor text="" loaded={true} onSave={onSave} />)
    expect(count()).toBe('0 / 4,000 characters')
    fireEvent.change(box(), { target: { value: 'I prefer Rust.' } })
    expect(count()).toBe('14 / 4,000 characters')
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(saveBtn())
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('I prefer Rust.'))
  })

  it('does not save past the cap, and says why', () => {
    const onSave = vi.fn(async () => true)
    render(<AboutMeEditor text="" loaded={true} onSave={onSave} />)
    fireEvent.change(box(), { target: { value: 'a'.repeat(ABOUT_ME_MAX + 1) } })
    expect(count()).toBe('4,001 / 4,000 characters')
    expect(problem()).toContain('4,000')
    expect(saveBtn().disabled).toBe(true)
    fireEvent.click(saveBtn())
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.change(box(), { target: { value: 'a'.repeat(ABOUT_ME_MAX) } })
    expect(problem()).toBeNull()
    expect(saveBtn().disabled).toBe(false)
  })

  it('refuses to save until the stored text has loaded', () => {
    const onSave = vi.fn(async () => true)
    render(<AboutMeEditor text="" loaded={false} onSave={onSave} />)
    expect(saveBtn().disabled).toBe(true)
    fireEvent.click(saveBtn())
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('About me in the Side panel', () => {
  const openEditor = async (): Promise<void> => {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit your facts' }))
    await waitFor(() => expect(saveBtn().disabled).toBe(false))
  }

  it('sits beside the Profile editor and shows the stored text', async () => {
    host.aboutMe = ABOUT_ME
    render(<App />)
    await openEditor()
    expect(screen.getByRole('button', { name: 'Save facts' })).toBeTruthy()
    expect(box().value).toBe(ABOUT_ME)
  })

  it('saves an edit and shows it again after the Side panel reloads', async () => {
    const first = render(<App />)
    await openEditor()
    expect(box().value).toBe('')
    fireEvent.change(box(), { target: { value: ABOUT_ME } })
    fireEvent.click(saveBtn())
    await waitFor(() => expect(host.aboutMeSets).toEqual([ABOUT_ME]))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    // Saving About me sends no fact, and the Profile is not written.
    expect(host.methods).not.toContain('profile.set')
    first.unmount()

    render(<App />)
    await openEditor()
    expect(box().value).toBe(ABOUT_ME)
  })
})
