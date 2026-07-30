import { normalizeQuestion } from '@jff/shared'

export { normalizeQuestion } from '@jff/shared'

// Matched against normalizeQuestion() output, which is ACCENT-STRIPPED: every hint
// must be written unaccented or it can never match ("vocês" would be dead code).
const PT_HINTS = /\b(voce|voces|qual|quais|sua|seu|suas|seus|por que|porque|experiencia|salario|pretensao|trabalh\w*|empresa|cargo|nome|sobrenome|telefone|endereco|disponibilidade|contratacao)\b/

/** Deliberately dumb: two languages, stopword hit or fall back to English. */
export function detectLanguage(s: string): 'en' | 'pt' {
  const n = normalizeQuestion(s)
  if (n.length === 0) return 'en'
  return PT_HINTS.test(n) ? 'pt' : 'en'
}
