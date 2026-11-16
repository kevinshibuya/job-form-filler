import type Database from 'better-sqlite3'
import { readPlaces, type FieldKey } from '@jff/shared'
import { getLearnedMapping } from '../db/repos.js'
import { isChoiceControl } from './controlKinds.js'
import { normalizeQuestion } from './normalize.js'

/**
 * Hand-curated baseline, ported from job-finder's BASELINE_RECOGNIZERS.
 * ORDER MATTERS: specific patterns before generic ones. Every `key` must be a
 * member of the closed FIELD_KEYS set (asserted by the test).
 * There is deliberately no "why interested"/"cover letter" recognizer — those
 * are subjective and must fall through to the LLM and then to [Generate].
 * `onChoice` is the key the same label takes when its Control is a choice: a
 * location dropdown picks a city, never the free-text location line.
 * `when` narrows a rule to labels it also holds for.
 */

/**
 * A question about where the user lives ("are you based in", "do you live
 * in", in English and Portuguese). Read BEFORE the location rule: when it
 * names a place it is a yes/no question about the user's country, never a
 * request for the location line (host/src/resolve/countryAnswers.ts).
 */
export const RESIDENCE_QUESTION =
  /\bbased in\b|\b(live|living|reside|residing|located)\s+in\b|\bresident (of|in)\b|\b(mora|moras|reside|vive|baseado|baseada|localizado|localizada)\s+(em|no|na|nos|nas)\b/i

const namesPlace = (label: string): boolean => {
  const { countries, regions } = readPlaces(label)
  return countries.length > 0 || regions.length > 0
}

/**
 * A claim the user holds the right to work ("authorized to work", "work
 * permit"), and a need for one ("sponsorship", "require a work permit"). An
 * `authoriz` with no work beside it is a consent ("I authorize Acme to…").
 */
const HOLDS = /authori[sz]\w*\s+(to\s+work|for\s+employment|to\s+be\s+employed)|(work|employment)\s+authori[sz]ation|legally.*work|right to work|eligible to work|work permit|autoriza[cç][aã]o para trabalhar/i
const NEEDS = /sponsor|\bvisa\b|patroc[ií]nio|\b(requir|need)\w*\b[^.?!]*?\bwork\s+(permit|authori[sz]ation)/i

/**
 * Which of the two a work question asks: the phrase that comes first decides
 * ("authorized to work … without sponsorship" asks for authorization, "require
 * sponsorship to be authorized" asks for sponsorship). Two questions in one
 * label cannot take one yes or no, so neither key: Mapping proposes.
 */
function workQuestion(label: string): 'workAuth' | 'sponsorshipNeeded' | null {
  const h = label.search(HOLDS)
  const n = label.search(NEEDS)
  if (h === -1 && n === -1) return null
  if (h === -1) return 'sponsorshipNeeded'
  if (n === -1) return 'workAuth'
  if (label.slice(Math.min(h, n), Math.max(h, n)).includes('?')) return null
  return h < n ? 'workAuth' : 'sponsorshipNeeded'
}

/** A consent or signature asks for the user's act, never a stored name to type. */
const notSignature = (label: string): boolean =>
  !/\b(consent|signature|sign(ed|ing)?|certify|attest|acknowledge|authori[sz]e|agree)\b/i.test(label)

/** A label that asks for a link is a short noun phrase, never a prose question. */
const shortLabel = (label: string): boolean => label.trim().split(/\s+/).length <= 8

/** A need to relocate ("will you need to relocate to…") is not a willingness to. */
const notNeedToRelocate = (label: string): boolean => !/\b(need|have|require[sd]?)\b[^.?!]*\bto relocate/i.test(label)

/** A link inside a label is the employer's, never the question. */
const withoutLinks = (label: string): string => label.replace(/\b(https?:\/\/|www\.)\S+/gi, ' ')

export const BASELINE_RECOGNIZERS: { match: RegExp; key: FieldKey; onChoice?: FieldKey; when?: (label: string) => boolean }[] = [
  { match: HOLDS, key: 'workAuth', when: (label) => workQuestion(label) === 'workAuth' },
  { match: NEEDS, key: 'sponsorshipNeeded', when: (label) => workQuestion(label) === 'sponsorshipNeeded' },
  { match: RESIDENCE_QUESTION, key: 'country', when: namesPlace },
  { match: /relocat|mudan[cç]a de cidade|disposto a mudar/i, key: 'relocate', when: notNeedToRelocate },
  { match: /salary|compensation|desired pay|expected pay|sal[aá]rio|pretens[aã]o/i, key: 'salary' },
  { match: /notice period|aviso pr[eé]vio/i, key: 'notice' },
  { match: /start date|earliest start|when can you start|available to start|disponibilidade para in[ií]cio/i, key: 'earliestStart' },
  { match: /remote (preference|work preference)|work arrangement|prefer[eê]ncia (de|por) (trabalho )?remoto|modelo de trabalho/i, key: 'remotePreference' },
  { match: /linkedin/i, key: 'linkedin', when: shortLabel },
  { match: /github/i, key: 'github', when: shortLabel },
  { match: /portfolio|portf[oó]lio|personal website|website pessoal|\bwebsite\b/i, key: 'portfolio', when: shortLabel },
  // The current company and title, BEFORE the name rules: "Nome do cargo atual" is a title.
  { match: /\b(current|present|most recent)\s+(job\s+)?(title|role|position)\b|\bcargo atual\b|\bfun[cç][aã]o atual\b/i, key: 'currentTitle' },
  { match: /\b(current|present|most recent)\s+(company|employer)\b|\bcurrent(ly)? employ(er|ed at)\b|\bempresa atual\b|\bempregador atual\b/i, key: 'currentCompany' },
  // Places, most specific first and BEFORE the name rules ("Nome da cidade").
  // A phone's country code is not a country, and "estado civil" is not a region.
  { match: /\bcountry\b(?!\s*code)|(?<!c[oó]digo d[eo] )\bpa[ií]s\b/i, key: 'country' },
  { match: /\bcity\b|\bcidade\b/i, key: 'city' },
  {
    match: /^(state|province|region|county)(\s*[*:/(,]|\s*$|\s+(or|of)\b)|\b(state|province|region) of residence\b|\bprovince\b|^estado\b(?!\s+civil)|\bestado\s*(\/|ou)\s*(prov|regi)|\bestado de resid[eê]ncia\b|\bprov[ií]ncia\b|^regi[aã]o\b/i,
    key: 'region',
  },
  {
    match: /^location\b|current location|based in|where are you (located|based)|^localiza[cç][aã]o\b|onde voc[eê] mora/i,
    key: 'location', onChoice: 'city',
  },
  { match: /preferred.*(name|first)|nome social/i, key: 'preferredName' }, // BEFORE firstName/fullName
  { match: /pronoun|pronome/i, key: 'pronouns' },
  { match: /first name|primeiro nome|\bnome\b(?!\s+da\s+empresa)/i, key: 'firstName', when: notSignature },
  { match: /last name|surname|family name|sobrenome/i, key: 'lastName', when: notSignature },
  { match: /e-?mail/i, key: 'email' },
  { match: /\bphone\b|\bmobile\b|telephone|telefone|celular/i, key: 'phone' }, // \b avoids "Microphone"
  { match: /full ?name|legal name|^name$|nome completo/i, key: 'fullName', when: notSignature }, // STRICT LAST; never a bare /name/i
]

/**
 * Tier-1 resolution. A user-confirmed learned mapping always beats the baseline,
 * which is what "promoted to deterministic after the user confirms once" means.
 * `kind` is the Field's Control: a baseline rule with `onChoice` answers a
 * choice Control with that key. A learned mapping is the user's own and is
 * returned as confirmed.
 */
export function recognize(label: string, db?: Database.Database, kind?: string): FieldKey | null {
  const trimmed = label.trim()
  if (trimmed.length === 0) return null
  if (db) {
    const learned = getLearnedMapping(db, normalizeQuestion(trimmed))
    if (learned) return learned
  }
  // The learned lookup keeps the label as written; the baseline reads it without links.
  const bare = withoutLinks(trimmed)
  const hit = BASELINE_RECOGNIZERS.find((r) => r.match.test(bare) && (r.when?.(bare) ?? true))
  if (hit === undefined) return null
  return hit.onChoice !== undefined && kind !== undefined && isChoiceControl(kind) ? hit.onChoice : hit.key
}
