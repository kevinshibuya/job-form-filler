import { describe, it, expect } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { SettingsPage } from './SettingsPage'
import { installFakeBrowser } from './testing/fakeBrowser'

/**
 * The settings page (spec #66, ticket #77), rendered whole on the fake browser:
 * a nav column of sections, a breadcrumb, and the current section's content.
 * In this spec it has one section, Mail, which with no Mail account is the
 * wizard.
 */

installFakeBrowser()

describe('the settings page', () => {
  it('renders its root with the Mail section current in the nav', async () => {
    render(<SettingsPage />)
    expect(document.querySelector('[data-jff-settings-root]')).not.toBeNull()
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const items = within(nav).getAllByRole('link')
    expect(items.map((a) => a.textContent)).toEqual(['Mail'])
    expect(items[0]!.getAttribute('aria-current')).toBe('page')
  })

  it('names the section in its breadcrumb and its tab title', async () => {
    render(<SettingsPage />)
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(crumb.textContent).toBe('Settings/Mail')
    await waitFor(() => expect(document.title).toBe('Mail · Settings · job-form-filler'))
  })

  it('shows the wizard in the Mail section when there is no Mail account', async () => {
    render(<SettingsPage />)
    const mail = screen.getByRole('region', { name: 'Mail' })
    await waitFor(() => expect(within(mail).getAllByRole('switch').length).toBeGreaterThan(0))
    expect(within(mail).getByRole('heading', { name: 'Create your Google client' })).not.toBeNull()
  })
})
