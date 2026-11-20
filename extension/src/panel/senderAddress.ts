import type { MailSendersResult, SenderAddress } from '@jff/shared'

/** The address as the list holds it, compared without regard to case. */
const inList = (list: readonly SenderAddress[], address: string | null): string | null =>
  address === null ? null : list.find((s) => s.address.toLowerCase() === address.toLowerCase())?.address ?? null

/**
 * The Sender address the email Review shows (spec #66): the Session's choice
 * while the list still holds it, else the last used Sender address while the
 * list holds that, else the account's own address.
 */
export function senderOf(list: MailSendersResult, sessionChoice: string | null): string {
  return inList(list.senders, sessionChoice)
    ?? inList(list.senders, list.lastUsed)
    ?? inList(list.senders, list.address)
    ?? list.senders[0]!.address
}

/** "Ada Lovelace <ada@example.com>", or the address alone with no name. */
export const senderLabel = (s: SenderAddress): string =>
  s.displayName.trim() === '' ? s.address : `${s.displayName} <${s.address}>`
