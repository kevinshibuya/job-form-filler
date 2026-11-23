// The probe's job description measures (spec #98, ticket #109). For each page
// whose panel settled, the probe reads where the Scan's Job posting text came
// from, then types the page's own address into the panel's link box and reads
// what the link gave. The link box fetches that address without cookies and
// parses it without running a script, so the second measure says how many
// sites serve their posting text without scripts.
//
// readJobTextLine and readLinkBox run inside the panel through page.evaluate:
// each must stay self-contained, with no reference to anything outside it.

/** The sources a probe's Scan can end with, in the table's order: the ATS
 *  module, the user's pick, a heuristic, nothing found. A fresh profile holds
 *  no paste and no link, so neither is counted. */
export const COUNTED_SOURCES = Object.freeze(['ats', 'pick', 'heuristic', 'none'])

/** How long the probe waits for the link box: the read gives up after 5 s,
 *  so this leaves room for the panel to render its answer. */
export const LINK_BOX_WAIT_MS = 15_000

/** The line under the job description box: its source marker and its text. */
export function readJobTextLine() {
  const line = document.querySelector('[data-jff-jobtext-source]')
  if (line === null) return null
  return { source: line.getAttribute('data-jff-jobtext-source'), text: line.textContent ?? '' }
}

/** The link box and the line it may have changed: whether a read is under
 *  way, which message shows, and the job description line. */
export function readLinkBox() {
  const box = document.querySelector('[data-jff-link]')
  const line = document.querySelector('[data-jff-jobtext-source]')
  return {
    reading: box?.querySelector('button')?.disabled === true,
    failed: box?.querySelector('[data-jff-link-failed]') != null,
    refused: box?.querySelector('[data-jff-link-refused]') != null,
    source: line?.getAttribute('data-jff-jobtext-source') ?? null,
    text: line?.textContent ?? '',
  }
}

/** The character count the line states: "1200 characters · a heuristic". */
function lengthOf(text) {
  const m = /(\d+) characters?\b/.exec(text ?? '')
  return m === null ? null : Number(m[1])
}

/** The source and length of the Job posting text, or null with no line. */
export function jobTextOf(line) {
  if (line === null || line === undefined) return null
  return { source: line.source === '' ? null : line.source, length: lengthOf(line.text) }
}

/** What the link gave: its text's length, the failure message, or null while
 *  the read is under way or when the box gave neither answer. */
export function linkBoxOf(state) {
  if (state === null || state === undefined || state.reading) return null
  if (state.source === 'link') return { readable: true, length: lengthOf(state.text) }
  if (state.failed) return { readable: false, length: null }
  return null
}

/** How many pages ended with each counted source. A page with no source, or
 *  one outside the four, counts in none. */
export function jobTextCounts(pages) {
  const counts = Object.fromEntries(COUNTED_SOURCES.map((s) => [s, 0]))
  for (const p of pages) {
    const source = p.jobText?.source
    if (COUNTED_SOURCES.includes(source)) counts[source] += 1
  }
  return counts
}

/** How many pages the link box read, of those where it gave an answer. */
export function linkBoxCounts(pages) {
  let read = 0
  let tried = 0
  for (const p of pages) {
    const readable = p.linkBox?.readable
    if (typeof readable !== 'boolean') continue
    tried += 1
    if (readable) read += 1
  }
  return { read, tried }
}
