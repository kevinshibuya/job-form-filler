import { describe, it, expect } from 'vitest'
import { EnumFieldSchema, HostRequestSchema, HostResponseSchema, ContentMessageSchema, FillReportSchema, ResolveFirstResultSchema, ResolveMappingResultSchema, SaveItemSchema, OptionPickResultSchema, ResolutionSchema, ScanResultSchema, ApplyAddressPickResultSchema } from './messages.js'
import { ApplyAddressCandidateSchema, ApplyAddressChoiceSchema, FoundAddressSchema, isAddressShape } from './messages.js'
import { EMAIL_INSTRUCTION_MAX, EmailDraftResultSchema } from './messages.js'
import { captureField, captureRefusal, captureResolution, CaptureSaveParamsSchema, withoutQuery } from './capture.js'
import { JobTextReplySchema, JobTextSourceSchema } from './jobText.js'

const handle = { frameId: 0, fid: 3, epoch: 7 }

describe('EnumFieldSchema', () => {
  it('accepts a well-formed field', () => {
    const parsed = EnumFieldSchema.parse({
      ...handle, label: 'First Name', name: 'first_name', idAttr: 'first_name',
      kind: 'text', options: [], required: true, visible: true,
      currentValue: '', demographic: false,
    })
    expect(parsed.fid).toBe(3)
  })

  it('rejects an unknown widget kind', () => {
    expect(() => EnumFieldSchema.parse({
      ...handle, label: null, name: null, idAttr: null, kind: 'canvas',
      options: [], required: false, visible: true, currentValue: null, demographic: false,
    })).toThrow()
  })

  it('accepts the choice kind with a description', () => {
    const r = EnumFieldSchema.safeParse({
      frameId: 0, fid: 1, epoch: 2, label: 'Authorized to work?', name: 'u1', idAttr: null,
      kind: 'choice', options: ['Yes', 'No'], required: true, visible: false,
      currentValue: null, demographic: false, description: 'Answer for your current country.',
    })
    expect(r.success).toBe(true)
  })

  it('accepts a field WITHOUT description (stale content script)', () => {
    const r = EnumFieldSchema.safeParse({
      frameId: 0, fid: 1, epoch: 2, label: 'X', name: null, idAttr: null,
      kind: 'text', options: [], required: false, visible: true,
      currentValue: null, demographic: false,
    })
    expect(r.success).toBe(true)
  })
})

describe('HostRequestSchema', () => {
  it('rejects the single resolve request, which the two Resolution requests replaced', () => {
    const gone = 'resolve'
    expect(HostRequestSchema.safeParse({
      requestId: 'r1', method: gone,
      params: { epoch: 7, url: 'https://boards.greenhouse.io/x', hostname: 'boards.greenhouse.io', company: 'X', jobText: 'hi', fields: [] },
    }).success).toBe(false)
  })

  it('rejects an unknown method', () => {
    expect(() => HostRequestSchema.parse({ requestId: 'r1', method: 'rm-rf', params: {} })).toThrow()
  })

  it('rejects a missing requestId', () => {
    expect(() => HostRequestSchema.parse({ method: 'selfCheck', params: {} })).toThrow()
  })

  it('accepts a generate request with and without a description', () => {
    const base = {
      requestId: 'r1', method: 'generate' as const,
      params: { handle: { frameId: 0, fid: 1, epoch: 2 }, questionRaw: 'Q', jobText: '', company: null },
    }
    expect(HostRequestSchema.safeParse(base).success).toBe(true)
    expect(HostRequestSchema.safeParse({
      ...base, params: { ...base.params, description: 'Please include a timeline.' },
    }).success).toBe(true)
  })

  it('round-trips the generate description instead of stripping it', () => {
    const parsed = HostRequestSchema.parse({
      requestId: 'r2', method: 'generate',
      params: { handle: { frameId: 0, fid: 1, epoch: 2 }, questionRaw: 'Q', jobText: '', company: null, description: 'D' },
    })
    if (parsed.method !== 'generate') throw new Error('wrong branch')
    expect(parsed.params.description).toBe('D')
  })
})

describe('Resolution in two requests', () => {
  const params = { epoch: 7, url: 'https://boards.greenhouse.io/x', hostname: 'boards.greenhouse.io', company: null, jobText: '', fields: [] }
  const resolution = { handle, tier: 'auto', value: 'ada@example.com', source: 'profile', key: 'email', answerId: null, reason: 'recognizer:email' }

  it('accepts resolve.first and resolve.mapping with the same Scan params', () => {
    for (const method of ['resolve.first', 'resolve.mapping'] as const) {
      const parsed = HostRequestSchema.parse({ requestId: `r-${method}`, method, params })
      expect(parsed.method).toBe(method)
    }
  })

  it('carries the Scan\'s ATS on either request, and accepts a request with none', () => {
    for (const method of ['resolve.first', 'resolve.mapping'] as const) {
      const parsed = HostRequestSchema.parse({ requestId: `r-${method}`, method, params: { ...params, ats: 'greenhouse' } })
      expect(parsed.params).toMatchObject({ ats: 'greenhouse' })
      const without = HostRequestSchema.parse({ requestId: `r0-${method}`, method, params })
      expect((without.params as { ats?: string }).ats).toBeUndefined()
    }
    expect(HostRequestSchema.safeParse({ requestId: 'r3', method: 'resolve.first', params: { ...params, ats: '' } }).success).toBe(false)
  })

  it('rejects either request without its fields', () => {
    const { fields: _fields, ...noFields } = params
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'resolve.first', params: noFields }).success).toBe(false)
    expect(HostRequestSchema.safeParse({ requestId: 'r2', method: 'resolve.mapping', params: noFields }).success).toBe(false)
  })

  it('shapes the resolve.first reply as resolutions plus pending handles', () => {
    expect(ResolveFirstResultSchema.safeParse({ epoch: 7, resolutions: [resolution], pending: [handle] }).success).toBe(true)
    expect(ResolveFirstResultSchema.safeParse({ epoch: 7, resolutions: [resolution] }).success).toBe(false)
  })

  it('shapes the resolve.mapping reply as resolutions plus the Mapping error', () => {
    expect(ResolveMappingResultSchema.safeParse({ epoch: 7, resolutions: [resolution], llmError: null }).success).toBe(true)
    expect(ResolveMappingResultSchema.safeParse({ epoch: 7, resolutions: [], llmError: { kind: 'rate_limit', message: 'limit' } }).success).toBe(true)
    expect(ResolveMappingResultSchema.safeParse({ epoch: 7, resolutions: [] }).success).toBe(false)
  })
})

describe('HostRequestSchema — applied.* (A1)', () => {
  it('accepts the three applied methods', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'applied.mark', params: { url: 'https://x.com/j/1', company: null, jobTitle: null } }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'r2', method: 'applied.check', params: { url: 'https://x.com/j/1' } }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'r3', method: 'applied.list', params: {} }).success).toBe(true)
  })

  it('rejects applied.mark without a url', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r4', method: 'applied.mark', params: { company: null, jobTitle: null } }).success).toBe(false)
  })
})

describe('HostResponseSchema', () => {
  it('accepts an error response with a taxonomy kind', () => {
    const res = HostResponseSchema.parse({
      requestId: 'r1', ok: false, error: { kind: 'not_authed', message: 'nope' },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects an error kind outside the taxonomy', () => {
    expect(() => HostResponseSchema.parse({
      requestId: 'r1', ok: false, error: { kind: 'kaboom', message: 'x' },
    })).toThrow()
  })
})

describe('ContentMessageSchema', () => {
  it('accepts a fill message carrying the identity triple', () => {
    const msg = ContentMessageSchema.parse({
      type: 'JFF_FILL', epoch: 7,
      fills: [{ handle, value: 'ada@example.com' }],
    })
    expect(msg.type).toBe('JFF_FILL')
  })

  it('carries the candidate words of a Value with its fill, and keeps them through parsing', () => {
    const msg = ContentMessageSchema.parse({
      type: 'JFF_FILL', epoch: 7,
      fills: [{ handle, value: 'Germany', candidates: ['Germany', 'Alemanha'] }, { handle, value: 'Ada' }],
    })
    expect(msg.type === 'JFF_FILL' && msg.fills.map((f) => f.candidates)).toEqual([['Germany', 'Alemanha'], undefined])
  })

  it('rejects candidate words that are not strings', () => {
    expect(ContentMessageSchema.safeParse({
      type: 'JFF_FILL', epoch: 7, fills: [{ handle, value: 'Germany', candidates: [1] }],
    }).success).toBe(false)
  })
})

describe('ResolutionSchema — candidate words (#26)', () => {
  const base = { handle, tier: 'auto', value: 'Germany', source: 'profile', key: 'country', answerId: null, reason: 'recognizer:country' }

  it('carries the candidate words of its Value through parsing', () => {
    const parsed = ResolveFirstResultSchema.parse({
      epoch: 7, resolutions: [{ ...base, candidates: ['Germany', 'Alemanha'] }], pending: [],
    })
    expect(parsed.resolutions[0]!.candidates).toEqual(['Germany', 'Alemanha'])
  })

  it('accepts a Resolution with no candidate words', () => {
    expect(ResolveFirstResultSchema.parse({ epoch: 7, resolutions: [base], pending: [] }).resolutions[0]!.candidates).toBeUndefined()
  })
})

describe('ContentMessageSchema — a Scan opens no menu (ADR 0009)', () => {
  it('rejects the removed message that opened dropdowns for a Scan, as any unknown one', () => {
    expect(ContentMessageSchema.safeParse({ type: 'JFF_HARVEST', epoch: 3, fids: [0, 4, 9] }).success).toBe(false)
    expect(ContentMessageSchema.safeParse({ type: 'JFF_NOPE', epoch: 3 }).success).toBe(false)
  })
})

describe('EnumFieldSchema — accept attribute (A8)', () => {
  it('accepts a file field carrying accept, and one without (stale content script)', () => {
    const base = {
      frameId: 0, fid: 1, epoch: 2, label: 'Resume', name: 'resume', idAttr: null,
      kind: 'file', options: [], required: true, visible: true,
      currentValue: null, demographic: false,
    }
    expect(EnumFieldSchema.safeParse({ ...base, accept: '.pdf,.doc,.docx' }).success).toBe(true)
    expect(EnumFieldSchema.safeParse(base).success).toBe(true)
  })

  it('round-trips accept instead of stripping it', () => {
    const parsed = EnumFieldSchema.parse({
      frameId: 0, fid: 1, epoch: 2, label: null, name: null, idAttr: null,
      kind: 'file', options: [], required: false, visible: false,
      currentValue: null, demographic: false, accept: 'application/pdf',
    })
    expect(parsed.accept).toBe('application/pdf')
  })
})

describe('FillReportSchema — committed canonical text (B1c)', () => {
  const handle = { frameId: 0, fid: 1, epoch: 7 }

  it('accepts filled entries carrying the committed page text (or null)', () => {
    const r = FillReportSchema.safeParse({
      epoch: 7,
      filled: [{ handle, committed: 'Brazil' }, { handle, committed: null }],
      failed: [],
    })
    expect(r.success).toBe(true)
  })

  it('carries the Options a choice Fill read, on a hit and on a miss', () => {
    const r = FillReportSchema.parse({
      epoch: 7,
      filled: [{ handle, committed: null, options: ['Yes', 'No'] }],
      failed: [{ handle, reason: 'no-matching-option', options: ['Yes', 'No'] }],
    })
    expect(r.filled[0]!.options).toEqual(['Yes', 'No'])
    expect(r.failed[0]!.options).toEqual(['Yes', 'No'])
  })

  it('accepts entries with no Options, as a text Fill reports them', () => {
    const r = FillReportSchema.parse({ epoch: 7, filled: [{ handle, committed: null }], failed: [{ handle, reason: 'value-rejected' }] })
    expect(r.filled[0]!.options).toBeUndefined()
    expect(r.failed[0]!.options).toBeUndefined()
  })

  it('rejects the old bare-handle filled shape', () => {
    const r = FillReportSchema.safeParse({ epoch: 7, filled: [handle], failed: [] })
    expect(r.success).toBe(false)
  })
})

describe('generate cvText + facts.extract (B2b/B6)', () => {
  it('accepts a generate request with optional cvText', () => {
    const r = HostRequestSchema.safeParse({
      requestId: 'g1', method: 'generate',
      params: { handle: { frameId: 0, fid: 1, epoch: 1 }, questionRaw: 'Why us?', jobText: '', company: null, cvText: 'CV BODY' },
    })
    expect(r.success).toBe(true)
  })

  it('still accepts a generate request without cvText', () => {
    const r = HostRequestSchema.safeParse({
      requestId: 'g2', method: 'generate',
      params: { handle: { frameId: 0, fid: 1, epoch: 1 }, questionRaw: 'Why us?', jobText: '', company: null },
    })
    expect(r.success).toBe(true)
  })

  it('accepts facts.extract with non-empty cvText and rejects empty', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'f1', method: 'facts.extract', params: { cvText: 'CV' } }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'f2', method: 'facts.extract', params: { cvText: '' } }).success).toBe(false)
  })
})

describe('SaveItemSchema', () => {
  const item = {
    handle, questionRaw: 'Are you authorised to work?', answer: 'Yes',
    reusability: 'reusable' as const,
  }

  it('rejects a non-null fieldKey, so a fact can never ride Save answers into a store', () => {
    expect(SaveItemSchema.safeParse({ ...item, fieldKey: 'github' }).success).toBe(false)
    expect(SaveItemSchema.safeParse({ ...item, fieldKey: 'workAuth' }).success).toBe(false)
  })

  it('still requires the property, and accepts it as null', () => {
    expect(SaveItemSchema.safeParse({ ...item, fieldKey: null }).success).toBe(true)
    expect(SaveItemSchema.safeParse(item).success).toBe(false)
  })

  it('rejects a whole save request carrying a keyed item', () => {
    const r = HostRequestSchema.safeParse({
      requestId: 's1', method: 'save',
      params: {
        url: 'https://x.test/apply', company: null, jobTitle: null,
        items: [{ ...item, fieldKey: 'github' }], generatedCount: 0,
      },
    })
    expect(r.success).toBe(false)
  })
})

describe('option.pick — the model picks one of the page\'s Options (#31, ADR 0008)', () => {
  const pick = { label: 'Are you open to relocation?', value: 'Yes', options: ['Yes, I am', 'No, I am not'] }

  it('accepts a request carrying the label, the stored Value and the Options', () => {
    const r = HostRequestSchema.safeParse({ requestId: 'r1', method: 'option.pick', params: pick })
    expect(r.success).toBe(true)
  })

  it('refuses a request with no Options to pick from', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'option.pick', params: { ...pick, options: [] } }).success).toBe(false)
  })

  it('the reply is a position or none, and carries no text', () => {
    expect(OptionPickResultSchema.parse({ position: 1 })).toEqual({ position: 1 })
    expect(OptionPickResultSchema.parse({ position: null })).toEqual({ position: null })
    expect(OptionPickResultSchema.parse({ position: 0, value: 'Yes, definitely', text: 'x' })).toEqual({ position: 0 })
    expect(OptionPickResultSchema.safeParse({ position: 'Yes' }).success).toBe(false)
    expect(OptionPickResultSchema.safeParse({ position: -1 }).success).toBe(false)
    expect(OptionPickResultSchema.safeParse({ position: 1.5 }).success).toBe(false)
  })
})

describe('ResolutionSchema — the stored Value a picked Option stands for (#31)', () => {
  it('round-trips standsFor', () => {
    const r = ResolutionSchema.parse({
      handle, tier: 'proposed', value: 'Yes, I am', source: 'answer_bank', key: 'relocate', answerId: null,
      reason: 'option-pick', standsFor: 'Yes',
    })
    expect(r.standsFor).toBe('Yes')
  })
})

describe('a Capture (spec #41)', () => {
  const field = {
    ...handle, label: 'Country', name: 'country', idAttr: null, kind: 'combobox' as const,
    options: [], required: true, visible: true, currentValue: null, demographic: false,
  }
  const params = {
    page: { html: '<!DOCTYPE html><html><body><form></form></body></html>', cut: false },
    ats: 'lever',
    url: 'https://jobs.lever.co/acme/123/apply',
    fields: [field],
    resolutions: [{ handle, tier: 'auto' as const, source: 'profile' as const, key: 'country' as const, reason: 'recognizer:country' }],
    election: { frameId: 0, score: 9, url: 'https://jobs.lever.co/acme/123/apply' },
    frameReports: [{ frameId: 0, url: 'https://jobs.lever.co/acme/123/apply', fields: 1, error: null }],
  }

  it('is a host request that carries the page, the ATS, the Fields, the Resolutions, the election and the frame reports', () => {
    const parsed = HostRequestSchema.safeParse({ requestId: 'c1', method: 'capture.save', params })
    expect(parsed.success).toBe(true)
  })

  it('has an optional place for the job text\'s source', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'c2', method: 'capture.save', params: { ...params, jobTextSource: 'heuristic' } }).success).toBe(true)
  })

  it('keeps a sixth key on a Resolution, so the Native host can see it and refuse it', () => {
    const extra = { ...params, resolutions: [{ ...params.resolutions[0], value: 'Canada' }] }
    const parsed = HostRequestSchema.parse({ requestId: 'c3', method: 'capture.save', params: extra })
    if (parsed.method !== 'capture.save') throw new Error('wrong branch')
    expect(Object.keys(parsed.params.resolutions[0]!)).toContain('value')
  })

  it('refuses a cleaned page longer than 2,000,000 characters', () => {
    const long = { ...params, page: { html: 'x'.repeat(2_000_001), cut: true } }
    expect(HostRequestSchema.safeParse({ requestId: 'c4', method: 'capture.save', params: long }).success).toBe(false)
  })

  it('asks a frame for its page with the Values the Side panel knows for it', () => {
    expect(ContentMessageSchema.safeParse({ type: 'JFF_CAPTURE', epoch: 3, held: [{ fid: 2, value: 'Canada' }] }).success).toBe(true)
    expect(ContentMessageSchema.safeParse({ type: 'JFF_CAPTURE', epoch: 3 }).success).toBe(false)
  })
})

describe('what a Capture keeps', () => {
  const resolution = ResolutionSchema.parse({
    handle, tier: 'auto', value: '+44 20 7946 0100', source: 'profile', key: 'phone', answerId: null, reason: 'recognizer:phone',
    candidates: ['United Kingdom', 'Reino Unido'], phone: { callingCode: '44', nationalNumber: '2079460100', countryNames: ['United Kingdom'] },
    city: { countryNames: ['United Kingdom'], region: 'London' }, standsFor: 'x', identifiedValue: 'y', fieldClass: 'personal_fact',
  })

  it('keeps a Resolution\'s five keys and nothing else', () => {
    expect(captureResolution(resolution)).toEqual({ handle, tier: 'auto', source: 'profile', key: 'phone', reason: 'recognizer:phone' })
  })

  it('drops a Field\'s current Value', () => {
    const f = EnumFieldSchema.parse({
      ...handle, label: 'Name', name: 'name', idAttr: null, kind: 'text', options: [], required: true, visible: true, currentValue: 'Ada Lovelace', demographic: false,
    })
    expect(captureField(f)).toEqual({ ...f, currentValue: null })
  })

  it('drops an address\'s query and fragment', () => {
    expect(withoutQuery('https://jobs.lever.co/acme/123/apply?lever-source=x&token=abc#frag')).toBe('https://jobs.lever.co/acme/123/apply')
    expect(withoutQuery('about:srcdoc')).toBe('about:srcdoc')
    expect(withoutQuery(null)).toBeNull()
  })

  it('refuses a Field with a current Value and a Resolution with a sixth key', () => {
    const f = { ...handle, label: 'Name', name: null, idAttr: null, kind: 'text' as const, options: [], required: false, visible: true, currentValue: null, demographic: false }
    const r = captureResolution(resolution)
    expect(captureRefusal({ fields: [f], resolutions: [r] })).toBeNull()
    expect(captureRefusal({ fields: [{ ...f, currentValue: 'Ada' }], resolutions: [r] })).toMatch(/current Value/)
    expect(captureRefusal({ fields: [f], resolutions: [{ ...r, candidates: ['x'] } as typeof r] })).toMatch(/candidates/)
  })
})

describe('ScanResultSchema — the Resume uploaded once per page load (#49)', () => {
  const reply = { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: false, attachedUploads: [] }

  it('keeps the flag a page script sends, so its own check does not strip it', () => {
    expect(ScanResultSchema.parse({ ...reply, resumeUploaded: true }).resumeUploaded).toBe(true)
    expect(ScanResultSchema.parse({ ...reply, resumeUploaded: false }).resumeUploaded).toBe(false)
  })

  it('accepts a reply from a stale page script that omits it', () => {
    expect(ScanResultSchema.parse(reply).resumeUploaded).toBeUndefined()
  })

  it('refuses a flag that is not a boolean', () => {
    expect(ScanResultSchema.safeParse({ ...reply, resumeUploaded: 'yes' }).success).toBe(false)
  })
})

describe('the Job posting text source (spec #41)', () => {
  it('accepts the request that forgets a saved spot for a site', () => {
    const req = HostRequestSchema.parse({ requestId: 'r', method: 'selector.clear', params: { hostname: 'jobs.example.com', purpose: 'job_description' } })
    expect(req.method).toBe('selector.clear')
  })

  it('refuses a forget request with no hostname', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r', method: 'selector.clear', params: { purpose: 'job_description' } }).success).toBe(false)
  })

  it('the page\'s job text reply may name the ATS as its source', () => {
    for (const source of ['ats', 'learned', 'heuristic', 'none']) {
      expect(JobTextReplySchema.safeParse({ text: '', selector: null, source }).success).toBe(true)
    }
    expect(JobTextReplySchema.safeParse({ text: '', selector: null, source: 'guess' }).success).toBe(false)
  })

  // Ticket #102: the spots the user rejected travel with the request.
  it('a job text request carries the rejected spots', () => {
    const msg = ContentMessageSchema.parse({ type: 'JFF_JOBTEXT', epoch: 1, selector: null, rejected: ['#jd', 'body > main'] })
    expect(msg).toMatchObject({ type: 'JFF_JOBTEXT', rejected: ['#jd', 'body > main'] })
  })

  it('a job text request without rejected spots is read as an empty list', () => {
    const msg = ContentMessageSchema.parse({ type: 'JFF_JOBTEXT', epoch: 1, selector: '#jd' })
    expect(msg).toMatchObject({ type: 'JFF_JOBTEXT', rejected: [] })
  })

  it('refuses rejected spots that are not a list of strings', () => {
    expect(ContentMessageSchema.safeParse({ type: 'JFF_JOBTEXT', epoch: 1, selector: null, rejected: '#jd' }).success).toBe(false)
    expect(ContentMessageSchema.safeParse({ type: 'JFF_JOBTEXT', epoch: 1, selector: null, rejected: [1] }).success).toBe(false)
  })

  it('the Session\'s source is one of six, the user\'s link among them (ticket #104)', () => {
    expect(JobTextSourceSchema.options).toEqual(['paste', 'link', 'ats', 'pick', 'heuristic', 'none'])
  })

  it('a Capture accepts a text read from the user\'s link', () => {
    const base = { page: { html: '<p>x</p>', cut: false }, ats: 'generic', url: 'https://x.example/apply', fields: [], resolutions: [], election: null, frameReports: [] }
    const ok = CaptureSaveParamsSchema.safeParse({ ...base, jobTextSource: 'link' })
    expect(ok.success && ok.data.jobTextSource).toBe('link')
  })

  it('a Capture carries a source and refuses one that is not on the list', () => {
    const base = { page: { html: '<p>x</p>', cut: false }, ats: 'generic', url: 'https://x.example/apply', fields: [], resolutions: [], election: null, frameReports: [] }
    const ok = CaptureSaveParamsSchema.safeParse({ ...base, jobTextSource: 'heuristic' })
    expect(ok.success && ok.data.jobTextSource).toBe('heuristic')
    expect(CaptureSaveParamsSchema.safeParse({ ...base, jobTextSource: 'guess' }).success).toBe(false)
  })
})

describe('the addresses a Scan collects (spec #66)', () => {
  const reply = { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: false }
  const mailto = { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Mail us', subject: 'Application' } }
  const text = { address: 'jobs@example.org', context: { kind: 'text', sentence: 'Write to jobs@example.org.' } }

  it('a Scan reply carries each address with its mailto or text context', () => {
    const scan = ScanResultSchema.parse({ ...reply, addresses: [mailto, text] })
    expect(scan.addresses).toEqual([mailto, text])
  })

  it('a mailto context with no subject says so with null', () => {
    const none = { address: 'a@example.org', context: { kind: 'mailto', linkText: 'a@example.org', subject: null } }
    expect(FoundAddressSchema.parse(none)).toEqual(none)
  })

  it('accepts a reply from a stale page script that omits the addresses', () => {
    expect(ScanResultSchema.parse(reply).addresses).toBeUndefined()
  })

  it('refuses a context of another kind, or a mailto context that carries a body', () => {
    expect(ScanResultSchema.safeParse({ ...reply, addresses: [{ address: 'a@example.org', context: { kind: 'image', alt: 'x' } }] }).success).toBe(false)
    const withBody = FoundAddressSchema.parse({ address: 'a@example.org', context: { kind: 'mailto', linkText: 'x', subject: null, body: 'secret' } })
    expect(JSON.stringify(withBody)).not.toContain('secret')
  })

  it('a candidate is one address with its contexts', () => {
    const c = { address: 'jobs@example.org', contexts: [mailto.context, text.context] }
    expect(ApplyAddressCandidateSchema.parse(c)).toEqual(c)
  })

  it('an Apply address is chosen one of three ways', () => {
    expect(ApplyAddressChoiceSchema.options).toEqual(['pick', 'list', 'typed'])
  })
})

describe('the shape check of an address (spec #66)', () => {
  it('takes an address with one @ and a dotted domain', () => {
    for (const a of ['ada@example.com', 'ada.lovelace+jobs@mail.example.org', 'Ada_L-1@sub.example.org']) expect(isAddressShape(a)).toBe(true)
  })

  it('refuses what is not shaped like one', () => {
    for (const a of ['', 'ada', 'ada@', '@example.com', 'ada@example', 'ada example.com', 'ada@exa mple.com', 'a@b@example.com', 'ada@example.', 'ada@.example.com', ' ada@example.com', 'ada at example dot com'])
      expect(isAddressShape(a), a).toBe(false)
  })
})

describe('applyAddress.pick (#71)', () => {
  const params = {
    candidates: [{ address: 'jobs@example.org', contexts: [{ kind: 'text', sentence: 'Apply at jobs@example.org.' }] }],
    title: 'Analyst at Acme', company: null, jobText: 'Acme is hiring.',
  }

  it('takes the candidates with their contexts, the title, the Company and the job text', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'applyAddress.pick', params }).success).toBe(true)
  })

  it('refuses a request with no candidate', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'applyAddress.pick', params: { ...params, candidates: [] } }).success).toBe(false)
  })

  it('the reply is a position or none, and carries no address', () => {
    expect(ApplyAddressPickResultSchema.parse({ position: 0 })).toEqual({ position: 0 })
    expect(ApplyAddressPickResultSchema.parse({ position: null })).toEqual({ position: null })
    expect(ApplyAddressPickResultSchema.parse({ position: 0, address: 'careers@example.org' })).toEqual({ position: 0 })
    expect(ApplyAddressPickResultSchema.safeParse({ position: 'jobs@example.org' }).success).toBe(false)
    expect(ApplyAddressPickResultSchema.safeParse({ position: -1 }).success).toBe(false)
  })
})

describe('email.draft (#72)', () => {
  const params = { jobText: 'Acme is hiring an analyst.', company: 'Acme', title: 'Analyst at Acme', pageSubject: null }

  it('takes the job text, the Company, the title, the page subject and the Resume text', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'email.draft', params }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'email.draft', params: { ...params, pageSubject: 'Application', cvText: 'cv' } }).success).toBe(true)
  })

  it('refuses a request with no job text', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'email.draft', params: { ...params, jobText: '  ' } }).success).toBe(false)
  })

  it('the reply names its links from the three link Known keys only', () => {
    const reply = { subject: 'S', body: 'B', model: 'claude-opus-5-5', language: 'en', missingLinks: ['github'], unsupportedClaims: [], unchecked: false }
    expect(EmailDraftResultSchema.safeParse(reply).success).toBe(true)
    expect(EmailDraftResultSchema.safeParse({ ...reply, missingLinks: ['email'] }).success).toBe(false)
  })
})

describe('email.draft, language and instruction (#73)', () => {
  const params = { jobText: 'Acme is hiring an analyst.', company: 'Acme', title: 'Analyst at Acme', pageSubject: null }
  const parses = (p: object): boolean => HostRequestSchema.safeParse({ requestId: 'r1', method: 'email.draft', params: p }).success

  it('takes English or Portuguese, and an instruction up to the cap', () => {
    expect(parses({ ...params, language: 'pt', instruction: 'shorter' })).toBe(true)
    expect(parses({ ...params, language: 'es' })).toBe(false)
    expect(parses({ ...params, instruction: 'x'.repeat(EMAIL_INSTRUCTION_MAX) })).toBe(true)
    expect(parses({ ...params, instruction: 'x'.repeat(EMAIL_INSTRUCTION_MAX + 1) })).toBe(false)
  })

  it('the reply names its language', () => {
    const reply = { subject: 'S', body: 'B', model: 'm', missingLinks: [], unsupportedClaims: [], unchecked: false }
    expect(EmailDraftResultSchema.safeParse({ ...reply, language: 'pt' }).success).toBe(true)
    expect(EmailDraftResultSchema.safeParse(reply).success).toBe(false)
  })

  it('a Prose Field\'s Generation takes no instruction', () => {
    const gen = { handle: { frameId: 0, fid: 1, epoch: 1 }, questionRaw: 'Why Acme?', jobText: 'Acme', company: null }
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'generate', params: gen }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'generate', params: { ...gen, instruction: 'shorter' } }).success).toBe(false)
  })
})
