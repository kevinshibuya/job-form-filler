import { describe, it, expect } from 'vitest'
import { postingLanguage } from './postingLanguage.js'

// Ticket #73: the Application email's language is decided in code from the
// whole Job posting. Portuguese when the posting is in Portuguese, English for
// anything else, a language the Profile does not list included.

const PT = `A Acme está contratando uma pessoa analista de dados para o nosso time em São Paulo.
Você vai trabalhar com as áreas de produto e finanças, construindo relatórios e modelos que ajudam a empresa a tomar decisões.
O que esperamos de você: experiência com SQL e Python, conhecimento de estatística e boa comunicação.
Será um diferencial se você já trabalhou com pagamentos.
Oferecemos vale-refeição, plano de saúde e horário flexível.
Para se candidatar, envie seu currículo e um link para o seu GitHub para o e-mail da vaga.`

const EN = `Acme is hiring a data analyst to join our team in London.
You will work with the product and finance teams, building the reports and models that help the company make decisions.
What we are looking for: experience with SQL and Python, a solid grasp of statistics and clear writing.
It is a plus if you have worked on payments before.
We offer a pension plan, private health cover and flexible hours.
To apply, send your CV and a link to your GitHub to the address below.`

const ES = `Acme busca una persona analista de datos para su equipo en Madrid.
Trabajarás con los equipos de producto y finanzas, construyendo los informes y modelos que ayudan a la empresa a tomar decisiones.
Lo que buscamos: experiencia con SQL y Python, conocimientos de estadística y buena comunicación.
Es un plus si ya has trabajado con pagos.
Ofrecemos seguro médico, horario flexible y un buen ambiente de trabajo.
Para postularte, envía tu currículum y un enlace a tu GitHub a la dirección del puesto.`

const FR = `Acme recrute un analyste de données pour son équipe à Lyon.
Vous travaillerez avec les équipes produit et finance, et vous construirez les rapports et les modèles qui aident l'entreprise à décider.
Ce que nous recherchons : une expérience avec SQL et Python, des connaissances en statistique et une bonne communication.
Une expérience dans les paiements est un plus.
Nous offrons une mutuelle, des horaires flexibles et une équipe sympathique.
Pour postuler, envoyez votre CV et un lien vers votre GitHub à l'adresse de l'offre.`

const DE = `Acme sucht eine Datenanalystin oder einen Datenanalysten für unser Team in Berlin.
Du arbeitest mit den Teams für Produkt und Finanzen und baust die Berichte und Modelle, mit denen das Unternehmen entscheidet.
Was wir suchen: Erfahrung mit SQL und Python, Kenntnisse in Statistik und eine klare Kommunikation.
Erfahrung im Zahlungsverkehr ist ein Plus.
Wir bieten flexible Arbeitszeiten und ein freundliches Team.
Um dich zu bewerben, sende deinen Lebenslauf und einen Link zu deinem GitHub an die Adresse der Stelle.`

describe('postingLanguage', () => {
  it('reads a whole posting in Portuguese as Portuguese', () => {
    expect(postingLanguage(PT)).toBe('pt')
  })

  it('reads a whole posting in English as English', () => {
    expect(postingLanguage(EN)).toBe('en')
  })

  it.each([['Spanish', ES], ['French', FR], ['German', DE]])('reads a posting in %s, a language the Profile does not list, as English', (_name, text) => {
    expect(postingLanguage(text)).toBe('en')
  })

  it('reads an English posting that quotes a Portuguese sentence as English', () => {
    const quoting = `${EN}\nOur São Paulo office motto is "Você faz parte do nosso time desde o primeiro dia." and we mean it.`
    expect(postingLanguage(quoting)).toBe('en')
  })

  it('reads a Portuguese posting with English technical terms as Portuguese', () => {
    const mixed = `${PT}\nStack: React, Node.js, TypeScript, AWS and the usual CI tooling.`
    expect(postingLanguage(mixed)).toBe('pt')
  })

  it('reads empty text, or text with no words, as English', () => {
    expect(postingLanguage('')).toBe('en')
    expect(postingLanguage('  12/2026 — 3.500,00  ')).toBe('en')
  })
})
