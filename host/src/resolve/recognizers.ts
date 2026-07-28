import type Database from 'better-sqlite3'
import type { FieldKey } from '@jff/shared'
import { getLearnedMapping } from '../db/repos.js'
import { normalizeQuestion } from './normalize.js'

/**
 * Hand-curated baseline, ported from job-finder's BASELINE_RECOGNIZERS.
 * ORDER MATTERS: specific patterns before generic ones. Every `key` must be a
 * member of the closed FIELD_KEYS set (asserted by the test).
 * There is deliberately no "why interested"/"cover letter" recognizer — those
 * are subjective and must fall through to the LLM and then to [Generate].
 */
export const BASELINE_RECOGNIZERS: { match: RegExp; key: FieldKey }[] = [
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
  { match: /preferred.*(name|first)|nome social/i, key: 'preferredName' }, // BEFORE firstName/fullName
  { match: /pronoun|pronome/i, key: 'pronouns' },
  { match: /first name|primeiro nome|\bnome\b(?!\s+da\s+empresa)/i, key: 'firstName' },
  { match: /last name|surname|family name|sobrenome/i, key: 'lastName' },
  { match: /e-?mail/i, key: 'email' },
  { match: /\bphone\b|\bmobile\b|telephone|telefone|celular/i, key: 'phone' }, // \b avoids "Microphone"
  { match: /current location|\bcity\b|based in|where are you (located|based)|cidade|onde voc[eê] mora/i, key: 'location' },
  { match: /full ?name|legal name|^name$|nome completo/i, key: 'fullName' }, // STRICT LAST; never a bare /name/i
]

/**
 * Tier-1 resolution. A user-confirmed learned mapping always beats the baseline,
 * which is what "promoted to deterministic after the user confirms once" means.
 */
export function recognize(label: string, db?: Database.Database): FieldKey | null {
  const trimmed = label.trim()
  if (trimmed.length === 0) return null
  if (db) {
    const learned = getLearnedMapping(db, normalizeQuestion(trimmed))
    if (learned) return learned
  }
  const hit = BASELINE_RECOGNIZERS.find((r) => r.match.test(trimmed))
  return hit ? hit.key : null
}
