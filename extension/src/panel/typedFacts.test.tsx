import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProfileEditor } from './ProfileEditor'
import { OnboardingView } from './OnboardingView'

// Ticket #27: `relocate` is a yes or a no and `phone` is stored in
// international form. Old text stays visible as a hint beside its key and the
// key has no Value until the user enters one. The one proposal the editor
// makes by itself is the phone's. The persona is Ada Lovelace.

const BASE = { fullName: 'Ada Lovelace', email: 'ada@example.com', country: 'United States' }

const input = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement
const hint = (key: string): string | null =>
  document.querySelector(`[data-jff-fact-hint="${key}"]`)?.textContent ?? null
const problem = (key: string): string | null =>
  document.querySelector(`[data-jff-fact-problem="${key}"]`)?.textContent ?? null
const saveBtn = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save facts' }) as HTMLButtonElement
const proposal = (): HTMLButtonElement | null => screen.queryByRole('button', { name: /^Use \+/ }) as HTMLButtonElement | null

function editor(values: Record<string, string>) {
  const onSave = vi.fn()
  render(<ProfileEditor values={values} loaded={true} onSave={onSave} />)
  const saved = (): [Record<string, string>, Record<string, string>] => {
    fireEvent.click(saveBtn())
    return onSave.mock.calls.at(-1) as [Record<string, string>, Record<string, string>]
  }
  return { onSave, saved }
}

describe('relocate in the Profile editor', () => {
  it('offers a yes or a no, unset until chosen, and old text stays as a hint', () => {
    editor({ ...BASE, phone: '+15550100', relocate: 'Yes, anywhere in Europe' })
    const select = screen.getByLabelText('Willing to relocate') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('')
    expect([...select.options].map((o) => o.textContent)).toEqual(['Not set', 'Yes', 'No'])
    expect(hint('relocate')).toContain('Yes, anywhere in Europe')
  })

  it('saving without a choice keeps the old text stored: relocate is not sent', () => {
    const { saved } = editor({ ...BASE, phone: '+15550100', relocate: 'Yes, anywhere in Europe' })
    const [, bank] = saved()
    expect('relocate' in bank).toBe(false)
  })

  it('choosing yes stores yes', () => {
    const { saved } = editor({ ...BASE, phone: '+15550100', relocate: 'Yes, anywhere in Europe' })
    fireEvent.change(screen.getByLabelText('Willing to relocate'), { target: { value: 'yes' } })
    expect(saved()[1]).toMatchObject({ relocate: 'yes' })
  })

  it('a stored yes is shown chosen, with no hint', () => {
    editor({ ...BASE, phone: '+15550100', relocate: 'yes' })
    expect((screen.getByLabelText('Willing to relocate') as HTMLSelectElement).value).toBe('yes')
    expect(hint('relocate')).toBeNull()
  })
})

describe('phone in the Profile editor', () => {
  it('an old phone has no Value: the box is empty and the old text is a hint', () => {
    editor({ ...BASE, phone: '(555) 010-0100' })
    expect(input('Phone').value).toBe('')
    expect(hint('phone')).toContain('(555) 010-0100')
  })

  it('with a country of United States, "(555) 010-0100" is proposed as "+15550100100", stored only once confirmed', () => {
    const { onSave, saved } = editor({ ...BASE, phone: '(555) 010-0100' })
    expect(proposal()?.textContent).toBe('Use +15550100100')
    expect(onSave).not.toHaveBeenCalled()
    // Saved without the confirmation, the old phone is not touched.
    expect('phone' in saved()[0]).toBe(false)
    fireEvent.click(proposal()!)
    expect(input('Phone').value).toBe('+15550100100')
    expect(saved()[0]).toMatchObject({ phone: '+15550100100' })
  })

  it('an old "+1 555 0100" is proposed as "+15550100"', () => {
    editor({ ...BASE, phone: '+1 555 0100' })
    expect(proposal()?.textContent).toBe('Use +15550100')
  })

  it('a stored "+15550100" is a Value with no proposal and no hint', () => {
    editor({ ...BASE, phone: '+15550100' })
    expect(input('Phone').value).toBe('+15550100')
    expect(proposal()).toBeNull()
    expect(hint('phone')).toBeNull()
  })

  it('with no stored country and an old number without a plus sign, no proposal', () => {
    const { country: _c, ...noCountry } = BASE
    editor({ ...noCountry, phone: '(555) 010-0100' })
    expect(hint('phone')).toContain('(555) 010-0100')
    expect(proposal()).toBeNull()
  })

  it('the proposal follows the country typed in the form', () => {
    const { country: _c, ...noCountry } = BASE
    editor({ ...noCountry, phone: '(555) 010-0100' })
    fireEvent.change(input('Country'), { target: { value: 'United States' } })
    expect(proposal()?.textContent).toBe('Use +15550100100')
  })

  it('a phone typed without a plus sign is named beside the phone and Save is held, never a failed save', () => {
    const { onSave } = editor({ ...BASE, phone: '+15550100' })
    fireEvent.change(input('Phone'), { target: { value: '555 0100' } })
    expect(problem('phone')).toMatch(/international form/)
    expect(saveBtn().disabled).toBe(true)
    fireEvent.click(saveBtn())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a phone typed with spaces is sent in the stored form', () => {
    const { saved } = editor({ ...BASE, phone: '+15550100' })
    fireEvent.change(input('Phone'), { target: { value: '+1 555 0100 100' } })
    expect(problem('phone')).toBeNull()
    expect(saved()[0]).toMatchObject({ phone: '+15550100100' })
  })
})

describe('phone in Onboarding', () => {
  type Props = Parameters<typeof OnboardingView>[0]
  function mount(over: Partial<Props>): Props {
    const props: Props = {
      values: {}, loaded: true, resumeName: 'cv.pdf',
      onUpload: vi.fn(async () => null), onExtract: vi.fn(async () => null), onFinish: vi.fn(async () => undefined),
      ...over,
    }
    render(<OnboardingView {...props} />)
    return props
  }
  const finish = (): HTMLButtonElement => screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement
  const missing = (): string => document.querySelector('[data-jff-ob-missing]')?.textContent ?? ''
  const ob = (label: RegExp): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement

  it('a Resume phone of "(555) 010-0100" with a country of United States shows the proposal; Finish stores it once confirmed', async () => {
    const props = mount({
      onUpload: vi.fn(async () => 'CV TEXT'),
      onExtract: vi.fn(async () => ({ fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '(555) 010-0100' })),
    })
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(ob(/^Email/).value).toBe('ada@example.com'))
    expect(ob(/^Phone/).value).toBe('')
    expect(hint('phone')).toContain('(555) 010-0100')
    expect(proposal()).toBeNull() // no country yet, no plus sign
    fireEvent.change(ob(/^Country/), { target: { value: 'United States' } })
    expect(proposal()?.textContent).toBe('Use +15550100100')

    // Without the confirmation the form names the phone as missing, and Finish cannot fail a save.
    expect(finish().disabled).toBe(true)
    expect(missing()).toMatch(/phone/)
    fireEvent.click(finish())
    expect(props.onFinish).not.toHaveBeenCalled()

    fireEvent.click(proposal()!)
    await waitFor(() => expect(finish().disabled).toBe(false))
    expect(missing()).toBe('')
    fireEvent.click(finish())
    await waitFor(() => expect(props.onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+15550100100', country: 'United States' }), expect.anything(),
    ))
  })

  it('a Profile whose phone is still old text lands in Onboarding with the proposal', () => {
    mount({ values: { ...BASE, phone: '(555) 010-0100' } })
    expect(hint('phone')).toContain('(555) 010-0100')
    expect(proposal()?.textContent).toBe('Use +15550100100')
    expect(finish().disabled).toBe(true)
    expect(missing()).toMatch(/phone/)
  })
})
