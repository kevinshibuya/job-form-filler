import { norm, optionSetLabels, optionSetValue, type EnumField } from '@jff/shared'

/**
 * The tick-box editors of the Side panel. A checkbox group shows its Options as
 * tick boxes, so the user reads and answers the question without scrolling the
 * page; a Consent checkbox shows one tick box. Both write the row's Value as
 * text: a group the ticked labels in page order, one per line; a Consent
 * checkbox "true" when ticked, nothing when not.
 */

/** A row answered by ticking: a checkbox group or a Consent checkbox. Such a
 *  row is never drafted by Generation. */
export function isTickRow(field: Pick<EnumField, 'kind'>): boolean {
  return field.kind === 'checkbox' || field.kind === 'checkboxgroup'
}

const AFFIRMATIVE_RE = /^(true|yes|sim|on|1|checked)$/i

/** The Options a Value holds, compared under `norm` as Fill compares them. */
function chosenOf(value: string): Set<string> {
  return new Set(optionSetLabels(value).map(norm))
}

export function CheckboxGroupEditor(p: {
  options: string[]
  value: string
  labelledBy: string
  onChange: (value: string) => void
}) {
  const chosen = chosenOf(p.value)
  const toggle = (option: string): void => {
    const next = new Set(chosen)
    if (next.has(norm(option))) next.delete(norm(option))
    else next.add(norm(option))
    p.onChange(optionSetValue(p.options.filter((o) => next.has(norm(o)))))
  }
  return (
    <div className="mt-1.5 grid gap-0.5" role="group" aria-labelledby={p.labelledBy} data-jff-editor="checkboxes">
      {p.options.map((option, i) => (
        <label key={`${i}:${option}`} className="flex items-center gap-1.5">
          <input type="checkbox" checked={chosen.has(norm(option))} onChange={() => toggle(option)} />
          <span>{option}</span>
        </label>
      ))}
    </div>
  )
}

export function ConsentTick(p: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="mt-1.5" data-jff-editor="consent">
      <input
        type="checkbox" id={p.id}
        checked={AFFIRMATIVE_RE.test(p.value.trim())}
        onChange={(e) => p.onChange(e.target.checked ? 'true' : '')}
      />
    </div>
  )
}
