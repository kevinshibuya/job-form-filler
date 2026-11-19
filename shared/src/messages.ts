import { z } from 'zod'
import { CityPartsSchema, EnumFieldSchema, FieldHandleSchema, PhonePartsSchema, ResolutionSchema } from './field.js'
import { FIELD_KEYS } from './keys.js'
import { CaptureSaveParamsSchema } from './capture.js'

// Re-exported so `./messages.js` alone carries the field-identity types it
// builds its request/response schemas from (see shared/src/messages.test.ts).
export { EnumFieldSchema, FieldHandleSchema, ResolutionSchema } from './field.js'

/* ---------------------------------------------------------------- host RPC */

export const HOST_ERROR_KINDS = [
  'not_installed', 'not_authed', 'rate_limit', 'timeout',
  'process', 'invalid_output', 'db', 'bad_request', 'unreachable',
] as const
export const HostErrorKindSchema = z.enum(HOST_ERROR_KINDS)
export type HostErrorKind = z.infer<typeof HostErrorKindSchema>

export const SavedQaSchema = z.object({
  id: z.number().int(),
  questionRaw: z.string(),
  answer: z.string(),
  language: z.enum(['en', 'pt']),
  reusability: z.enum(['reusable', 'company_specific']),
})
export type SavedQa = z.infer<typeof SavedQaSchema>

export const SaveItemSchema = z.object({
  handle: FieldHandleSchema,
  questionRaw: z.string(),
  answer: z.string(),
  reusability: z.enum(['reusable', 'company_specific']),
  // Facts never travel through Save answers: they reach profile/answer_bank
  // only through "Save to profile" and the Profile editor. The property stays
  // on the wire so an older panel that still sends a key fails validation
  // loudly instead of being silently ignored.
  fieldKey: z.null(),
})
export type SaveItem = z.infer<typeof SaveItemSchema>

/** What every Resolution request carries: the Scan's context and its Fields. */
export const ResolveParamsSchema = z.object({
  epoch: z.number().int(),
  url: z.string(),
  hostname: z.string(),
  company: z.string().nullable(),
  jobText: z.string(),
  fields: z.array(EnumFieldSchema),
  /** The Scan's ATS (an `AtsOrGeneric`), for the host's log only: the host
   *  branches on nothing. Optional, and any string, so a panel and a host a
   *  release apart still talk; an absent one reads as `generic`. */
  ats: z.string().min(1).max(64).optional(),
})
export type ResolveParams = z.infer<typeof ResolveParamsSchema>

export const OptionPickParamsSchema = z.object({
  label: z.string(),
  value: z.string().min(1),
  options: z.array(z.string()).min(1),
})
export type OptionPickParams = z.infer<typeof OptionPickParamsSchema>

/**
 * The reply to `option.pick`: the position (from 0) of one of the Options the
 * request carried, or null for none. There is no text property, and zod strips
 * unknown keys: the model can never write a Value (ADR 0006, ADR 0008).
 */
export const OptionPickResultSchema = z.object({
  position: z.number().int().nonnegative().nullable(),
})
export type OptionPickResult = z.infer<typeof OptionPickResultSchema>

/**
 * `wording.learn` (ticket #35): the user accepted, or picked after a miss, the
 * Option `wording` for a Field answered from the Known key `key`, and
 * `value` is the Value the Option stood for: the key's Value as the
 * Resolution gave it, or the yes or no of a derived answer.
 */
export const LearnWordingParamsSchema = z.object({
  key: z.enum(FIELD_KEYS),
  value: z.string().trim().min(1),
  wording: z.string().trim().min(1),
})
export type LearnWordingParams = z.infer<typeof LearnWordingParamsSchema>

/** The reply to `wording.learn`: false when the Value is not one a wording can be learned for. */
export const LearnWordingResultSchema = z.object({ learned: z.boolean() })
export type LearnWordingResult = z.infer<typeof LearnWordingResultSchema>

/** How an Applied job went out: through the page's form, or by email (spec #66). */
export const APPLIED_CHANNELS = ['form', 'email'] as const
export const AppliedChannelSchema = z.enum(APPLIED_CHANNELS)
export type AppliedChannel = z.infer<typeof AppliedChannelSchema>

/**
 * One Prose Field's final text, kept beside a form Applied job (spec #66):
 * the question as the page wrote it, the text the Session held at Mark
 * applied, whether AI drafted it, whether the user changed the Draft, and the
 * model that wrote the Draft, null when AI drafted nothing.
 */
export const KeptProseAnswerSchema = z.object({
  question: z.string(),
  text: z.string(),
  aiDrafted: z.boolean(),
  edited: z.boolean(),
  model: z.string().nullable(),
})
export type KeptProseAnswer = z.infer<typeof KeptProseAnswerSchema>

/* ------------------------------------------------- the Apply address (#66) */

/** Where a page shows an address: a `mailto:` link, with its link text and its
 *  `subject` parameter (null when it has none), or the visible text, with the
 *  sentence around the address. A link's `body`, `cc` and `bcc` never travel. */
export const AddressContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mailto'), linkText: z.string(), subject: z.string().nullable() }),
  z.object({ kind: z.literal('text'), sentence: z.string() }),
])
export type AddressContext = z.infer<typeof AddressContextSchema>

/** One address a frame's page script found, in the place it found it. */
export const FoundAddressSchema = z.object({ address: z.string(), context: AddressContextSchema })
export type FoundAddress = z.infer<typeof FoundAddressSchema>

/** One address the Side panel offers as the Apply address, with each place
 *  the page shows it, in page order. */
export const ApplyAddressCandidateSchema = z.object({ address: z.string(), contexts: z.array(AddressContextSchema) })
export type ApplyAddressCandidate = z.infer<typeof ApplyAddressCandidateSchema>

/** How the Session's Apply address was chosen: by the model's pick among the
 *  candidates, by the user from the candidate list, or typed by the user. */
export const ApplyAddressChoiceSchema = z.enum(['pick', 'list', 'typed'])
export type ApplyAddressChoice = z.infer<typeof ApplyAddressChoiceSchema>

/** How much of the Job posting text, from its start, the Apply address pick reads. */
export const APPLY_PICK_JOB_TEXT_MAX = 3_000

/**
 * `applyAddress.pick`: the page's candidates with their contexts, the Job
 * posting's title and Company, and the start of its text. All of it is page
 * content. Nothing from the Profile travels with it.
 */
export const ApplyAddressPickParamsSchema = z.object({
  candidates: z.array(ApplyAddressCandidateSchema).min(1),
  title: z.string().nullable(),
  company: z.string().nullable(),
  jobText: z.string(),
})
export type ApplyAddressPickParams = z.infer<typeof ApplyAddressPickParamsSchema>

/**
 * The reply to `applyAddress.pick`: the position (from 0) of one of the
 * candidates the request carried, or null for none. There is no address
 * property, and zod strips unknown keys: the model can never write an address
 * (ADR 0006, ADR 0008).
 */
export const ApplyAddressPickResultSchema = z.object({
  position: z.number().int().nonnegative().nullable(),
})
export type ApplyAddressPickResult = z.infer<typeof ApplyAddressPickResultSchema>

/* ---------------------------------------------- the Application email (#66) */

/** The link Known keys a Job posting may ask an Application email to carry.
 *  The model names which; the Values always come from the Profile. */
export const EMAIL_LINK_KEYS = ['linkedin', 'github', 'portfolio'] as const
export const EmailLinkKeySchema = z.enum(EMAIL_LINK_KEYS)
export type EmailLinkKey = z.infer<typeof EmailLinkKeySchema>

/** The languages an Application email is written in. */
export const EMAIL_LANGUAGES = ['en', 'pt'] as const
export const EmailLanguageSchema = z.enum(EMAIL_LANGUAGES)
export type EmailLanguage = z.infer<typeof EmailLanguageSchema>

/** The longest instruction a Draft request takes, in characters. */
export const EMAIL_INSTRUCTION_MAX = 300

/**
 * `email.draft`: what the Side panel holds for one Application email. The Job
 * posting text, the title and the page's subject are page content; the
 * Resume text is the user's own. The Native host reads the Profile itself.
 * `pageSubject` is the subject of the first `mailto:` link to the Apply
 * address, in page order, or null when the page gave none.
 *
 * `language` is the one the user switched to; without it the Native host
 * decides from the Job posting text. `instruction` is the user's own text,
 * such as "shorter", for Regenerate; one longer than the cap is refused.
 */
export const EmailDraftParamsSchema = z.object({
  jobText: z.string().refine((s) => s.trim() !== '', 'an Application email needs Job posting text'),
  company: z.string().nullable(),
  title: z.string().nullable(),
  pageSubject: z.string().nullable(),
  cvText: z.string().optional(),
  language: EmailLanguageSchema.optional(),
  instruction: z.string().max(EMAIL_INSTRUCTION_MAX).optional(),
})
export type EmailDraftParams = z.infer<typeof EmailDraftParamsSchema>

/**
 * The reply to `email.draft`. `body` is the assembled plain text: the model's
 * prose, then the requested links from the Profile, then the signature.
 * `missingLinks` names each link the posting asks for that the Profile does
 * not hold, left out of the body. `unsupportedClaims` quotes each sentence of
 * the prose the Draft check flagged, and each that holds a link or an
 * address. `unchecked` is true when the Draft check failed and the Draft is
 * shown without it (ADR 0004). `model` wrote the Draft, in `language`.
 */
export const EmailDraftResultSchema = z.object({
  subject: z.string(),
  body: z.string(),
  model: z.string(),
  language: EmailLanguageSchema,
  missingLinks: z.array(EmailLinkKeySchema),
  unsupportedClaims: z.array(z.string()),
  unchecked: z.boolean(),
})
export type EmailDraftResult = z.infer<typeof EmailDraftResultSchema>

/** How an Application email left: sent through the tool, or handed to the
 *  user's mail app by "Open in my mail app". */
export const EMAIL_ROUTES = ['tool', 'mail_app'] as const
export const EmailRouteSchema = z.enum(EMAIL_ROUTES)
export type EmailRoute = z.infer<typeof EmailRouteSchema>

/**
 * The Application email "Open in my mail app" handed over, as `applied.mark`
 * carries it: the Apply address, the subject and the body as they left the
 * Side panel, the language, and for the body whether AI drafted it, whether
 * the user edited it and which model wrote it. Strict: the mail app's email
 * has no Sender address, no attachment names and no Gmail ids, so a mark that
 * names one is refused.
 */
export const HandedOverEmailSchema = z.object({
  applyAddress: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  language: EmailLanguageSchema,
  aiDrafted: z.boolean(),
  edited: z.boolean(),
  model: z.string().nullable(),
}).strict()
export type HandedOverEmail = z.infer<typeof HandedOverEmailSchema>

/**
 * An Application email kept beside an Applied job: both addresses (no Sender
 * address when the mail app sent it), the subject, the body, the attachment
 * names, the time, the language, Gmail's message and thread ids (null unless
 * the tool sent it), the route it left by, and the body's three marks.
 */
export const ApplicationEmailSchema = z.object({
  applyAddress: z.string(),
  senderAddress: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  attachmentNames: z.array(z.string()),
  sentAt: z.string(),
  language: EmailLanguageSchema,
  gmailMessageId: z.string().nullable(),
  gmailThreadId: z.string().nullable(),
  route: EmailRouteSchema,
  aiDrafted: z.boolean(),
  edited: z.boolean(),
  model: z.string().nullable(),
})
export type ApplicationEmail = z.infer<typeof ApplicationEmailSchema>

/**
 * The reply to `applied.get`: one Applied job's stored texts, read only when
 * the user opens it, so `applied.list` stays small. The Application emails
 * come newest first.
 */
export const AppliedTextsSchema = z.object({
  id: z.number().int(),
  proseAnswers: z.array(KeptProseAnswerSchema),
  emails: z.array(ApplicationEmailSchema),
})
export type AppliedTexts = z.infer<typeof AppliedTextsSchema>

/* ------------------------------------------------------------ Mail account */

/** The kinds of Mail account the Native host can reach. Gmail is the only one. */
export const MAIL_KINDS = ['gmail'] as const
export const MailKindSchema = z.enum(MAIL_KINDS)
export type MailKind = z.infer<typeof MailKindSchema>

/** The largest client file `mail.connect.start` takes. Google's is under 1 KB. */
export const CLIENT_FILE_MAX = 64_000

/**
 * The reply to `mail.status` and to `mail.connect.finish`: no Mail account,
 * one that is connected, or one whose sign-in died and needs reconnecting.
 * `connectedAt` is when the account was connected, as an ISO date.
 */
export const MailStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }),
  z.object({ state: z.literal('connected'), kind: MailKindSchema, address: z.string(), connectedAt: z.string() }),
  z.object({ state: z.literal('needs_reconnect'), kind: MailKindSchema, address: z.string(), connectedAt: z.string() }),
])
export type MailStatus = z.infer<typeof MailStatusSchema>

/**
 * A Sender address: one the Mail account may send as, with the display name
 * an Application email from it carries. The name is the "Send mail as"
 * entry's own, or the Profile name when the entry has none; empty when
 * neither holds one.
 */
export const SenderAddressSchema = z.object({ address: z.string(), displayName: z.string() })
export type SenderAddress = z.infer<typeof SenderAddressSchema>

/**
 * The reply to `mail.senders`: the account's own address, every address it
 * may send as (its own first, then its verified "Send mail as" addresses),
 * and the Sender address it last sent from, or null. A sign-in Google
 * refuses answers `not_authed` instead, and the account then needs a
 * reconnect.
 */
export const MailSendersResultSchema = z.object({
  address: z.string(),
  senders: z.array(SenderAddressSchema).min(1),
  lastUsed: z.string().nullable(),
})
export type MailSendersResult = z.infer<typeof MailSendersResultSchema>

/** The reply to `mail.connect.start`: the address of Google's consent page. */
export const MailConnectStartResultSchema = z.object({ consentUrl: z.string() })
export type MailConnectStartResult = z.infer<typeof MailConnectStartResultSchema>

/**
 * The reply to `mail.disconnect`. The secrets and the account's row are gone
 * either way. `revoked` says Google revoked the refresh token; when it could
 * not, `warning` says so, and the user can remove the tool's access in their
 * Google account. With no account there was nothing to revoke: `revoked` is
 * false and `warning` is null.
 */
export const MailDisconnectResultSchema = z.object({ revoked: z.boolean(), warning: z.string().nullable() })
export type MailDisconnectResult = z.infer<typeof MailDisconnectResultSchema>

/** The largest Resume file `mail.send` carries, in bytes before encoding.
 *  Chrome takes a message of 64 MiB to the Native host; base64 inside JSON
 *  grows a file by a third, so 10 MB crosses with room to spare. */
export const RESUME_FILE_MAX = 10_000_000

/** The Resume file as `mail.send` carries it, its bytes base64-encoded. */
export const ResumeFileSchema = z.object({
  name: z.string().trim().min(1),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1).max(Math.ceil(RESUME_FILE_MAX / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'the Resume file is not base64'),
})
export type ResumeFile = z.infer<typeof ResumeFileSchema>

const notBlank = (what: string) => z.string().refine((s) => s.trim() !== '', `an Application email needs ${what}`)

/**
 * `mail.send` (spec #66): everything one Send needs. The Job posting's start
 * address, Company and title; the Apply address and the Sender address; the
 * subject, the final body and its language; the Resume file with its name
 * and type; and for the body whether AI drafted it, whether the user edited
 * it and which model wrote it. The Native host checks the Sender address
 * against the account's own list and keeps no Resume byte.
 */
export const MailSendParamsSchema = z.object({
  url: z.string().min(1),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  applyAddress: notBlank('a To address'),
  senderAddress: notBlank('a Sender address'),
  subject: notBlank('a subject'),
  body: notBlank('a body'),
  language: EmailLanguageSchema,
  resume: ResumeFileSchema,
  aiDrafted: z.boolean(),
  edited: z.boolean(),
  model: z.string().nullable(),
}).strict()
export type MailSendParams = z.infer<typeof MailSendParamsSchema>

/** The reply to a `mail.send` that went out: the Applied job it marked and
 *  Gmail's message id and thread id. */
export const MailSendResultSchema = z.object({
  appliedJobId: z.number().int(),
  markedAt: z.string(),
  gmailMessageId: z.string(),
  gmailThreadId: z.string(),
})
export type MailSendResult = z.infer<typeof MailSendResultSchema>

export const HostRequestSchema = z.discriminatedUnion('method', [
  z.object({ requestId: z.string().min(1), method: z.literal('selfCheck'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('profile.get'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('profile.set'), params: z.object({ values: z.record(z.string(), z.string()) }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('answerBank.get'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('answerBank.set'), params: z.object({ values: z.record(z.string(), z.string()) }) }),
  // Resolution in two requests. `resolve.first` runs no model and answers every
  // Field that needs none; `resolve.mapping` carries the pending Fields
  // themselves and runs Mapping on them. The host keeps no state between the two.
  z.object({ requestId: z.string().min(1), method: z.literal('resolve.first'), params: ResolveParamsSchema }),
  z.object({ requestId: z.string().min(1), method: z.literal('resolve.mapping'), params: ResolveParamsSchema }),
  z.object({
    requestId: z.string().min(1), method: z.literal('generate'),
    params: z.object({
      handle: FieldHandleSchema,
      questionRaw: z.string(),
      description: z.string().optional(),
      jobText: z.string(),
      company: z.string().nullable(),
      // B2b: extracted resume TEXT, trusted candidate-authored context. The raw
      // file still never crosses native messaging (user decision 2026-07-29).
      cvText: z.string().optional(),
      // Strict: Generation for a Prose Field takes no instruction (spec #66),
      // so a request that carries one is refused, not quietly trimmed.
    }).strict(),
  }),
  z.object({
    requestId: z.string().min(1), method: z.literal('facts.extract'),
    // B6: map CV text onto the closed FIELD_KEYS set (host-side prompt).
    params: z.object({ cvText: z.string().min(1) }),
  }),
  z.object({
    requestId: z.string().min(1), method: z.literal('save'),
    params: z.object({
      url: z.string(),
      company: z.string().nullable(),
      items: z.array(SaveItemSchema),
      generatedCount: z.number().int().nonnegative(),
    }),
  }),
  // The model pick (ADR 0008), made at Fill time after a miss: the Field's
  // label, the stored Value it was meant to fill, and the Options the Fill
  // read. Nothing else from the Profile travels with it.
  z.object({ requestId: z.string().min(1), method: z.literal('option.pick'), params: OptionPickParamsSchema }),
  // A Learned wording: an Option the user accepted for a keyed Field.
  z.object({ requestId: z.string().min(1), method: z.literal('wording.learn'), params: LearnWordingParamsSchema }),
  // The Apply address pick (spec #66, ADR 0008): the page's candidates and
  // the Job posting they came with. It answers a position, never an address.
  z.object({ requestId: z.string().min(1), method: z.literal('applyAddress.pick'), params: ApplyAddressPickParamsSchema }),
  // The Application email (spec #66): a Draft of its subject and body.
  z.object({ requestId: z.string().min(1), method: z.literal('email.draft'), params: EmailDraftParamsSchema }),
  z.object({ requestId: z.string().min(1), method: z.literal('selector.get'), params: z.object({ hostname: z.string(), purpose: z.literal('job_description') }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('selector.save'), params: z.object({ hostname: z.string(), purpose: z.literal('job_description'), selector: z.string() }) }),
  // "Not the job description" (spec #41): forget the spot saved for a site.
  // A site with none is not an error.
  z.object({ requestId: z.string().min(1), method: z.literal('selector.clear'), params: z.object({ hostname: z.string().min(1), purpose: z.literal('job_description') }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('mapping.confirm'), params: z.object({ label: z.string(), fieldKey: z.enum(FIELD_KEYS) }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('qa.list'), params: z.object({ page: z.number().int().nonnegative() }) }),
  z.object({
    requestId: z.string().min(1), method: z.literal('applied.mark'),
    // A2: url is the session's captured START url; jobTitle from tab.title, nullable.
    // A mark with no channel is a form mark, and one with no prose answers keeps none.
    // A mark after "Open in my mail app" carries the `email` it handed over
    // and goes by email: a form mark with one is refused.
    params: z.object({
      url: z.string().min(1), company: z.string().nullable(), jobTitle: z.string().nullable(),
      channel: AppliedChannelSchema.optional(),
      proseAnswers: z.array(KeptProseAnswerSchema).optional(),
      email: HandedOverEmailSchema.optional(),
    }).refine((p) => p.email === undefined || p.channel !== 'form', 'a mark with an Application email goes by email'),
  }),
  // `applyAddresses` (spec #66): the page's candidate addresses. The reply
  // gains `appliedByAddress`, the Applied job whose Application email went to
  // one of them, compared without regard to case, or null.
  z.object({
    requestId: z.string().min(1), method: z.literal('applied.check'),
    params: z.object({ url: z.string().min(1), applyAddresses: z.array(z.string()).optional() }),
  }),
  z.object({ requestId: z.string().min(1), method: z.literal('applied.list'), params: z.object({}).passthrough() }),
  // One Applied job's stored texts, read when the user opens it (spec #66).
  z.object({ requestId: z.string().min(1), method: z.literal('applied.get'), params: z.object({ id: z.number().int().positive() }) }),
  // A Capture (spec #41): the cleaned page and what the Scan decided, written
  // to the user's machine and nowhere else.
  z.object({ requestId: z.string().min(1), method: z.literal('capture.save'), params: CaptureSaveParamsSchema }),
  // The Mail account (spec #66). No `mail.` request is ever replayed from the
  // request log. Connect is two requests: `start` takes the dropped client
  // file and answers the consent address; `finish` waits for the sign-in.
  z.object({ requestId: z.string().min(1), method: z.literal('mail.status'), params: z.object({}).passthrough() }),
  // With no client file, `start` is Reconnect: the sign-in runs again with
  // the stored client.
  z.object({
    requestId: z.string().min(1), method: z.literal('mail.connect.start'),
    params: z.object({ clientFile: z.string().min(1).max(CLIENT_FILE_MAX).optional() }),
  }),
  z.object({ requestId: z.string().min(1), method: z.literal('mail.connect.finish'), params: z.object({}).passthrough() }),
  // Disconnect revokes the token at Google when it can, and forgets the
  // account's secrets and its row whether or not Google answered.
  z.object({ requestId: z.string().min(1), method: z.literal('mail.disconnect'), params: z.object({}).passthrough() }),
  // The Sender addresses: asked when an email Review opens and when the
  // settings page shows the account.
  z.object({ requestId: z.string().min(1), method: z.literal('mail.senders'), params: z.object({}).passthrough() }),
  // Send (spec #66): one click, one request. It is never replayed from the
  // request log either: the send attempt it records is its guard.
  z.object({ requestId: z.string().min(1), method: z.literal('mail.send'), params: MailSendParamsSchema }),
])
export type HostRequest = z.infer<typeof HostRequestSchema>
export type HostMethod = HostRequest['method']

export const SelfCheckSchema = z.object({
  node: z.object({ ok: z.boolean(), version: z.string() }),
  claude: z.object({ ok: z.boolean(), path: z.string(), detail: z.string() }),
  auth: z.object({ ok: z.boolean(), detail: z.string() }),
  codex: z.object({ ok: z.boolean(), path: z.string(), detail: z.string() }),
  codexAuth: z.object({ ok: z.boolean(), detail: z.string() }),
  // detail: why the database is not usable, when the host knows (a file from a
  // newer version of the tool). Absent on older hosts.
  db: z.object({ ok: z.boolean(), path: z.string(), detail: z.string().optional() }),
})
export type SelfCheck = z.infer<typeof SelfCheckSchema>

export const HostResponseSchema = z.union([
  z.object({ requestId: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    requestId: z.string(), ok: z.literal(false),
    error: z.object({ kind: HostErrorKindSchema, message: z.string() }),
  }),
])
export type HostResponse = z.infer<typeof HostResponseSchema>

/** Any response that can grow uses this envelope; the panel loops until done. */
export const PageEnvelopeSchema = z.object({
  page: z.number().int().nonnegative(),
  done: z.boolean(),
  items: z.array(z.unknown()),
  /** Items dropped because they alone exceed the byte budget (see host/src/chunk.ts). */
  omitted: z.number().int().nonnegative(),
})

// There is deliberately NO customQuestions list here: each Resolution Mapping
// matched to nothing carries its own `fieldClass`, and the panel offers
// [Generate] only on a Needs input Prose Field on a text Control.
export const ResolveResultSchema = z.object({
  epoch: z.number().int(),
  resolutions: z.array(ResolutionSchema),
  /**
   * Set when the batched mapping call failed. Every unresolved field is already
   * needs-input; this only tells the panel WHICH banner to show.
   */
  llmError: z.object({ kind: HostErrorKindSchema, message: z.string() }).nullable(),
})
export type ResolveResult = z.infer<typeof ResolveResultSchema>

/**
 * The reply to `resolve.first`: a Resolution for every Field that needs no
 * model, and the handles of the Fields left for `resolve.mapping`. Every Field
 * of the request is in exactly one of the two lists.
 */
export const ResolveFirstResultSchema = z.object({
  epoch: z.number().int(),
  resolutions: z.array(ResolutionSchema),
  pending: z.array(FieldHandleSchema),
})
export type ResolveFirstResult = z.infer<typeof ResolveFirstResultSchema>

/** The reply to `resolve.mapping`: a Resolution for every Field it carries. */
export const ResolveMappingResultSchema = ResolveResultSchema
export type ResolveMappingResult = ResolveResult

/* ------------------------------------------------ panel <-> content script */

export const ContentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('JFF_PROBE') }),
  z.object({ type: z.literal('JFF_SCAN'), epoch: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('JFF_FILL'), epoch: z.number().int().nonnegative(),
    // `candidates`: the candidate words of the row's Value (Resolution.candidates).
    // Absent once the user edited the Value: an edited Value matches by its own text.
    // `phone`: the parts of a phone Value (Resolution.phone), on the same terms.
    // `city`: the stored country's names beside a city (Resolution.city), likewise.
    // No `value`: a read (ticket #34). The Fill reads the Control's Options,
    // changes nothing on the page, and reports them as a miss does, with the
    // reason OPTIONS_READ.
    fills: z.array(z.object({
      handle: FieldHandleSchema, value: z.string().optional(), candidates: z.array(z.string()).optional(),
      phone: PhonePartsSchema.optional(), city: CityPartsSchema.optional(),
    })),
  }),
  z.object({ type: z.literal('JFF_SNAPSHOT'), epoch: z.number().int().nonnegative() }),
  z.object({ type: z.literal('JFF_PICK'), epoch: z.number().int().nonnegative() }),
  z.object({ type: z.literal('JFF_JOBTEXT'), epoch: z.number().int().nonnegative(), selector: z.string().nullable() }),
  // A3: the panel's submission-detection needs the page's VISIBLE text after a
  // wizard-step re-scan; jobText heuristics answer a different question.
  z.object({ type: z.literal('JFF_PAGETEXT'), epoch: z.number().int().nonnegative() }),
  // A Capture (spec #41): the frame cleans a copy of its page and hands back
  // only that. `held`: the Values the Side panel knows for this frame's Fields,
  // by fid, beside what each Control shows itself, so a committed dropdown
  // choice shown as ordinary text is blanked inside its own widget.
  z.object({
    type: z.literal('JFF_CAPTURE'), epoch: z.number().int().nonnegative(),
    held: z.array(z.object({ fid: z.number().int().nonnegative(), value: z.string() })),
  }),
  z.object({
    type: z.literal('JFF_FILL_RESUME'),
    epoch: z.number().int().nonnegative(),
    handle: FieldHandleSchema,
    // The resume travels as base64 because chrome runtime messaging is JSON, not
    // structured clone: a File or Blob would not survive the trip.
    fileName: z.string(),
    mimeType: z.string(),
    dataBase64: z.string(),
  }),
])
export type ContentMessage = z.infer<typeof ContentMessageSchema>

/** The longest sentence a text context keeps, and a link text too. */
export const ADDRESS_SENTENCE_MAX = 200
/** The most contexts one candidate keeps. */
export const ADDRESS_CONTEXTS_MAX = 3
/** The most candidates the Side panel offers. */
export const APPLY_CANDIDATES_MAX = 10
/** The most addresses one frame reports, after its repeats are dropped. */
export const FRAME_ADDRESSES_MAX = 50

const ADDRESS_SHAPE = /^[^\s@<>()[\]",;:]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/

/**
 * Whether a string is shaped like an email address: one `@`, something before
 * it, and a dotted domain after it. Shape only: nothing says the address
 * exists. The caller trims what the user typed.
 */
export function isAddressShape(s: string): boolean {
  return ADDRESS_SHAPE.test(s)
}

// Both schemas below have a REAL runtime consumer: the content script `safeParse`s
// its own JFF_SCAN / JFF_FILL reply before returning it (Task 14 Step 5, Task 15
// Step 5). Validating our own output is the cheapest guard against enumerator or
// filler drift shipping a malformed field into the host's Resolution requests, where it
// would fail as an opaque bad_request instead of naming the offending frame.
export const ScanResultSchema = z.object({
  epoch: z.number().int(),
  fields: z.array(EnumFieldSchema),
  unreachableWidgets: z.number().int().nonnegative(),
  activeCaptcha: z.boolean(),
  /** #37: the labels of upload groups that show an attached file, or one still
   *  uploading, in place of their file input, so the panel sends no second
   *  resume. Optional so a stale content script simply omits it, and an absent
   *  list reads as none. */
  attachedUploads: z.array(z.string()).optional(),
  /** #49: this document already took the Resume once, through an upload it
   *  kept, so a second Scan sends none. Optional like `attachedUploads`: a
   *  stale content script omits it, and absent reads as not uploaded. */
  resumeUploaded: z.boolean().optional(),
  /** Spec #66: the addresses this frame's document shows, in page order.
   *  Optional so a stale content script simply omits it: absent reads as none. */
  addresses: z.array(FoundAddressSchema).optional(),
})
export type ScanResult = z.infer<typeof ScanResultSchema>

/**
 * The Options a Fill of a choice Control read on the page, on a hit and on a
 * miss (ADR 0009: a Scan opens no menu, so a dropdown's Options are first known
 * here). Absent on a text Control, and on a dropdown that showed none before
 * anything was typed into it.
 */
const FillOptionsSchema = z.array(z.string()).optional()

export const FillReportSchema = z.object({
  epoch: z.number().int(),
  /** B1c: `committed` carries the page-accepted canonical text when it differs
   *  from the requested value ('bra' legitimately commits 'Brazil'), else null.
   *  The panel canonicalizes the row value from it. */
  filled: z.array(z.object({ handle: FieldHandleSchema, committed: z.string().nullable(), options: FillOptionsSchema })),
  failed: z.array(z.object({ handle: FieldHandleSchema, reason: z.string(), options: FillOptionsSchema })),
})
export type FillReport = z.infer<typeof FillReportSchema>

export const STALE_EPOCH = 'stale_epoch' as const

/**
 * The reason a Fill entry sent with no Value reports: the Control's Options
 * were read and nothing on the page changed (ticket #34). The Options travel
 * with it, as on a miss, and are absent when the Control showed none.
 */
export const OPTIONS_READ = 'options-read' as const
