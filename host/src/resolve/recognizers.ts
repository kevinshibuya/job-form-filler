import type Database from 'better-sqlite3'
import type { FieldKey } from '@jff/shared'
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
 */
export const BASELINE_RECOGNIZERS: { match: RegExp; key: FieldKey; onChoice?: FieldKey }[] = [
  { match: /sponsor|visa|patroc[ií]nio/i, key: 'sponsorshipNeeded' },
  { match: /authoriz|legally.*work|right to work|work permit|autoriza[cç][aã]o para trabalhar/i, key: 'workAuth' },
  { match: /relocat|mudan[cç]a de cidade|disposto a mudar/i, key: 'relocate' },
  { match: /salary|compensation|desired pay|expected pay|sal[aá]rio|pretens[aã]o/i, key: 'salary' },
  { match: /notice period|aviso pr[eé]vio/i, key: 'notice' },
  { match: /start date|earliest start|when can you start|available to start|disponibilidade para in[ií]cio/i, key: 'earliestStart' },
  { match: /remote (preference|work preference)|work arrangement|prefer[eê]ncia (de|por) (trabalho )?remoto|modelo de trabalho/i, key: 'remotePreference' },
  { match: /linkedin/i, key: 'linkedin' },
  { match: /github/i, key: 'github' },
  { match: /portfolio|portf[oó]lio|personal website|website pessoal|\bwebsite\b/i, key: 'portfolio' },
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
  { match: /first name|primeiro nome|\bnome\b(?!\s+da\s+empresa)/i, key: 'firstName' },
  { match: /last name|surname|family name|sobrenome/i, key: 'lastName' },
  { match: /e-?mail/i, key: 'email' },
  { match: /\bphone\b|\bmobile\b|telephone|telefone|celular/i, key: 'phone' }, // \b avoids "Microphone"
  { match: /full ?name|legal name|^name$|nome completo/i, key: 'fullName' }, // STRICT LAST; never a bare /name/i
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
  const hit = BASELINE_RECOGNIZERS.find((r) => r.match.test(trimmed))
  if (hit === undefined) return null
  return hit.onChoice !== undefined && kind !== undefined && isChoiceControl(kind) ? hit.onChoice : hit.key
}
