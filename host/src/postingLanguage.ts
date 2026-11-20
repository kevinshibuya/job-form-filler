import type { EmailLanguage } from '@jff/shared'

/**
 * The language of a whole Job posting, for its Application email (spec #66):
 * Portuguese when the posting is in Portuguese, English otherwise. A posting
 * in a language the Profile does not list, Spanish or French say, is English.
 *
 * The question detector (`detectLanguage` in resolve/normalize.ts) is not
 * reused here. It answers Portuguese on one hint word and reads only the
 * first stretch of the text, so a Spanish posting, which shares words such as
 * "experiencia" and "empresa", reads as Portuguese, and an English posting
 * that quotes Portuguese early does too. This one counts the words each
 * language does not share with the others, over the whole text, and answers
 * Portuguese only when Portuguese words outnumber both the English ones and
 * those of every other language together.
 *
 * Every word is written lowercase and unaccented, as `words()` reads the text.
 */

/** Portuguese words that Spanish, French, Italian, German and English do not use. */
const PT = new Set([
  'voce', 'voces', 'nao', 'sao', 'com', 'uma', 'um', 'umas', 'uns', 'ao', 'aos', 'na', 'nas', 'em',
  'seu', 'seus', 'suas', 'nosso', 'nossa', 'nossos', 'nossas', 'pelo', 'pela', 'pelos', 'pelas',
  'muito', 'muita', 'tambem', 'isso', 'esse', 'essa', 'esses', 'essas', 'sera', 'voltado',
  'trabalho', 'trabalhar', 'trabalhou', 'vaga', 'vagas', 'conhecimento', 'conhecimentos',
  'desenvolvimento', 'desenvolvedor', 'desenvolvedora', 'oferecemos', 'envie', 'atuacao', 'atuar',
  'contratacao', 'seletivo', 'fazer', 'esperamos', 'buscando', 'ate', 'horario', 'saude', 'diferencial',
])

/** English words that Portuguese does not use either. */
const EN = new Set([
  'the', 'and', 'of', 'to', 'with', 'you', 'we', 'our', 'your', 'is', 'are', 'will', 'for', 'this',
  'that', 'be', 'have', 'has', 'from', 'who', 'what', 'an', 'or', 'at', 'on', 'it', 'if', 'they',
  'team', 'role', 'experience', 'work', 'about', 'join', 'looking', 'apply', 'skills', 'offer',
])

/** Words of the other languages a posting may be in, none of them Portuguese or English. */
const OTHER = new Set([
  // Spanish
  'el', 'los', 'las', 'y', 'del', 'con', 'una', 'es', 'su', 'sus', 'nuestro', 'nuestra', 'usted',
  'muy', 'tambien', 'pero', 'trabajo', 'puesto', 'equipo', 'desarrollo', 'ofrecemos', 'tu', 'lo',
  // French
  'le', 'la', 'les', 'et', 'des', 'du', 'une', 'vous', 'nous', 'avec', 'pour', 'sur', 'dans', 'notre',
  'votre', 'est', 'ce', 'aux', 'qui', 'offre',
  // Italian
  'il', 'di', 'che', 'della', 'delle', 'nel', 'sono', 'lavoro',
  // German
  'der', 'die', 'und', 'mit', 'wir', 'sie', 'ist', 'ein', 'eine', 'zu', 'von', 'bei', 'auf', 'den',
  'dem', 'ihre', 'unser', 'fur', 'nicht', 'sind', 'auch', 'dich',
])

/** A link, an address or a dotted name such as "acme.com": its parts are no
 *  language's words, and ".com" would read as the Portuguese "com". */
const DOTTED = /\S*[a-z0-9]\.[a-z]\S*|\S+@\S+/gi

function words(text: string): string[] {
  return text
    .replace(DOTTED, ' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/)
    .filter((w) => w !== '')
}

export function postingLanguage(text: string): EmailLanguage {
  let pt = 0
  let en = 0
  let other = 0
  for (const w of words(text)) {
    if (PT.has(w)) pt++
    else if (EN.has(w)) en++
    else if (OTHER.has(w)) other++
  }
  return pt >= 2 && pt > en && pt > other ? 'pt' : 'en'
}
