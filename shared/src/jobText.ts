import { z } from 'zod'

/**
 * The Job posting text (spec #41): where a Session's text came from, and the
 * limits every source shares.
 */

/** The fewest characters a text from any source but the user's paste may hold. */
export const JOB_TEXT_MIN = 400

/** The most characters any source's text keeps. */
export const JOB_TEXT_MAX = 50_000

/**
 * Where the Session's Job posting text came from, in the order a Scan tries
 * them: the user's paste, the ATS module, a spot the user picked, a
 * heuristic. `none` is a Scan that found nothing, or a text the user threw
 * away.
 */
export const JOB_TEXT_SOURCES = ['paste', 'ats', 'pick', 'heuristic', 'none'] as const
export const JobTextSourceSchema = z.enum(JOB_TEXT_SOURCES)
export type JobTextSource = z.infer<typeof JobTextSourceSchema>

/**
 * The page script's reply to `JFF_JOBTEXT`. `learned` is the text at the spot
 * the user picked, read through the selector saved for the site; `selector`
 * is the spot the text was read from.
 */
export const JobTextReplySchema = z.object({
  text: z.string(),
  selector: z.string().nullable(),
  source: z.enum(['ats', 'learned', 'heuristic', 'none']),
})
export type JobTextReply = z.infer<typeof JobTextReplySchema>
