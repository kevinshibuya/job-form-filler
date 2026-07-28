/** Hosts whose second-level domain names the ATS platform, never the employer. */
const PLATFORM_SLDS = new Set([
  'greenhouse', 'lever', 'myworkdayjobs', 'workday', 'ashbyhq', 'bamboohr',
  'smartrecruiters', 'icims', 'workable', 'recruitee', 'gupy',
])

/**
 * Best-effort ONE-SHOT guess shown in an editable field; the user's edit always
 * wins downstream. Title "… at Company" first, then a company-owned host's
 * second-level domain. ATS platform hosts, IPs and localhost yield null.
 */
export function guessCompany(title: string, hostname: string): string | null {
  const at = /\bat ([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*)\s*$/.exec(title)
  if (at?.[1] !== undefined) return at[1].trim()

  if (/^[\d.]+$/.test(hostname) || hostname === 'localhost') return null
  const parts = hostname.replace(/^www\./, '').split('.')
  if (parts.length < 2) return null
  const sld = parts[parts.length - 2]!
  if (sld === '' || PLATFORM_SLDS.has(sld)) return null
  return sld.charAt(0).toUpperCase() + sld.slice(1)
}
