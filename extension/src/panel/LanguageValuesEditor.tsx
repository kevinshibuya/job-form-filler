import { languageName, type RuleLanguage } from '@jff/shared'
import { INPUT } from './ui'

const LANGUAGES: readonly RuleLanguage[] = ['en', 'pt']

/** The texts of a draft per-language Value as typed; any text that is not a JSON object has none. */
function textsOf(value: string): Record<RuleLanguage, string> {
  const out: Record<RuleLanguage, string> = { en: '', pt: '' }
  if (!value.startsWith('{')) return out
  try {
    const o: unknown = JSON.parse(value)
    if (typeof o !== 'object' || o === null) return out
    for (const lang of LANGUAGES) {
      const v = (o as Record<string, unknown>)[lang]
      if (typeof v === 'string') out[lang] = v
    }
  } catch { /* no texts */ }
  return out
}

/**
 * A key stored once per language: one box for English and one for
 * Portuguese. `value` is the draft text; a change hands back both texts as
 * typed, as JSON, and empty once both are. A write keeps the languages given
 * and leaves out an empty one, so either language alone is a Value.
 */
export function LanguageValuesEditor({ id, label, value, onChange }: {
  id: string
  /** The key's name, which each box's own label carries: "Notice period in English". */
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const texts = textsOf(value)
  const change = (lang: RuleLanguage, text: string): void => {
    const next = { ...texts, [lang]: text }
    onChange(LANGUAGES.every((l) => next[l].trim() === '') ? '' : JSON.stringify(next))
  }
  return (
    <div className="grid grid-cols-2 gap-1" data-jff-languages="1">
      {LANGUAGES.map((lang) => (
        <input
          key={lang} id={lang === 'en' ? id : undefined} className={INPUT}
          aria-label={`${label} in ${languageName(lang)}`} placeholder={languageName(lang)}
          value={texts[lang]} onChange={(e) => change(lang, e.target.value)}
        />
      ))}
    </div>
  )
}
