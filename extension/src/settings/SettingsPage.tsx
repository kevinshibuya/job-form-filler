import { useEffect, useState, type ReactNode } from 'react'
import { MailWizard } from './MailWizard'
import { HAIRLINE, MUTED, NAV_GROUND, PAGE_GROUND } from './look'

/** A 16px line icon, as the reference's nav items carry. */
function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
      <path d="M2.25 4.25 8 8.75l5.75-4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface Section {
  /** The section's anchor: `#mail` opens it. */
  id: string
  label: string
  icon: ReactNode
  content: () => ReactNode
}

/**
 * The page's sections, in nav order. Spec #66 adds Mail; specs B and C add
 * theirs here, and the nav, the breadcrumb and the anchor follow.
 */
const SECTIONS: readonly Section[] = [
  { id: 'mail', label: 'Mail', icon: <MailIcon />, content: () => <MailWizard /> },
]

const sectionFromHash = (): Section =>
  SECTIONS.find((s) => `#${s.id}` === location.hash) ?? SECTIONS[0]!

/**
 * The extension's settings page, in a full tab. Its layout is transcribed in
 * `docs/design/settings-page-anatomy.md`: a nav column with a hairline at its
 * right, a top bar holding the breadcrumb, and one centred column for the
 * current section.
 */
export function SettingsPage() {
  const [current, setCurrent] = useState<Section>(sectionFromHash)

  useEffect(() => {
    const onHash = (): void => setCurrent(sectionFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => { document.title = `${current.label} · Settings · job-form-filler` }, [current])

  return (
    <div className={`flex min-h-screen ${PAGE_GROUND}`} data-jff-settings-root="1">
      <aside className={`w-60 shrink-0 border-0 border-r border-solid ${HAIRLINE} ${NAV_GROUND} px-2 py-3`}>
        <nav aria-label="Settings sections">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {SECTIONS.map((s) => {
              const on = s.id === current.id
              return (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`} aria-current={on ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] no-underline ${
                      on ? 'bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100' : `${MUTED} hover:text-neutral-900 dark:hover:text-neutral-100`}`}
                  >
                    {s.icon}
                    {s.label}
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={`flex h-16 shrink-0 items-center border-0 border-b border-solid ${HAIRLINE} px-7`}>
          <nav aria-label="Breadcrumb" className="text-[15px]">
            <span className={MUTED}>Settings</span>
            <span className={`mx-2 ${MUTED}`} aria-hidden="true">/</span>
            <span aria-current="page">{current.label}</span>
          </nav>
        </header>
        <main className="flex-1 overflow-y-auto px-8 pt-10 pb-16">
          <section aria-label={current.label} className="mx-auto max-w-[850px]">
            {current.content()}
          </section>
        </main>
      </div>
    </div>
  )
}
