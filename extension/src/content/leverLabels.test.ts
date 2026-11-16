import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atsModule, GENERIC_MODULE, type AtsModule, type EnumField } from '@jff/shared'
import { enumerateFields, type MeasureFn } from './enumerate'
import { groupLabelFor, labelFor } from './dom'
import { isDemographic } from './classify'
import { loadRealFixture, REAL_FIXTURES } from './fixtures/real'
import { dropJunk } from '../panel/junk'
import { pickResumeTarget } from '../panel/resumeTarget'

// Lever's labels (spec #41, ticket #44). The Lever module says where a
// question's text sits: in the label block of the question that holds the
// Control. These tests run Enumeration over the three real Lever pages with the
// module passed in, and with the generic module, which must give the generic
// labels: today's, cleaned only by the generic label rules of #46.

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })

const LEVER = atsModule('lever')
const LEVER_FIXTURES = ['lever-pronoun-group', 'lever-source-group', 'lever-marketing-consent'] as const
type LeverFixture = typeof LEVER_FIXTURES[number]

function scan(name: string, mod: AtsModule): EnumField[] {
  loadRealFixture(name)
  return enumerateFields({ root: document, epoch: 1, measure: allVisible, isDemographic: (el) => isDemographic(el), atsModule: mod }).fields
}

function byName(fields: EnumField[], name: string): EnumField {
  const field = fields.find((f) => f.name === name)
  if (field === undefined) throw new Error(`no Field named ${name}`)
  return field
}

const isCustom = (f: EnumField): boolean => f.name !== null && /^(cards|surveysResponses)\[/.test(f.name)

/** The labels each Lever fixture gave before this ticket, Field by Field, but for
 *  the dropdowns, whose Options #46 leaves out of their wrapping label. */
const GENERIC_LABELS: Record<LeverFixture, readonly (string | null)[]> = {
  'lever-pronoun-group': [
    "Resume/CV ✱ATTACH RESUME/CVCouldn't auto-read resume.Analyzing resume...Success!",
    "Full name✱",
    "Pronouns",
    "Write here...",
    "Email✱",
    "Phone ✱",
    "Current location ✱No location found. Try entering a different locationLoading",
    "Current company ✱",
    "LinkedIn URL",
    "GitHub URL",
    "Portfolio URL",
    "Other website",
    "Have you ever been previously employed by Acme?",
    "What is your location?",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "Acme has my consent to contact me about future job opportunities.",
  ],
  'lever-source-group': [
    "Resume/CV ✱ATTACH RESUME/CVCouldn't auto-read resume.Analyzing resume...Success!",
    "Full name✱",
    "Pronouns",
    "Write here...",
    "Email✱",
    "Phone ✱",
    "Current location No location found. Try entering a different locationLoading",
    "Current company",
    "LinkedIn URL",
    "Other website",
    null,
    null,
    null,
    "How did you hear about us?",
    "Type your response",
    "Gender",
    "Race",
    "Veteran status",
  ],
  'lever-marketing-consent': [
    "Resume/CV ✱ATTACH RESUME/CVCouldn't auto-read resume.Analyzing resume...Success!",
    "Full name✱",
    "Pronouns",
    "Write here...",
    "Email✱",
    "Phone ✱",
    "Current location ✱No location found. Try entering a different locationLoading",
    "Current company ✱",
    "LinkedIn URL✱",
    null,
    null,
    "Type your response",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "Type your response",
    null,
    "Type your response",
    "Type your response",
    "Type your response",
    "Current Company/ Empresa atual",
    null,
    "Type your response",
    "Type your response",
    "Concordo que meus dados pessoais sejam armazenados e processados pela Acme ou terceiros, exclusivamente para fins de recrutamento e seleção.",
    "Autorizo a Acme a enviar informações através de mídias sociais, telefone e email sobre novas oportunidades de emprego",
  ],
}

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('Enumeration over the Lever fixtures', () => {
  it.each([
    ['lever-pronoun-group', 22],
    ['lever-source-group', 18],
    ['lever-marketing-consent', 33],
  ] as const)('%s yields %i Fields, with the Lever module and with the generic one', (name, count) => {
    expect(scan(name, LEVER)).toHaveLength(count)
    expect(scan(name, GENERIC_MODULE)).toHaveLength(count)
  })

  it.each(LEVER_FIXTURES)('%s gives exactly the generic labels with the generic module', (name) => {
    expect(scan(name, GENERIC_MODULE).map((f) => f.label)).toEqual(GENERIC_LABELS[name])
  })
})

describe('with the Lever module, every Lever question carries its own label', () => {
  it.each(LEVER_FIXTURES)('%s: every custom question has a label, and none is "Type your response" or carries the required mark', (name) => {
    const custom = scan(name, LEVER).filter(isCustom)
    expect(custom.length).toBeGreaterThan(0)
    for (const field of custom) {
      expect(field.label, field.name ?? '').not.toBeNull()
      expect(field.label).not.toBe('Type your response')
      expect(field.label).not.toContain('✱')
    }
  })

  it('lever-source-group: each custom question is labelled with its question\'s text', () => {
    const fields = scan('lever-source-group', LEVER)
    const card = (n: number) => byName(fields, `cards[c62ec44a-0482-4f8f-9630-94a6aac1e3c3][field${n}]`).label
    expect(card(0)).toBe('What is your preferred first name and last name? If your legal first and last name is your preferred name, you do not need to respond.')
    expect(card(1)).toMatch(/^Export Control and Compliance: For the sole purpose of determining export licensing requirements/)
    expect(card(2)).toBe('Sponsorship: Do you require sponsorship, or will you require sponsorship in the future for employment authorization in the United States?')
    expect(card(3)).toBe('How did you hear about us?')
    expect(card(4)).toBe('If you attended an on-campus or virtual event, which did you attend?')
  })

  it('lever-pronoun-group: each survey question is labelled with its question\'s text', () => {
    const fields = scan('lever-pronoun-group', LEVER)
    const survey = (id: string, n: number) => byName(fields, `surveysResponses[${id}][responses][field${n}]`).label
    expect(survey('cbf1b3c9-4157-4ddd-a66e-41dae0d8badb', 0)).toBe('What best describes your gender?')
    expect(survey('cbf1b3c9-4157-4ddd-a66e-41dae0d8badb', 1)).toBe('What is your race/ethnicity?:')
    expect(survey('cbf1b3c9-4157-4ddd-a66e-41dae0d8badb', 2)).toBe('Are you a veteran/have you served in the military?')
    expect(byName(fields, 'cards[92a51f92-d683-4f7b-be57-e25376f60abe][field0]').label).toBe('Have you ever been previously employed by Acme?')
  })

  it('lever-marketing-consent: each custom question is labelled with its question\'s text', () => {
    const fields = scan('lever-marketing-consent', LEVER)
    const card = (id: string, n: number) => byName(fields, `cards[${id}][field${n}]`).label
    const first = '901d99b3-8bc5-45de-838b-d6bcf0300654'
    expect(card(first, 0)).toBe('Como ficou sabendo da nossa vaga?')
    expect(card(first, 2)).toBe('Caso a resposta anterior seja Sim, por favor, compartilhe o nome/nomes destas pessoas')
    expect(card(first, 6)).toBe('Gostaria de nos dizer sua identidade de gênero?')
    expect(card(first, 8)).toBe('Como você autodeclara sua cor/raça?')
    expect(card(first, 9)).toBe('Você é pessoa com deficiência?')
    expect(card(first, 11)).toMatch(/^IMPORTANTE! Se você respondeu que é uma pessoa com deficiência, esta etapa é mandatória\. Anexe aqui o laudo médico/)
    expect(card('37c6c83a-bf3c-4a76-99dc-b673ef2994a7', 0)).toBe('Confirm the name of the company where you work/ Confirme o nome da empresa em que você trabalha atualmente')
    expect(card('cafb8a7e-d50c-49b1-b591-fd498dd4f3eb', 0)).toBe('Qual sua pretensão salarial para vagas CLT?')
  })

  it.each(LEVER_FIXTURES)('%s: the Resume file picker is labelled "Resume/CV"', (name) => {
    expect(byName(scan(name, LEVER), 'resume').label).toBe('Resume/CV')
  })

  it.each(LEVER_FIXTURES)('%s: the Resume still goes to the Resume upload', (name) => {
    expect(pickResumeTarget(dropJunk(scan(name, LEVER)), [])?.name).toBe('resume')
  })

  it.each(LEVER_FIXTURES)('%s: name, email, phone, location and company carry their plain question', (name) => {
    const fields = scan(name, LEVER)
    expect(byName(fields, 'name').label).toBe('Full name')
    expect(byName(fields, 'email').label).toBe('Email')
    expect(byName(fields, 'phone').label).toBe('Phone')
    expect(byName(fields, 'location').label).toBe('Current location')
    expect(byName(fields, 'org').label).toBe('Current company')
  })

  it.each(LEVER_FIXTURES)('%s: a dropdown\'s label holds its question and none of its Options', (name) => {
    const selects = scan(name, LEVER).filter((f) => f.kind === 'select')
    expect(selects.length).toBeGreaterThan(0)
    for (const field of selects) {
      expect(field.label).not.toBeNull()
      for (const option of field.options) expect(field.label, field.name ?? '').not.toContain(option)
    }
  })

  it('lever-source-group: the EEO dropdowns are labelled with their question alone', () => {
    const fields = scan('lever-source-group', LEVER)
    expect(byName(fields, 'eeo[gender]').label).toBe('Gender')
    expect(byName(fields, 'eeo[race]').label).toBe('Race')
    expect(byName(fields, 'eeo[veteran]').label).toBe('Veteran status')
  })

  it.each(['lever-pronoun-group', 'lever-source-group'] as const)('%s: the checkbox groups keep their question and their Options', (name) => {
    const groups = (mod: AtsModule) => scan(name, mod).filter((f) => f.kind === 'checkboxgroup').map((f) => [f.label, f.options])
    expect(groups(LEVER)).toEqual(groups(GENERIC_MODULE))
    expect(groups(LEVER).map(([label]) => label)).toContain('Pronouns')
  })

  it('lever-marketing-consent: the lone checkboxes keep their own text', () => {
    const boxes = (mod: AtsModule) => scan('lever-marketing-consent', mod).filter((f) => f.kind === 'checkbox').map((f) => f.label)
    expect(boxes(LEVER)).toEqual(boxes(GENERIC_MODULE))
    expect(boxes(LEVER)).toContain('Autorizo a Acme a enviar informações através de mídias sociais, telefone e email sobre novas oportunidades de emprego')
  })

  it.each(LEVER_FIXTURES)('%s: the hidden free-text pronoun box keeps the label it has today', (name) => {
    const boxes = scan(name, LEVER).filter((f) => f.kind === 'text' && f.name === 'pronouns')
    expect(boxes.map((f) => f.label)).toEqual(['Write here...'])
  })

  it('lever-marketing-consent: the questions about gender identity, colour or race, and disability are Demographic Fields', () => {
    const fields = scan('lever-marketing-consent', LEVER)
    const card = (n: number) => byName(fields, `cards[901d99b3-8bc5-45de-838b-d6bcf0300654][field${n}]`)
    expect(card(6).demographic).toBe(true)
    expect(card(8).demographic).toBe(true)
    expect(card(9).demographic).toBe(true)
    expect(card(10).demographic).toBe(true)
  })

  it.each(LEVER_FIXTURES)('%s: every Field that was Demographic with the generic module still is', (name) => {
    const before = scan(name, GENERIC_MODULE)
    const after = scan(name, LEVER)
    before.forEach((field, i) => {
      if (field.demographic) expect(after[i]!.demographic, field.name ?? String(i)).toBe(true)
    })
  })

  it('records on the binding that the label came from the module, for a Control and for a radio group', () => {
    loadRealFixture('lever-pronoun-group')
    const resume = document.querySelector('input[name="resume"]')!
    expect(labelFor(resume, LEVER)).toMatchObject({ text: 'Resume/CV', source: 'module' })
    expect(labelFor(resume).source).toBe('wrapping')
    const radio = document.querySelector('input[type="radio"]')!
    expect(groupLabelFor(radio, LEVER)).toMatchObject({ text: 'What best describes your gender?', source: 'module' })
  })
})

describe('the non-Lever fixtures', () => {
  const OWN_MODULE: Record<string, string> = { 'based-in-yes-no': 'ashby', 'recruitee-file-inputs': 'recruitee' }
  // The listing page (#53) belongs to no ATS.
  const others = REAL_FIXTURES.filter((name) => !name.startsWith('lever-') && !name.startsWith('listing-'))

  it('are the six Greenhouse pages, the Ashby page and the Recruitee page', () => {
    expect(others).toHaveLength(8)
  })

  it.each(others)('%s keeps every label with its own module', (name) => {
    const mod = atsModule(OWN_MODULE[name] ?? 'greenhouse')
    expect(scan(name, mod).map((f) => f.label)).toEqual(scan(name, GENERIC_MODULE).map((f) => f.label))
  })
})

// The page script picks its frame's ATS from its own hostname and hands that
// ATS's module to Enumeration.
declare const jsdom: { reconfigure(options: { url: string }): void }

describe('the page script', () => {
  type Listener = (raw: unknown, sender: unknown, reply: (response: unknown) => void) => boolean
  let listener: Listener | null = null

  beforeEach(async () => {
    vi.resetModules()
    delete (window as { __jffLoaded?: boolean }).__jffLoaded
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: { addListener: (fn: Listener) => { listener = fn } },
        sendMessage: () => Promise.resolve(),
      },
    })
    await import('./index')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    jsdom.reconfigure({ url: 'http://localhost:3000/' })
  })

  async function scanFrameAt(url: string): Promise<EnumField[]> {
    jsdom.reconfigure({ url })
    loadRealFixture('lever-source-group')
    const reply = await new Promise<unknown>((resolve) => { listener!({ type: 'JFF_SCAN', epoch: 7 }, {}, resolve) })
    const scanned = reply as { ok: boolean; scan?: { fields: EnumField[] } }
    expect(scanned.ok).toBe(true)
    return scanned.scan!.fields
  }

  it('enumerates a frame on a Lever hostname with the Lever module', async () => {
    const fields = await scanFrameAt('https://jobs.lever.co/acme/0000/apply')
    expect(byName(fields, 'cards[c62ec44a-0482-4f8f-9630-94a6aac1e3c3][field4]').label).toBe('If you attended an on-campus or virtual event, which did you attend?')
    expect(byName(fields, 'resume').label).toBe('Resume/CV')
  })

  it('enumerates a frame on an unknown hostname with the generic module', async () => {
    const fields = await scanFrameAt('https://jobs.example.com/apply')
    expect(fields.map((f) => f.label)).toEqual(GENERIC_LABELS['lever-source-group'])
  })
})
