import { COUNTRY_CODES, countryName, workAuthCountries, workAuthValue } from '@jff/shared'
import { BTN, INPUT } from './ui'

/** The closed country list by English name, for the picker. */
const BY_NAME: readonly { code: string; name: string }[] = COUNTRY_CODES
  .map((code) => ({ code, name: countryName(code) ?? code }))
  .sort((a, b) => a.name.localeCompare(b.name))

/**
 * Work authorization: the countries where the user may work, chosen from the
 * closed list. `value` is the draft text, the list's canonical form or empty;
 * a change hands back the new canonical text, empty once no country is left.
 * Built from the panel's own primitives: a select to add and a button per
 * country to remove it.
 */
export function WorkAuthEditor({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const codes = workAuthCountries(value) ?? []
  const change = (next: string[]): void => onChange(next.length === 0 ? '' : workAuthValue(next))
  return (
    <div className="grid gap-1">
      {codes.length > 0 && (
        <ul className="flex flex-wrap gap-1" data-jff-workauth="1">
          {codes.map((code) => {
            const name = countryName(code) ?? code
            return (
              <li key={code} className="flex items-center gap-1" data-jff-workauth-country={code}>
                <span>{name}</span>
                <button
                  type="button" className={BTN} aria-label={`Remove ${name}`}
                  onClick={() => change(codes.filter((c) => c !== code))}
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <select
        id={id} className={INPUT} value=""
        onChange={(e) => { if (e.target.value !== '') change([...codes, e.target.value]) }}
      >
        <option value="">Add a country where you may work</option>
        {BY_NAME.filter((c) => !codes.includes(c.code)).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
    </div>
  )
}
