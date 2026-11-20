import { z } from 'zod'
import { ApplyAddressChoiceSchema } from '@jff/shared'
import type { HostPort } from './port'

/**
 * The Revisit badge by Apply address (spec #66, ticket #76), the Side panel's
 * half. Before the Apply address pick runs, and before the Draft for an
 * address the user chose, the panel asks the Native host whether one of the
 * addresses was already mailed. A hit holds what was waiting until the user
 * clicks "Draft anyway". The badge warns and never blocks: one address often
 * takes every opening at a Company.
 */

/** What waits for "Draft anyway": the pick over the candidates, or the Draft
 *  for the address the user picked from the list or typed. */
export const RevisitWaitingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pick') }),
  z.object({ kind: z.literal('choose'), address: z.string(), how: ApplyAddressChoiceSchema.exclude(['pick']) }),
])
export type RevisitWaiting = z.infer<typeof RevisitWaitingSchema>

/** The Applied job an address was already mailed for, and what waits. The
 *  Session keeps it, so a reopened panel still shows the badge. */
export const AddressRevisitSchema = z.object({
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  markedAt: z.string(),
  waiting: RevisitWaitingSchema,
})
export type AddressRevisit = z.infer<typeof AddressRevisitSchema>

const HitSchema = z.object({ company: z.string().nullable(), jobTitle: z.string().nullable(), markedAt: z.string() })
export type AddressRevisitJob = z.infer<typeof HitSchema>

/**
 * Ask the Native host whether any of these addresses was the Apply address
 * of an Applied job. Never throws: a failed or malformed check is no hit, as
 * a failed check by Canonical URL is.
 */
export async function requestAddressRevisit(
  port: HostPort | null | undefined, url: string, addresses: readonly string[],
): Promise<AddressRevisitJob | null> {
  if (port === null || port === undefined || addresses.length === 0) return null
  try {
    const r = await port.request<{ appliedByAddress?: unknown }>('applied.check', { url, applyAddresses: [...addresses] })
    if (!r.ok) return null
    const hit = HitSchema.safeParse(r.result.appliedByAddress)
    return hit.success ? hit.data : null
  } catch {
    return null
  }
}

/** The badge's words: the Applied job's title and Company, as far as they
 *  are known, and the date it was marked. */
export function revisitWords(hit: Pick<AddressRevisit, 'company' | 'jobTitle' | 'markedAt'>): string {
  const title = hit.jobTitle?.trim() ?? ''
  const company = hit.company?.trim() ?? ''
  const job = title !== '' && company !== '' ? `${title} at ${company}`
    : title !== '' ? title
    : company !== '' ? company
    : 'a job'
  return `Already applied to ${job} by email to this address on ${new Date(hit.markedAt).toLocaleDateString()}.`
}
