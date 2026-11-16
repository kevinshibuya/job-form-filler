import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProfileEditor } from './ProfileEditor'

// Ticket #25: the Profile editor shows city, region, country, current company
// and current title, empty until the user enters or confirms a Value. Nothing
// is derived from the location line.

const NEW_KEYS: [string, string][] = [
  ['city', 'City'],
  ['region', 'State or region'],
  ['country', 'Country'],
  ['currentCompany', 'Current company'],
  ['currentTitle', 'Current title'],
]

/** A Profile stored before this ticket: a location line and none of the five. */
const OLD_PROFILE = {
  fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+1 555 0100', location: 'London, United Kingdom',
}

const input = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement

describe('the Profile editor and the five new Known keys', () => {
  it('shows each of the five keys, empty for a Profile stored before them, even with a location line', () => {
    render(<ProfileEditor values={OLD_PROFILE} loaded={true} onSave={vi.fn()} />)
    for (const [, label] of NEW_KEYS) expect(input(label).value, label).toBe('')
    expect(input('Current location').value).toBe('London, United Kingdom')
  })

  it('saving an old Profile untouched sends none of the five keys', () => {
    const onSave = vi.fn()
    render(<ProfileEditor values={OLD_PROFILE} loaded={true} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }))
    const [profile] = onSave.mock.calls[0] as [Record<string, string>]
    for (const [key] of NEW_KEYS) expect(key in profile, key).toBe(false)
  })

  it('sends the five keys as Profile keys once entered', () => {
    const onSave = vi.fn()
    render(<ProfileEditor values={OLD_PROFILE} loaded={true} onSave={onSave} />)
    fireEvent.change(input('City'), { target: { value: 'London' } })
    fireEvent.change(input('State or region'), { target: { value: 'Greater London' } })
    fireEvent.change(input('Country'), { target: { value: 'United Kingdom' } })
    fireEvent.change(input('Current company'), { target: { value: 'Analytical Engines Ltd' } })
    fireEvent.change(input('Current title'), { target: { value: 'Mathematician' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }))
    const [profile, bank] = onSave.mock.calls[0] as [Record<string, string>, Record<string, string>]
    expect(profile).toMatchObject({
      city: 'London', region: 'Greater London', country: 'United Kingdom',
      currentCompany: 'Analytical Engines Ltd', currentTitle: 'Mathematician',
    })
    for (const [key] of NEW_KEYS) expect(key in bank, key).toBe(false)
  })

  it('the Resume step proposes the five keys into the editor, and nothing is stored until Save', async () => {
    const onSave = vi.fn()
    const onExtract = vi.fn(async () => ({
      city: 'London', region: 'Greater London', country: 'United Kingdom',
      currentCompany: 'Analytical Engines Ltd', currentTitle: 'Mathematician',
    }))
    render(<ProfileEditor values={OLD_PROFILE} loaded={true} onSave={onSave} onExtract={onExtract} />)
    fireEvent.change(input('Current title'), { target: { value: 'Analyst' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate from CV' }))
    await waitFor(() => expect(input('Country').value).toBe('United Kingdom'))
    expect(input('City').value).toBe('London')
    expect(input('State or region').value).toBe('Greater London')
    expect(input('Current company').value).toBe('Analytical Engines Ltd')
    expect(input('Current title').value).toBe('Analyst') // the user's typing wins
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }))
    expect((onSave.mock.calls[0] as [Record<string, string>])[0]).toMatchObject({ country: 'United Kingdom', currentTitle: 'Analyst' })
  })
})
