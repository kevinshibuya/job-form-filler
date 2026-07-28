import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProfileEditor } from './ProfileEditor'

describe('ProfileEditor', () => {
  it('refuses to save until the facts have loaded', () => {
    const onSave = vi.fn()
    render(<ProfileEditor values={{}} loaded={false} onSave={onSave} />)
    const btn = screen.getByRole('button', { name: 'Save facts' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('omits a key it never loaded, so a partial load cannot delete stored facts', () => {
    const onSave = vi.fn()
    render(<ProfileEditor values={{ email: 'k@x.com' }} loaded={true} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }))
    const [profile, bank] = onSave.mock.calls[0] as [Record<string, string>, Record<string, string>]
    expect(profile).toEqual({ email: 'k@x.com' })
    expect('firstName' in profile).toBe(false) // never loaded, never sent
    expect(bank).toEqual({})
  })

  it('still sends an explicit empty string for a loaded fact the user cleared', () => {
    const onSave = vi.fn()
    render(<ProfileEditor values={{ email: 'k@x.com' }} loaded={true} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }))
    // Clearing a fact must still reach the host as a delete; only keys the editor
    // never saw are omitted.
    expect((onSave.mock.calls[0] as [Record<string, string>])[0]).toEqual({ email: '' })
  })
})
