const MAX_NORMALIZED = 300

/**
 * Canonical form used as the qa_memory lookup key and the learned_mappings key.
 * Accent-stripped so PT labels match whether or not the page uses combining marks.
 */
export function normalizeQuestion(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accent marks
    // A hyphen BETWEEN two alphanumerics joins rather than separates, so the two
    // label spellings "E-mail" and "email" collide on one key. Guarded on both
    // sides: a hyphen used as a separator ("Salary - expected") keeps its
    // surrounding spaces and still collapses below, as do en/em dashes.
    .replace(/([a-z0-9])-(?=[a-z0-9])/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, MAX_NORMALIZED)
    .trim()
}

// Matched against normalizeQuestion() output, which is ACCENT-STRIPPED: every hint
// must be written unaccented or it can never match ("vocês" would be dead code).
const PT_HINTS = /\b(voce|voces|qual|quais|sua|seu|suas|seus|por que|porque|experiencia|salario|pretensao|trabalh\w*|empresa|cargo|nome|sobrenome|telefone|endereco|disponibilidade|contratacao)\b/

/** Deliberately dumb: two languages, stopword hit or fall back to English. */
export function detectLanguage(s: string): 'en' | 'pt' {
  const n = normalizeQuestion(s)
  if (n.length === 0) return 'en'
  return PT_HINTS.test(n) ? 'pt' : 'en'
}
