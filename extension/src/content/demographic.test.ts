import { beforeEach, describe, expect, it } from 'vitest'
import { asksAboutAccommodation, type EnumField } from '@jff/shared'
import { isDemographic } from './classify'
import { enumerateFields, type MeasureFn } from './enumerate'
import { loadRealFixture } from './fixtures/real'

// Every test here scans a page the way the content script does on JFF_SCAN
// (index.ts): enumeration with the section test injected, in the top frame.

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })

function scan(): EnumField[] {
  return enumerateFields({
    root: document, epoch: 1, measure: allVisible,
    isDemographic: (el) => isDemographic(el, { isSubframe: false }),
  }).fields
}

/** The one Field a page holding a single labelled Control yields. */
function fieldLabelled(label: string): EnumField {
  document.body.innerHTML = `<form><div><label for="q">${label}</label><input id="q"></div></form>`
  const [field] = scan()
  return field!
}

function elementOf(field: EnumField): Element {
  return document.querySelector(`[data-jff-fid="${field.fid}"]`)!
}

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('a Field is a Demographic Field by its own label, with no heading near it', () => {
  const ENGLISH: Record<string, string[]> = {
    gender: ['Gender', 'What is your gender?'],
    race: ['Race', 'Racial background'],
    ethnicity: ['Ethnicity', 'Ethnic group'],
    'Hispanic or Latino': ['Are you Hispanic?', 'Latino', 'Latina', 'Latinx'],
    veteran: ['Veteran', 'Are you a protected veteran?'],
    disability: ['Disability', 'Are you disabled?'],
    'sexual orientation': ['Sexual orientation', 'What is your sexual orientation?'],
    transgender: ['Transgender', 'Do you identify as transgender?'],
    neurodivergent: ['Neurodivergent', 'Neurodivergence', 'Do you consider yourself neurodiverse?'],
  }

  for (const [attribute, labels] of Object.entries(ENGLISH)) {
    it(`recognises the English wording for ${attribute}`, () => {
      for (const label of labels) expect(fieldLabelled(label).demographic, label).toBe(true)
    })
  }

  const PORTUGUESE: Record<string, [accented: string, plain: string][]> = {
    gender: [['Gênero', 'Genero'], ['Sexo', 'Sexo']],
    race: [['Raça', 'Raca'], ['Cor ou raça', 'Cor ou raca']],
    ethnicity: [['Etnia', 'Etnia'], ['Grupo étnico', 'Grupo etnico']],
    'Hispanic or Latino': [['Você é hispânico?', 'Voce e hispanico?'], ['Latino', 'Latino']],
    veteran: [['Você é veterano?', 'Voce e veterano?']],
    disability: [['Possui alguma deficiência?', 'Possui alguma deficiencia?'], ['Você é PcD?', 'Voce e PcD?']],
    'sexual orientation': [['Orientação sexual', 'Orientacao sexual']],
    transgender: [['Você é transgênero?', 'Voce e transgenero?'], ['Você é uma pessoa trans?', 'Voce e uma pessoa trans?']],
    neurodivergent: [['Você é neurodivergente?', 'Voce e neurodivergente?'], ['Neurodiversidade', 'Neurodiversidade']],
  }

  for (const [attribute, pairs] of Object.entries(PORTUGUESE)) {
    it(`recognises the Portuguese wording for ${attribute}, with and without accents`, () => {
      for (const [accented, plain] of pairs) {
        expect(fieldLabelled(accented).demographic, accented).toBe(true)
        expect(fieldLabelled(plain).demographic, plain).toBe(true)
      }
    })
  }

  it('keeps matching the phrases the label test knew before', () => {
    for (const label of ['Veteran status', 'Disability status', 'Race/Ethnicity', 'Gender identity', 'Autodeclaração'])
      expect(fieldLabelled(label).demographic, label).toBe(true)
  })

  it('does not catch a listed word inside another word', () => {
    for (const label of ['How do you embrace change?', 'Bitrace username', 'Generous benefits?', 'Interest in our latinoamerica office'])
      expect(fieldLabelled(label).demographic, label).toBe(false)
  })

  it('does not catch a question about a race condition', () => {
    expect(fieldLabelled('Describe a race condition you debugged').demographic).toBe(false)
    expect(fieldLabelled('Race conditions you have fixed').demographic).toBe(false)
  })
})

describe('the section test on the hosted Greenhouse self-identification layout', () => {
  beforeEach(() => loadRealFixture('greenhouse-self-id'))

  it('makes every Field under the self-identification heading a Demographic Field', () => {
    const inSection = scan().filter((f) => elementOf(f).closest('#demographic-section') !== null)
    expect(inSection.length).toBeGreaterThanOrEqual(7)
    for (const f of inSection) expect(f.demographic, f.label ?? `fid ${f.fid}`).toBe(true)
  })

  it('does not spread to the name, the email or any other Field outside the section', () => {
    const fields = scan()
    const outside = fields.filter((f) => elementOf(f).closest('#demographic-section') === null && f.kind !== 'checkbox')
    for (const id of ['first_name', 'last_name', 'email']) {
      const f = fields.find((each) => each.idAttr === id)!
      expect(f.demographic, id).toBe(false)
    }
    // Two questions above the section name "disability" in their own label, and
    // the label test catches them on its own. Every other Field outside stays.
    const byLabel = outside.filter((f) => /\bdisability\b/i.test(f.label ?? ''))
    expect(byLabel.map((f) => f.demographic)).toEqual([true, true])
    for (const f of outside.filter((each) => !byLabel.includes(each)))
      expect(f.demographic, f.label ?? `fid ${f.fid}`).toBe(false)
  })
})

describe('a Field under a demographic heading of a fieldset, section or group', () => {
  it('is still caught, whatever its own label says', () => {
    document.body.innerHTML = `<form>
      <fieldset><legend>Voluntary Self-Identification</legend><label for="a">Please choose one</label><select id="a"></select></fieldset>
      <section><h2>Demographic questions</h2><label for="b">Please choose one</label><select id="b"></select></section>
      <div role="group" aria-label="EEO information"><label for="c">Please choose one</label><select id="c"></select></div>
    </form>`
    expect(scan().map((f) => f.demographic)).toEqual([true, true, true])
  })
})

describe('what is not a Demographic Field', () => {
  it('leaves the accommodation question on its page to the user', () => {
    loadRealFixture('greenhouse-accommodation')
    const fields = scan()
    const accommodation = fields.filter((f) => /accommodate/i.test(f.label ?? ''))
    expect(accommodation).toHaveLength(1)
    expect(accommodation[0]!.demographic).toBe(false)
    expect(fields.filter((f) => f.demographic)).toEqual([])
  })

  it('leaves an accommodation question that names disability to the user', () => {
    expect(fieldLabelled('Do you need any accommodation because of a disability?').demographic).toBe(false)
  })

  it('leaves a Portuguese accommodation question that names disability to the user, with and without accents', () => {
    for (const label of [
      'Precisa de alguma adaptação por deficiência?', 'Precisa de alguma adaptacao por deficiencia?',
      'Você precisa de acomodação por ser PcD?', 'Voce precisa de acomodacao por ser PcD?',
    ]) {
      expect(asksAboutAccommodation(label), label).toBe(true)
      expect(fieldLabelled(label).demographic, label).toBe(false)
    }
  })

  it('keeps a pronouns Field answerable outside a self-identification section', () => {
    expect(fieldLabelled('Pronouns').demographic).toBe(false)
    expect(fieldLabelled('What are your gender pronouns?').demographic).toBe(false)
    expect(fieldLabelled('Pronomes').demographic).toBe(false)
  })

  it('keeps a pronouns Field answerable inside a self-identification section', () => {
    document.body.innerHTML = `<form>
      <fieldset><legend>Voluntary Self-Identification</legend><label for="a">Pronouns</label><input id="a"></fieldset>
      <div><h3>Demographic Questionnaire</h3><div><div><label for="b">Your pronouns</label><input id="b"></div></div></div>
    </form>`
    expect(scan().map((f) => f.demographic)).toEqual([false, false])
  })
})
