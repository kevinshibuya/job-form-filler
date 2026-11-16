import { RULE_LANGUAGES, RULE_TABLE } from './ruleTable.js'

/**
 * The country reader: which countries, from the closed list of the rule
 * table, a Field's label names, in English and Portuguese. A label that lists
 * several countries names all of them, each once, in the order it names them.
 *
 * A full name is read in any case and with or without its accents. A short
 * form (US, USA, U.S., UK, UAE, EUA) is read only in capitals: "work for us"
 * names no country. Either is read only as a whole word, and a longer name
 * wins over a shorter one inside it ("South Africa" is not "Africa").
 *
 * A region is not a country. The reader names the regions a label mentions
 * (EMEA, LATAM, the EU) beside its countries, so a rule can refuse to guess
 * which countries a company means by one.
 */

export interface PlacesRead {
  /** ISO 3166 codes of the closed list, in the order the label names them. */
  readonly countries: string[]
  /** The regions the label names, in its own words, in order. */
  readonly regions: string[]
}

const REGIONS: readonly string[] = [
  // English
  'EMEA', 'LATAM', 'APAC', 'EU', 'EEA', 'European Union', 'European Economic Area', 'Europe',
  'Latin America', 'North America', 'South America', 'Central America', 'Americas',
  'Asia', 'Asia Pacific', 'Asia-Pacific', 'Middle East', 'Africa', 'Oceania', 'Nordics', 'Scandinavia',
  // Portuguese
  'UE', 'União Europeia', 'Europa', 'América Latina', 'América do Norte', 'América do Sul',
  'América Central', 'Américas', 'Ásia', 'Oriente Médio', 'África', 'Escandinávia',
]

/** A short form is all capitals, dots allowed, and at most five letters. */
const isShortForm = (word: string): boolean => /^[A-Z][A-Z.]*$/.test(word) && word.replace(/\./g, '').length <= 5

/** Accents off, case kept: positions stay those of the label once it is composed. */
const stripAccents = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC')

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Pattern {
  readonly re: RegExp
  readonly country: string | null
  readonly region: string | null
}

function patternOf(word: string, country: string | null, region: string | null): Pattern {
  const body = escape(stripAccents(word)).replace(/ /g, '\\s+')
  const flags = isShortForm(word) ? 'gu' : 'giu'
  return { re: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags), country, region }
}

const PATTERNS: readonly Pattern[] = [
  ...Object.keys(RULE_TABLE.en.countries).flatMap((code) =>
    RULE_LANGUAGES.flatMap((l) => RULE_TABLE[l].countries[code] ?? []).map((w) => patternOf(w, code, null))),
  ...REGIONS.map((w) => patternOf(w, null, w)),
]

interface Hit { start: number; end: number; country: string | null; region: string | null }

/** Every country and region the label names. */
export function readPlaces(label: string): PlacesRead {
  const composed = label.normalize('NFC')
  const text = stripAccents(composed)
  const hits: Hit[] = []
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      hits.push({ start: m.index, end: m.index + m[0].length, country: p.country, region: p.region })
    }
  }
  // Longest first: a name inside a longer accepted one is not read.
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
  const kept: Hit[] = []
  for (const h of hits) {
    if (kept.some((k) => h.start < k.end && k.start < h.end)) continue
    kept.push(h)
  }
  kept.sort((a, b) => a.start - b.start)
  const countries: string[] = []
  const regions: string[] = []
  for (const h of kept) {
    if (h.country !== null && !countries.includes(h.country)) countries.push(h.country)
    // A region is reported in the label's own words, as written there.
    const said = composed.slice(h.start, h.end)
    if (h.region !== null && !regions.includes(said)) regions.push(said)
  }
  return { countries, regions }
}

/** The ISO 3166 codes of the countries the label names, in order, each once. */
export function readCountries(label: string): string[] {
  return readPlaces(label).countries
}
