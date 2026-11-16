import { SALARY_PERIODS, salaryPeriodWords } from '@jff/shared'
import { INPUT } from './ui'

interface SalaryDraft { amount: string; currency: string; period: string }

const EMPTY: SalaryDraft = { amount: '', currency: '', period: '' }

/**
 * The three parts of a draft salary as typed. The draft is the canonical text
 * once stored, and a JSON object of whatever was typed while the user is
 * still at it; any other text has no parts.
 */
function partsOf(value: string): SalaryDraft {
  if (!value.startsWith('{')) return EMPTY
  try {
    const o: unknown = JSON.parse(value)
    if (typeof o !== 'object' || o === null) return EMPTY
    const { amount, currency, period } = o as Record<string, unknown>
    const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
    return { amount: text(amount), currency: text(currency), period: text(period) }
  } catch {
    return EMPTY
  }
}

/**
 * A salary: its amount, its currency and the period it is paid by. `value` is
 * the draft text; a change hands back the parts as typed, as JSON, and empty
 * once all three are. A write stores the canonical form or is refused, and
 * the editor says the refusal beside the key until all three are given.
 * Built from the panel's own primitives: two inputs and a select.
 */
export function SalaryEditor({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const parts = partsOf(value)
  const change = (patch: Partial<SalaryDraft>): void => {
    const next = { ...parts, ...patch }
    onChange(next.amount.trim() === '' && next.currency.trim() === '' && next.period === '' ? '' : JSON.stringify(next))
  }
  return (
    <div className="grid grid-cols-[1fr_5rem_8rem] gap-1" data-jff-salary="1">
      <input
        id={id} className={INPUT} aria-label="Salary amount" inputMode="decimal" placeholder="90000"
        value={parts.amount} onChange={(e) => change({ amount: e.target.value })}
      />
      <input
        className={INPUT} aria-label="Salary currency" placeholder="EUR" maxLength={3}
        value={parts.currency} onChange={(e) => change({ currency: e.target.value })}
      />
      <select className={INPUT} aria-label="Salary period" value={parts.period} onChange={(e) => change({ period: e.target.value })}>
        <option value="">Period</option>
        {SALARY_PERIODS.map((p) => <option key={p} value={p}>{salaryPeriodWords(p)}</option>)}
      </select>
    </div>
  )
}
