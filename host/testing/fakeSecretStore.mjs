// Test-only. A secret store held in memory, in place of the macOS Keychain
// (spec #66): no test touches the real one. It lives outside host/src, so the
// Native host's shipped output never holds it; the build proof greps host/dist
// for the marker below.
export const FAKE_MAIL_MARKER = 'jffFakeMail'

export function createFakeSecretStore(initial = {}) {
  const items = new Map(Object.entries(initial))
  return {
    /** The secrets as the store holds them, by account name. */
    items,
    async set(account, secret) { items.set(account, secret) },
    async get(account) { return items.has(account) ? items.get(account) : null },
    async delete(account) { items.delete(account) },
  }
}
