# Settings page anatomy

The settings page's layout is transcribed from T3 Code's settings page, read from
seven screenshots of its sections (General, Appearance, Chat, Providers, Browser,
Devices, Projects) taken on 2026-11-18. The screenshots stay outside the repo.
This file records anatomy only: what is there, in measurable terms, and what the
page takes from it. Sizes are CSS pixels at a 1440px-wide window.

The spine is the General section, the plainest one: a nav column, a top bar and
one centred column of grouped rows. The other six are read for the parts General
lacks, and each part taken from them is named below as a graft.

## Inventory

| Slot | Record |
| --- | --- |
| Frame | Two columns, full height. A nav column about 240px wide on the left, the content on the right. A 1px vertical hairline divides them. The nav column's ground is one step lighter than the content's in the dark scheme. |
| Nav column, top | A search field with a magnifier icon, the placeholder "Search" and a `/` key hint, full column width. |
| Nav items | One row per section: a 16px line icon, then the section name in regular weight, about 15px. Rows are about 36px tall, 8px apart, inset 8px from the column's edges. No chevrons, no counts, no badges. |
| Nav, current item | The current section's row has a filled rounded rectangle behind it, about 8px radius, one step lighter than the column, and its label goes from muted to full contrast. No accent colour and no side rule mark it. |
| Nav groups | After the first run of items, groups start with a small muted label ("Agents", "Code", "Connections"), about 13px, no caps, no rule above it. |
| Nav column, bottom | An avatar for the signed-in user. |
| Top bar | A breadcrumb, "Settings / <Section>": "Settings" muted, a muted slash, the section name at full contrast, about 15px. About 64px tall, with a 1px hairline under it across the whole content column. Right cluster, in order: an optional text action with an icon ("Restore device defaults", General only), then a close ✕. No CTA button. |
| Scope bar | On Providers, Browser, Devices and Projects only: a muted sentence, "Applying settings for", with two outline dropdown buttons inline. |
| Content column | One column, about 850px wide, centred in the content area with large side margins. It scrolls under the top bar. |
| Section title | A heading above each group, about 17px, semibold, sentence case, outside the group, aligned with the rows' text and not with the group's border. About 40px above it, 16px below. |
| Section title, with actions | On Appearance, Browser and Devices a title row carries actions at its right end: small outline buttons with a leading `+` ("Add theme", "Add source", "Add profile"). |
| Intro line | On Projects one muted sentence sits above the list in place of a section title ("Choose a project to manage …"). |
| Group | A rounded rectangle, about 12px radius, with a 1px border and a ground one step off the page's. Rows inside are divided by 1px hairlines that run the group's full width. No shadow. |
| Row | Left: a title, about 15px, medium weight, full contrast, then one or two lines of muted description, about 13px, measure up to about 90 characters. Right: one control, vertically centred: a switch, an outline dropdown, or an outline text field. Padding about 16px by 20px. |
| Row, nested list | On Browser one row holds an inner bordered list ("Default", a named profile) with its own hairlines, inset 20px, each inner row with its value at the left and a small icon action at the right. |
| Row, collapsed extra | A last row "› Advanced" in muted text, a chevron and a label, that opens more rows. |
| Two-pane group | On Providers a group splits into a list on the left and the chosen item's rows on the right. |
| Shape vocabulary | Rounded rectangles at two sizes: the group, about 12px radius, and the controls and the current nav item, about 8px. Switches are full pills. Everything else is square-edged text on hairlines. |
| Colour roles | Ground: near-black for content, one step lighter for the nav column and the groups. Text: white for titles and the current nav item, grey for descriptions, nav items and the breadcrumb's first part. Borders and hairlines: dark grey. Accent: one blue, only on a switch that is on and on a selected tile's outline (Appearance). Data colours (theme swatches, project initials) appear only as content, never as UI surface. A light scheme exists with the same roles. |
| Monospace | Version numbers on Providers ("v0.170.0") and file paths in fields are set in a monospace face. |
| Density | General shows three sections and eight rows in one screen. Devices shows two groups of three rows and leaves the lower half of the page empty. |

## Absence list

Not in any of the seven, and so not in the page:

- No eyebrow or kicker above a section title, no badge or pill beside one, except
  the one "Default" tag on Browser's inner list.
- No icons beside rows. Icons appear only in the nav column and in the Providers list.
- No drop shadows, no gradients, no accent rule on a group's edge.
- No stat strip, no counts in the nav, no progress bar.
- No primary filled button anywhere. Every action is an outline button or a text action.
- No card grid, except Appearance's tiles, which hold pictures.
- No footer.

## What the page takes

The page has one section in this spec, Mail. Every part of it traces to a row
above, to the Onboarding view, or to the ticket.

| Page part | Traces to |
| --- | --- |
| Two columns, nav column on the left with a hairline, content on the right | Frame |
| Nav column holds one item, Mail, with a line icon, drawn current | Nav items, Nav current item |
| The nav list is built from a list of sections, so specs B and C add theirs as items | Nav items, Nav groups (the ticket asks for room) |
| Top bar with the breadcrumb "Settings / Mail" and the hairline under it | Top bar |
| Content column about 850px wide, centred | Content column |
| The wizard's intro, one muted sentence under a heading | Intro line, and the Onboarding view's heading and muted line |
| Section title "Create your Google client" with nothing at its right | Section title |
| One group per step, a step's title and its text on the left, its controls on the right | Group, Row (the ticket asks for one card per step) |
| The done mark as a switch at the right end of the step's title row | Row (a switch is the reference's on/off control), accent blue only when on |
| "Open in Google Cloud" as an outline button beside the switch | Row's right-hand control, outline geometry |
| The values to paste as an inner bordered list, each value in monospace with a Copy text action at its right | Row nested list, Monospace |
| "Done when" as a muted line under a step's text | Row description |
| The Project ID box in step 1 as an outline text field | Row's outline text field |
| Light and dark schemes from the system setting | Colour roles |

Cut, because the page has nothing for it to do yet:

- The search field and its `/` hint: one section needs no search.
- The nav group labels: one item has no group. Specs B and C add labels when they add groups.
- The avatar: the page has no signed-in user to show.
- The close ✕: the page is a browser tab, and the tab closes it.
- "Restore device defaults", the scope bar, title-row actions, the "Advanced" row
  and the two-pane group: no setting here has a default, a scope, an add action,
  extra rows or a list to choose from.
