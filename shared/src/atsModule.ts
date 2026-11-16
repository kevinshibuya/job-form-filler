/**
 * ATS modules (spec #41, ADR 0007): what the tool knows about one ATS, layered
 * over what it knows about every form. One file per ATS under atsModules/, made
 * of plain data and pure functions with no browser extension calls, so the page
 * script, the Side panel, the Native host and the scripts can all read it.
 *
 * Every layer is optional. A module ships only the rules a fixture backs, so an
 * empty module is correct. The generic module has no layers, and an ATS with no
 * module, or no ATS at all, gets it.
 */

import type { AtsId } from './ats.js'
import type { EnumField } from './field.js'
import { ashby } from './atsModules/ashby.js'
import { greenhouse } from './atsModules/greenhouse.js'
import { lever } from './atsModules/lever.js'

/** Given a Control's element, the element that holds its question's text, or null. */
export type LabelRule = (control: Element) => Element | null

/** Where the Job posting text sits on a page: a CSS selector, as a picked spot is. */
export type JobTextSpot = string

export interface PostingPage {
  /** The Job posting page's address. */
  readonly url: string
  /** Where the text sits on that page. */
  readonly spot: JobTextSpot
}

export interface JobTextRule {
  /** Where the text sits on the form's own page. */
  readonly onFormPage?: JobTextSpot
  /** Given the form page's address, the Job posting page and where the text
   *  sits there, or null when this form page has none. */
  readonly postingPage?: (formPageUrl: string) => PostingPage | null
}

/** Given a Field as Enumeration reports it, whether to drop it. */
export type JunkRule = (field: EnumField) => boolean

export interface AtsModule {
  readonly id: AtsId | 'generic'
  readonly labelRule?: LabelRule
  readonly jobText?: JobTextRule
  readonly junkRule?: JunkRule
  /** One sentence the empty state adds on this ATS. */
  readonly emptyStateHint?: string
}

export const GENERIC_MODULE: AtsModule = Object.freeze({ id: 'generic' })

const MODULES: ReadonlyMap<string, AtsModule> = new Map(
  [greenhouse, ashby, lever].map((mod) => [mod.id, mod]),
)

/** The module of an ATS, or the generic module for an id with none, for an
 *  unknown id and for no id at all. Never throws. */
export function atsModule(id: string | null | undefined): AtsModule {
  return (id == null ? undefined : MODULES.get(id)) ?? GENERIC_MODULE
}
