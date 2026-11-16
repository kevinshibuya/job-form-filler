import type { FieldKey, ValueType } from './keys.js'
import { norm } from './norm.js'

/**
 * The rule table: the words a page may use for a Value, one table per
 * language. Fill compares an Option with these words through `norm`, which
 * ignores case and spacing but NOT accents, so a word with an accent is listed
 * with and without it. Adding a word is one line here and one test in
 * ruleTable.test.ts. The countries are a closed list, keyed by ISO 3166 code,
 * and both languages list the same codes.
 */
export const RULE_LANGUAGES = ['en', 'pt'] as const
export type RuleLanguage = (typeof RULE_LANGUAGES)[number]

export interface LanguageRules {
  readonly yes: readonly string[]
  readonly no: readonly string[]
  readonly countries: Readonly<Record<string, readonly string[]>>
}

const EN: LanguageRules = {
  yes: ['Yes'],
  no: ['No'],
  countries: {
    ae: ['United Arab Emirates', 'UAE'],
    ao: ['Angola'],
    ar: ['Argentina'],
    at: ['Austria'],
    au: ['Australia'],
    bd: ['Bangladesh'],
    be: ['Belgium'],
    bg: ['Bulgaria'],
    bo: ['Bolivia'],
    br: ['Brazil'],
    ca: ['Canada'],
    ch: ['Switzerland'],
    cl: ['Chile'],
    cn: ['China'],
    co: ['Colombia'],
    cr: ['Costa Rica'],
    cv: ['Cape Verde', 'Cabo Verde'],
    cy: ['Cyprus'],
    cz: ['Czechia', 'Czech Republic'],
    de: ['Germany'],
    dk: ['Denmark'],
    do: ['Dominican Republic'],
    ec: ['Ecuador'],
    ee: ['Estonia'],
    eg: ['Egypt'],
    es: ['Spain'],
    fi: ['Finland'],
    fr: ['France'],
    gb: ['United Kingdom', 'UK', 'Great Britain'],
    gr: ['Greece'],
    gt: ['Guatemala'],
    hk: ['Hong Kong', 'Hong Kong SAR China'],
    hr: ['Croatia'],
    hu: ['Hungary'],
    id: ['Indonesia'],
    ie: ['Ireland'],
    il: ['Israel'],
    in: ['India'],
    is: ['Iceland'],
    it: ['Italy'],
    jp: ['Japan'],
    ke: ['Kenya'],
    kr: ['South Korea', 'Republic of Korea'],
    lt: ['Lithuania'],
    lu: ['Luxembourg'],
    lv: ['Latvia'],
    ma: ['Morocco'],
    mt: ['Malta'],
    mx: ['Mexico'],
    my: ['Malaysia'],
    mz: ['Mozambique'],
    ng: ['Nigeria'],
    nl: ['Netherlands', 'The Netherlands', 'Holland'],
    no: ['Norway'],
    nz: ['New Zealand'],
    pa: ['Panama'],
    pe: ['Peru'],
    ph: ['Philippines'],
    pk: ['Pakistan'],
    pl: ['Poland'],
    pt: ['Portugal'],
    py: ['Paraguay'],
    qa: ['Qatar'],
    ro: ['Romania'],
    rs: ['Serbia'],
    ru: ['Russia', 'Russian Federation'],
    sa: ['Saudi Arabia'],
    se: ['Sweden'],
    sg: ['Singapore'],
    si: ['Slovenia'],
    sk: ['Slovakia'],
    th: ['Thailand'],
    tr: ['Turkey', 'Türkiye', 'Turkiye'],
    tw: ['Taiwan'],
    ua: ['Ukraine'],
    us: ['United States', 'United States of America', 'US', 'USA', 'U.S.', 'U.S.A.'],
    uy: ['Uruguay'],
    ve: ['Venezuela'],
    vn: ['Vietnam', 'Viet Nam'],
    za: ['South Africa'],
  },
}

const PT: LanguageRules = {
  yes: ['Sim'],
  no: ['Não', 'Nao'],
  countries: {
    ae: ['Emirados Árabes Unidos', 'Emirados Arabes Unidos'],
    ao: ['Angola'],
    ar: ['Argentina'],
    at: ['Áustria', 'Austria'],
    au: ['Austrália', 'Australia'],
    bd: ['Bangladesh'],
    be: ['Bélgica', 'Belgica'],
    bg: ['Bulgária', 'Bulgaria'],
    bo: ['Bolívia', 'Bolivia'],
    br: ['Brasil'],
    ca: ['Canadá', 'Canada'],
    ch: ['Suíça', 'Suica'],
    cl: ['Chile'],
    cn: ['China'],
    co: ['Colômbia', 'Colombia'],
    cr: ['Costa Rica'],
    cv: ['Cabo Verde'],
    cy: ['Chipre'],
    cz: ['Tchéquia', 'Tchequia', 'República Tcheca', 'Republica Tcheca'],
    de: ['Alemanha'],
    dk: ['Dinamarca'],
    do: ['República Dominicana', 'Republica Dominicana'],
    ec: ['Equador'],
    ee: ['Estônia', 'Estonia'],
    eg: ['Egito'],
    es: ['Espanha'],
    fi: ['Finlândia', 'Finlandia'],
    fr: ['França', 'Franca'],
    gb: ['Reino Unido', 'Grã-Bretanha', 'Gra-Bretanha'],
    gr: ['Grécia', 'Grecia'],
    gt: ['Guatemala'],
    hk: ['Hong Kong'],
    hr: ['Croácia', 'Croacia'],
    hu: ['Hungria'],
    id: ['Indonésia', 'Indonesia'],
    ie: ['Irlanda'],
    il: ['Israel'],
    in: ['Índia', 'India'],
    is: ['Islândia', 'Islandia'],
    it: ['Itália', 'Italia'],
    jp: ['Japão', 'Japao'],
    ke: ['Quênia', 'Quenia'],
    kr: ['Coreia do Sul', 'Coréia do Sul'],
    lt: ['Lituânia', 'Lituania'],
    lu: ['Luxemburgo'],
    lv: ['Letônia', 'Letonia'],
    ma: ['Marrocos'],
    mt: ['Malta'],
    mx: ['México', 'Mexico'],
    my: ['Malásia', 'Malasia'],
    mz: ['Moçambique', 'Mocambique'],
    ng: ['Nigéria', 'Nigeria'],
    nl: ['Países Baixos', 'Paises Baixos', 'Holanda'],
    no: ['Noruega'],
    nz: ['Nova Zelândia', 'Nova Zelandia'],
    pa: ['Panamá', 'Panama'],
    pe: ['Peru'],
    ph: ['Filipinas'],
    pk: ['Paquistão', 'Paquistao'],
    pl: ['Polônia', 'Polonia', 'Polónia'],
    pt: ['Portugal'],
    py: ['Paraguai'],
    qa: ['Catar'],
    ro: ['Romênia', 'Romenia', 'Roménia'],
    rs: ['Sérvia', 'Servia'],
    ru: ['Rússia', 'Russia'],
    sa: ['Arábia Saudita', 'Arabia Saudita'],
    se: ['Suécia', 'Suecia'],
    sg: ['Singapura'],
    si: ['Eslovênia', 'Eslovenia'],
    sk: ['Eslováquia', 'Eslovaquia'],
    th: ['Tailândia', 'Tailandia'],
    tr: ['Turquia'],
    tw: ['Taiwan'],
    ua: ['Ucrânia', 'Ucrania'],
    us: ['Estados Unidos', 'Estados Unidos da América', 'Estados Unidos da America', 'EUA'],
    uy: ['Uruguai'],
    ve: ['Venezuela'],
    vn: ['Vietnã', 'Vietna', 'Vietname'],
    za: ['África do Sul', 'Africa do Sul'],
  },
}

export const RULE_TABLE: Readonly<Record<RuleLanguage, LanguageRules>> = { en: EN, pt: PT }

/** Words in table order (English first), each once under `norm`. */
function unique(words: readonly string[]): string[] {
  const seen = new Set<string>()
  return words.filter((w) => {
    const k = norm(w)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const has = (words: readonly string[], value: string): boolean => words.some((w) => norm(w) === norm(value))

/**
 * The words a yes or a no may appear as, in both languages. The Value is read
 * as yes or no only when it is itself one of the table's words; anything else
 * (a bare "true", a sentence) gets none.
 */
export function yesNoCandidates(value: string): string[] {
  for (const answer of ['yes', 'no'] as const) {
    const words = RULE_LANGUAGES.flatMap((l) => RULE_TABLE[l][answer])
    if (has(words, value)) return unique(words)
  }
  return []
}

/**
 * Every name and short form of the country the Value names, in both
 * languages. The Value is found by any of those words; a place that is not in
 * the closed list gets none.
 */
export function countryCandidates(value: string): string[] {
  for (const code of Object.keys(RULE_TABLE.en.countries)) {
    const words = RULE_LANGUAGES.flatMap((l) => RULE_TABLE[l].countries[code] ?? [])
    if (has(words, value)) return unique(words)
  }
  return []
}

/** The candidate words of a Value by its Value type. A place is read as a country. */
export function candidatesFor(type: ValueType, value: string): string[] {
  if (type === 'yes_no') return yesNoCandidates(value)
  if (type === 'place') return countryCandidates(value)
  return []
}

/**
 * The Known keys whose Value carries candidate words, with the rule that
 * renders it. A key outside this map gets none, whatever its Value type: the
 * old free text of `workAuth`, `sponsorshipNeeded` and `relocate` is not a
 * yes/no Value yet.
 */
const CANDIDATES_BY_KEY: Partial<Record<FieldKey, (value: string) => string[]>> = {
  country: countryCandidates,
}

/** The candidate words a Resolution of `key` carries for its Value. */
export function candidatesForKey(key: FieldKey, value: string): string[] {
  return CANDIDATES_BY_KEY[key]?.(value) ?? []
}
