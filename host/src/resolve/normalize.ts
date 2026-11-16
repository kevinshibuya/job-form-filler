import { normalizeQuestion } from '@jff/shared'

export { normalizeQuestion } from '@jff/shared'

// Matched against normalizeQuestion() output, which is ACCENT-STRIPPED: every hint
// must be written unaccented or it can never match ("vocês" would be dead code).
// The words of the per-language keys' own labels ("Aviso prévio", "Início",
// "Remoto") count too, so a Field asking for one in Portuguese takes the
// Portuguese Value even when its label has no stopword.
const PT_HINTS = /\b(voce|voces|qual|quais|sua|seu|suas|seus|por que|porque|experiencia|salario|pretensao|trabalh\w*|empresa|cargo|nome|sobrenome|telefone|endereco|disponibilidade|contratacao|aviso|inicio|remoto)\b/

/** Deliberately dumb: two languages, stopword hit or fall back to English. */
export function detectLanguage(s: string): 'en' | 'pt' {
  const n = normalizeQuestion(s)
  if (n.length === 0) return 'en'
  return PT_HINTS.test(n) ? 'pt' : 'en'
}
