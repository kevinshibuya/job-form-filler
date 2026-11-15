import type { EnumField, FieldHandle, HostErrorKind, Resolution, ResolveFirstResult, ResolveMappingResult } from '@jff/shared'

/**
 * Test-only. A fake Native host's answer to the two Resolution requests, split
 * from ONE list of Resolutions the way the real host splits them: the outcomes
 * that need no model (`auto`, `skipped`) come back from `resolve.first`, and
 * every other Field is left pending for `resolve.mapping`.
 *
 * `all` is the list, or a function of the Fields the request carries. Returns
 * undefined for any other method, so a bridge can fall through:
 *
 *   const two = answerTwoStep(method, params, resolutions)
 *   if (two !== undefined) return two
 */
export function answerTwoStep(
  method: string,
  params: unknown,
  all: Resolution[] | ((fields: EnumField[]) => Resolution[]),
  llmError: { kind: HostErrorKind; message: string } | null = null,
): ResolveFirstResult | ResolveMappingResult | undefined {
  if (method !== 'resolve.first' && method !== 'resolve.mapping') return undefined
  const p = params as { epoch?: number; fields?: EnumField[] }
  const fields = p.fields ?? []
  const epoch = p.epoch ?? 1
  const list = typeof all === 'function' ? all(fields) : all
  const byRef = new Map(list.map((r) => [refOf(r.handle), r]))
  const asked = fields.flatMap((f) => byRef.get(refOf(f)) ?? [])

  if (method === 'resolve.first') {
    const resolutions = asked.filter((r) => r.tier === 'auto' || r.tier === 'skipped')
    const decided = new Set(resolutions.map((r) => refOf(r.handle)))
    const pending: FieldHandle[] = fields
      .filter((f) => !decided.has(refOf(f)))
      .map((f) => ({ frameId: f.frameId, fid: f.fid, epoch: f.epoch }))
    return { epoch, resolutions, pending }
  }
  return { epoch, resolutions: asked, llmError }
}

const refOf = (h: { frameId: number; fid: number }): string => `${h.frameId}:${h.fid}`
