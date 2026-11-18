// Types for privateStrings.mjs, which stays plain JavaScript so the guard can
// import it with nothing installed and nothing built.

export interface Finding {
  readonly rule: 'private-string' | 'email' | 'home-path' | 'credential'
  readonly detail: string
}

export const ALLOWED_LITERALS: ReadonlySet<string>
export const EMAIL: RegExp
export const SECRET: RegExp
export function emailAllowed(address: string): boolean
export function parseDenylist(text: string): string[]
export function scanLine(line: string, denylist?: readonly string[]): Finding[]
export function redactPrivate(text: string, denylist?: readonly string[]): string
