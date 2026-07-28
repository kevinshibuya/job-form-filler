import { MAX_HOST_TO_EXT_BYTES } from './framing.js'

/** Leave room for the response envelope around the items array. */
const DEFAULT_BUDGET = MAX_HOST_TO_EXT_BYTES - 64 * 1024

export interface Paged<T> {
  page: number
  done: boolean
  items: T[]
  /** Items dropped because they ALONE exceed the byte budget: such an item could
   *  never be framed, so emitting it as "its own page" would only move the
   *  MessageTooLarge failure to write time. The count makes the loss explicit. */
  omitted: number
}

/**
 * The `{ page, done }` convention every growable host response uses. Pages are
 * computed deterministically from the same input array, so the panel can request
 * page N without the host holding a cursor. INVARIANT: every page this function
 * emits fits inside a native-messaging frame after the response envelope is
 * added (asserted by the encodeMessage test).
 */
export function paginate<T>(items: T[], page: number, budgetBytes: number = DEFAULT_BUDGET): Paged<T> {
  let omitted = 0
  const pages: T[][] = []
  let current: T[] = []
  let size = 0
  for (const item of items) {
    const itemSize = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1
    if (itemSize > budgetBytes) { omitted++; continue }
    if (current.length > 0 && size + itemSize > budgetBytes) {
      pages.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += itemSize
  }
  if (current.length > 0) pages.push(current)
  const slice = pages[page]
  if (slice === undefined) return { page, done: true, items: [], omitted }
  return { page, done: page >= pages.length - 1, items: slice, omitted }
}
