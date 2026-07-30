import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OnboardingView } from './OnboardingView'

type Props = Parameters<typeof OnboardingView>[0]

function mount(over: Partial<Props> = {}): Props {
  const props: Props = {
    values: {},
    loaded: true,
    resumeName: null,
    onUpload: vi.fn(async () => null),
    onExtract: vi.fn(async () => null),
    onFinish: vi.fn(async () => undefined),
    ...over,
  }
  render(<OnboardingView {...props} />)
  return props
}

const fileInput = (): HTMLInputElement => document.querySelector('input[type="file"]') as HTMLInputElement
const finishBtn = (): HTMLButtonElement => screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement

describe('OnboardingView (O2)', () => {
  it('Finish stays disabled until resume + core facts are present', async () => {
    mount({ resumeName: 'cv.pdf' })
    expect(finishBtn().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    await waitFor(() => expect(finishBtn().disabled).toBe(false))
  })

  it('without a resume, Finish stays disabled even with every fact typed', () => {
    mount({ resumeName: null })
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    expect(finishBtn().disabled).toBe(true)
  })

  it('a PDF upload auto-extracts and pre-fills EMPTY fields only', async () => {
    const props = mount({
      resumeName: null,
      onUpload: vi.fn(async () => 'CV TEXT'),
      onExtract: vi.fn(async () => ({ email: 'cv@x.dev', phone: '123' })),
    })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '999' } })
    fireEvent.change(fileInput(), { target: { files: [new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(props.onExtract).toHaveBeenCalledWith('CV TEXT'))
    await waitFor(() => expect((screen.getByLabelText(/^Email/) as HTMLInputElement).value).toBe('cv@x.dev'))
    expect((screen.getByLabelText(/^Phone/) as HTMLInputElement).value).toBe('999')
  })

  it('a non-PDF upload stores the blob but never calls extract', async () => {
    const props = mount({ onUpload: vi.fn(async () => null) })
    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'cv.docx')] } })
    await waitFor(() => expect(props.onUpload).toHaveBeenCalled())
    expect(props.onExtract).not.toHaveBeenCalled()
  })

  it('Finish splits profile and answer-bank keys', async () => {
    const props = mount({ resumeName: 'cv.pdf' })
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    fireEvent.change(screen.getByLabelText(/^Salary expectation/), { target: { value: '100k' } })
    await waitFor(() => expect(finishBtn().disabled).toBe(false))
    fireEvent.click(finishBtn())
    await waitFor(() => expect(props.onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'k@x.dev', phone: '1', fullName: 'Kevin B' }),
      expect.objectContaining({ salary: '100k' }),
    ))
  })

  it('required keys wear the marker; optional keys do not', () => {
    mount({})
    const labelFor = (id: string): string =>
      document.querySelector(`label[for="ob-${id}"]`)?.textContent ?? ''
    for (const k of ['email', 'phone', 'fullName', 'firstName', 'lastName']) {
      expect(labelFor(k)).toContain('*')
    }
    expect(labelFor('salary')).not.toContain('*')
  })
})
