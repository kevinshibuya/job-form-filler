import { render, screen } from '@testing-library/react'
import type { SelfCheck } from '@jff/shared'
import { SelfCheckBanner } from './Banner'

const ready: SelfCheck = {
  node: { ok: true, version: 'v22.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  codex: { ok: true, path: '(fake)', detail: 'found' },
  codexAuth: { ok: true, detail: 'logged in' },
  db: { ok: true, path: '(fake)' },
}

describe('SelfCheckBanner', () => {
  it("shows the host's reason when it refused the database", () => {
    const reason = 'The database comes from a newer version of the tool (schema version 9; this Native host knows up to 1).'
    render(<SelfCheckBanner check={{ ...ready, db: { ok: false, path: '(fake)', detail: reason } }} error={null} />)
    expect(screen.getByText(reason)).toBeTruthy()
  })

  it('falls back to "not writable" when an older host gives no reason', () => {
    render(<SelfCheckBanner check={{ ...ready, db: { ok: false, path: '(fake)' } }} error={null} />)
    expect(screen.getByText('Database not writable at (fake).')).toBeTruthy()
  })
})
