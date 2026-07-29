import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectNotes } from './projects.js'

describe('readProjectNotes', () => {
  it('reads existing files, skips missing ones silently, caps per file and total', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jff-projects-'))
    try {
      writeFileSync(join(dir, 'a.md'), 'ALPHA ' + 'x'.repeat(5_000))
      writeFileSync(join(dir, 'b.md'), 'BRAVO notes')
      const out = readProjectNotes([join(dir, 'a.md'), join(dir, 'missing.md'), join(dir, 'b.md')])
      expect(out).not.toBeNull()
      expect(out).toContain('ALPHA')
      expect(out).toContain('BRAVO notes')
      // per-file cap 4000: the 5000-char tail of a.md is clipped
      expect(out!.length).toBeLessThan(4_200 + 'BRAVO notes'.length + 200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when nothing is readable', () => {
    expect(readProjectNotes(['/nonexistent/jff-nope.md'])).toBeNull()
    expect(readProjectNotes([])).toBeNull()
  })
})
