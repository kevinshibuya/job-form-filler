# Gupy: does a step page give a route to the Job posting's own page?

Ticket #108, spec #98. Checked 2026-11-23 against one real application on one
Gupy tenant. The raw pages stay in the maintainer's private notes. Here, ids
are `<application id>`, `<step id>` and `<job id>`, the tenant is `acme`, and
the Company is Acme.

Route to the posting: none

## The pages

- The step page: `https://acme.gupy.io/candidates/applications/<application id>/steps/<step id>/curriculum`,
  the step this application sits at, saved signed in from Chrome twice: as
  served ("Webpage, HTML Only") and as rendered ("Webpage, Complete"). The
  rendered page greets the applicant, says "Você está se candidatando para a
  vaga <job title> na empresa Acme.", and has a "Continuar" button. It holds no
  form and no Control.
- The posting page: `https://acme.gupy.io/jobs/<job id>`, fetched with a plain
  request, with no cookies and no scripts run. It is the only posting on the
  tenant with the job title the step page names.
- The application dashboard, `https://acme.gupy.io/candidates/applications/<application id>`,
  redirects to the step page while the application is at this step.

## The four answers

- **Address: no.** The step page's address carries an application id and a
  step id. The posting's address needs the job id, and the step address does
  not hold it. Lever's rule works because its apply address holds the posting
  id. Gupy's step address does not.
- **Link: no.** The rendered step page has no link to `/jobs/<job id>`. Every
  link on it is the account menu, the help pages, the legal pages or the
  page's own address. The job title and the Company are plain text.
- **Page data: no.** The served step page is an empty app shell: one empty
  root element, scripts, fonts and a cookie banner. It holds no page data and
  no job id. The rendered page holds none of the tenant's posting ids either.
  Neither do the files Chrome saved beside it.
- So the answer is **none**.

## The link Gupy does show, on another page

Gupy's app script has the message "Acompanhe abaixo o andamento de cada etapa
do seu processo seletivo. Caso queira consultar a descrição da vaga, clique
aqui", with "clique aqui" a link to `/jobs/<job id>?jobBoardSource=gupy_opportunities`.
The script renders it on the application dashboard, not on a step page. No
step screen in the script builds a link to the posting. The dashboard gives
the rule no route either:

- The page script on a step page cannot see it.
- It is signed in, and the posting read sends no cookies.
- Fetched without scripts, it is the same empty app shell as the step page.
- While the application is at a step, it redirects to that step.

## Whether the posting page serves its text without scripts

Yes. Every one of the tenant's five public postings serves its text in the
HTML, 4,200 to 5,500 visible characters inside `<main>`, in sections marked
`data-testid="text-section"`. The text is also in the page's data under the
job's description fields. The posting fixture is cut from the served file, and
`extension/src/content/gupyPosting.test.ts` reads its text with no script run.
A route to this page would therefore be usable. There is just no route.

## What this means for the tool

- Gupy gets no ATS module and no Job posting page rule.
- On a Gupy step page the page script reads no Job posting text. The step
  fixture holds no posting, and the test shows it.
- The link box is Gupy's answer: the user pastes the posting's address, and
  the posting page serves its text without scripts, so the link box can read it.

## Limits of this check

- One application, one tenant, one step (`curriculum`). Gupy's script has
  other step screens (`form`, `questions`, `test`, `video-interview` and
  others). The script reading above found no posting link in any of them, but
  only the curriculum step was saved as a page. Reaching the question step
  would have meant clicking "Continuar" on a live application.
- The fixtures: `e2e/fixtures/steps/gupy-step.html`, cut with
  `sanitize-capture.mjs --page`, and `e2e/fixtures/postings/gupy-posting.html`,
  cut with `--posting`.
