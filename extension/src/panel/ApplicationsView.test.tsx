import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ApplicationsView, type AppliedJobRow } from './ApplicationsView'

const JOB: AppliedJobRow = {
  id: 1, url: 'https://x.com/j/1', canonicalUrl: 'https://x.com/j/1',
  company: 'Acme', jobTitle: 'Engineer', markedAt: '2026-07-01T12:00:00.000Z',
}

describe('ApplicationsView (A5)', () => {
  it('renders date, company, title and a link out', async () => {
    render(<ApplicationsView load={async () => [JOB]} />)
    await screen.findByText('Engineer')
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText(new Date(JOB.markedAt).toLocaleDateString())).toBeTruthy()
    const a = screen.getByRole('link', { name: 'Open posting' }) as HTMLAnchorElement
    expect(a.href).toBe('https://x.com/j/1')
    expect(a.target).toBe('_blank')
  })

  it('renders the empty state', async () => {
    render(<ApplicationsView load={async () => []} />)
    await screen.findByText('Nothing marked applied yet.')
  })

  it('renders the failure state when load resolves null', async () => {
    render(<ApplicationsView load={async () => null} />)
    await screen.findByText('Could not load your applications.')
  })

  it('falls back to the company, then the url, when the title is null', async () => {
    render(<ApplicationsView load={async () => [{ ...JOB, jobTitle: null }]} />)
    await waitFor(() => expect(screen.getAllByText('Acme').length).toBeGreaterThan(0))
  })
})
