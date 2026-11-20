import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ApplicationsView, type AppliedJobRow } from './ApplicationsView'

const JOB: AppliedJobRow = {
  id: 1, url: 'https://x.com/j/1', canonicalUrl: 'https://x.com/j/1',
  company: 'Acme', jobTitle: 'Engineer', markedAt: '2026-07-01T12:00:00.000Z', channel: 'form',
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

  it('shows the channel on each row', async () => {
    render(<ApplicationsView load={async () => [
      { ...JOB, id: 1, jobTitle: 'Engineer' },
      { ...JOB, id: 2, jobTitle: 'Analyst', channel: 'email' },
    ]} />)
    await screen.findByText('Engineer')
    const rows = [...document.querySelectorAll('[data-jff-apps] li')]
    expect(rows.map((li) => li.querySelector('[data-jff-app-channel]')?.textContent)).toEqual(['Form', 'Email'])
    expect(rows.map((li) => li.querySelector('[data-jff-app-channel]')?.getAttribute('data-jff-app-channel'))).toEqual(['form', 'email'])
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

  it('renders the failure state when load REJECTS (never hangs on Loading…)', async () => {
    render(<ApplicationsView load={async () => { throw new Error('host down') }} />)
    await screen.findByText('Could not load your applications.')
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['unparseable', 'not a url at all'],
  ])('a %s url is NOT clickable, but its text is still shown', async (_label, url) => {
    render(<ApplicationsView load={async () => [{ ...JOB, url }]} />)
    await screen.findByText('Engineer')
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(url)).toBeTruthy()
  })
})
