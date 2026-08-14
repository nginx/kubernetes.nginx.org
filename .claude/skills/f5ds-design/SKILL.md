---
name: f5ds-design
description: The reasoning behind this site's F5 Design System implementation — why NGINX green leads instead of Dodger Blue, which three published F5DS pairings fail WCAG AA and what replaced them, why the CRD badges use the graph palette, the full type scale, and every documented deviation with its justification. Use when editing any CSS under assets/css/, choosing or changing a colour/space/radius/type value, judging whether something is an intentional deviation or a defect, or when a design-system scanner flags this site.
---

# F5DS on kubernetes.nginx.org — the why

The hard constraints are in `AGENTS.md` and apply whether or not this skill is loaded. This file is the reasoning behind them: read it before changing a design decision, and before "fixing" anything in the deviations table below.

`assets/css/tokens.css` is the authoritative reference. Every token there carries its rationale and its measured contrast ratio in a comment. When this file and `tokens.css` disagree, `tokens.css` is right.

## What the site follows

The **F5 Design System (F5DS)** — the design system behind the F5 Distributed Cloud console. All of it: colour, spacing, radius, elevation, motion and type. Check values against F5's own design-system documentation; this file and `tokens.css` record what was taken from it and why.

The site previously ran F5DS typography over the F5 **marketing** palette. That split is gone. Do not reintroduce it: the F5 **marketing** brand system (Neusa Next Pro Wide / Proxima Nova, F5 Red, the Brand Center ramps) is a different standard, and a value that is correct in one is a defect in the other. `check-tokens.py` fails on the retired marketing hexes by name.

## Accents, and why green leads

F5DS's platform primary is Dodger Blue `#4F73FF`. This site leads with **NGINX green `#009639`**, which is not a deviation from what F5 ships: in the F5XC console the NGINX One workspace marks its active navigation item in green and uses a green primary button, while platform-level pages in the same console use Dodger Blue. This is an NGINX community site inside an F5 portfolio, so it follows that same split.

- **NGINX green** — the lead accent: active nav item, primary buttons, section rails, the "new side" of a comparison.
- **Dodger Blue** — platform and tooling: content links, focus rings, the two Kubernetes tools. It replaced Kubernetes brand blue `#326CE5` — same job, F5's hue rather than the CNCF one.
- **F5 Brand Red `#E4002B` is absent entirely.** F5DS restricts it to logo, illustrations and pictograms and forbids it as a CTA, link, accent or error colour. Negative sentiment is Pomegranate.

## The whole F5DS colour inventory is available, not just the sentiment set

This is the most useful thing in this file, so it comes first.

F5DS's *default* palette — Dodger Blue plus the four sentiment hues and Java — is small, and it is tuned for sentiment rather than for telling N things apart. A documentation surface needs more than that: category badges, code syntax, comparison sides. **The rest of the shipped palette is fair game for any of it.**

What F5DS actually ships, all quotable:

| Group | Count | Notes |
|---|---|---|
| Primary — Dodger Blue | 3 | base, hover `#2E50D9`, light `#DBE2FF` |
| Brand `#E4002B` | 1 | **restricted**: logo, illustrations, pictograms only. Never a CTA, link, accent or error colour. |
| AI Assist | 2 | `#1152B2` / `#003E99` |
| Neutrals N0–N700 | 8 | |
| Status | 5 | Emerald, Amber, Pomegranate, Medium Purple, Java, each with hover and light |
| **Shades & Tints** | **50** | named paint colours; the graph-series extension set |
| **Visualizations** | **5** | Atlantis, Chetwode Blue, Gigas, Lavender Magenta, Red Violet |

The bottom two rows are the ones people forget, and they are where a docs site should look first when it needs a colour that means "a different category" rather than "a sentiment". Using them is not a deviation — it is using the system as published.

**Two rules when reaching into them:**

1. **Stay inside F5DS's hues.** Pick a published colour, do not invent one.
2. **Derive lightness, and measure.** A published value missing the contrast bar on its own tint does not make the hue unusable — it makes that *value* unusable. Deepen or lighten along the same hue and record the measured ratio, exactly as `--n550`, `--n450` and `--blue-text` already do. Elm `#28837E` on Light Cyan is 4.01:1 and fails; deepened along its own 176.7° hue to `#1D5E5A` it is 6.64:1 and passes. Label derived values as derived so the next reader knows which are quotable as F5DS.

The same applies anywhere a colour is needed, not only badges.

## How the CRD badges use it

Eight badge kinds, and the five text-safe sentiment hues could not carry that. They ran out after five, so the sixth and seventh were separated by *treatment* instead of hue — which is how VirtualServerRoute became an unfilled pill that read as a button — and the hues meant the wrong thing besides: Policy in the Informative purple said nothing informative, NGINX Plus in a status red said error.

The badges use **Graph Colors** instead: a shade/tint pair per family, the shade labelling in light mode over the tint fill, the reverse in dark with the fill at 16%. One token per family drives both themes, so no badge needs a dark-mode override and a family cannot drift apart.

**Which family each badge gets is not an aesthetic choice.** Production already ships a badge identity for each of these and readers know them, so the assignment is a translation: take the production hue, give the badge the graph family nearest it on the hue circle. Production lands within 5° of a family for five of the eight. `tokens.css` carries the full hue table, the CIEDE2000 collision analysis behind ConfigMap taking family 2's *inner* tint, and the reasoning for GlobalConfiguration being the neutral — production gives it saturation 0.00, so there is no hue to match.

Teal (family 5) is deliberately unspent rather than unusable: production styles a teal `.badge-annotation` that renders nowhere, so the family is reserved in case that badge is ever wanted. If it is, note that it needs a derived label — see the derivation rule above.

## F5DS publishes no accessibility guidance, and three of its pairings fail AA

`tokens.css` carries a derived token for each, with the measured ratio:

| F5DS value | Measured | Replacement |
|---|---|---|
| N500 secondary text on the N100 page background | 4.25:1 | `--n550` `#677185` — 4.62:1 on N100, 4.91:1 on N0 |
| N400, documented as the icon colour, on white | 2.42:1 | `--n450` `#848FA5` — 3.25:1 on N0, 3.06:1 on N100 |
| White on Dodger Blue `#4F73FF` | 4.02:1 | `--blue-text` `#2E50D9` — 6.43:1 |

Green is the same story: white on `#009639` is 3.87:1, so every filled green button uses `--green-text` `#007D30`.

**Emerald and Amber cannot reach the 3:1 non-text bar at any usable saturation** — 2.02:1 and 1.60:1 on white, and even F5DS's own hover values only manage 2.95:1 and 2.23:1. Two rules follow, and they are F5DS's own (colour must never be the only signal) rather than workarounds:

- A status hue is **never used as text**.
- A status dot never appears without its text label, and an info box never without its sentiment icon.

## Capitalization: two F5 standards collide

F5DS sets case per component, not globally. **Title Case**: buttons, links,
primary navigation, tabs, and panel/modal titles. **Sentence case**:
notifications, tooltips, radio groups, toggles, checkboxes and their legends,
and modal body copy. F5DS's own components reference flags the button rule as
the odd one out — "this is one of the few places the product system does not
use sentence case."

But F5 publishes three standards that contradict each other here, and says so:
marketing uses title-case display headings, **technical documentation uses
sentence case**, and product UI uses Title Case labels. This site is
documentation, so the documentation standard governs everything that reads as
content.

Where that lands in practice:

| Element | Case | Why |
|---|---|---|
| Headings, prose, navigation | sentence | Documentation standard. The sidebar labels are literally the `<h2>`s they link to, so they cannot diverge. |
| Button labels | Title Case | Pure interface, no documentation conflict — `Expand All`, `Load Sample`. |
| Tab labels | Title Case | Same — `CRD Approach`, `Policy + Ingress (Recommended)`. |
| The migration-strategy selector | sentence | It uses `aria-pressed`, so it is a **toggle**, not a tab or a button, and F5DS puts toggles in sentence case. |
| Code identifiers in a label | as written | `CRD responseHeaders` is an API field name; casing it would make it wrong. |

## Spacing, radius, elevation, type — the detail

- **Spacing** (`--space-*`): base 8, every value a multiple of 4. 12px is not in the system — resolve to 8 or 16 by context, never to itself. 2px is used only between a label and its form control. `--space-6x` 48 and `--space-8x` 64 extend past F5DS's published 40px ceiling using its own `Nx = 8N` formula.
- **Radius**: `--radius` 4px for everything, replacing f5.com's 5px. `--radius-small` 2px **only when genuinely too small for 4px** — the 3px nav rail, the 16px tick box, not a 20px button. `--radius-pill` for Tags and Badges only.
- **Elevation**: `--elev-*` only, N700-tinted, never black. **Cards are border-only at rest** — the console does this on its own landing pages, reserving shadow for surfaces that genuinely float.
- **Type scale**: `h1` 36/54, `h2` 24/36, `h3` 18/26, `body-lg` 16/24, `body` 14/20, `caption` 12/18, `badge` 10/16, `code` 14/24. F5DS pairs a **fixed leading with each size** rather than one global ratio, so `line-height` is a length, not a multiplier: any rule that sets `font-size` must restate the paired `--lh-*`. Weights 400/500/700 only — no 300, no 600. The scale specifies no tracking anywhere, so there should be no `letter-spacing` declaration in the CSS at all.
- The font is **self-hosted, never a CDN**. Read `assets/fonts/README.md` before upgrading or re-subsetting it — `→` appears 29 times in the mapping tables and is outside both stock Google `latin` and `latin-ext` ranges.

## Documented deviations, with justifications

Do not let a scanner or a tidying pass "fix" these.

| Deviation | Why |
|---|---|
| **NGINX green leads, not Dodger Blue** | What F5 ships on NGINX-branded console surfaces. See above. |
| **Hexagon lattice in the landing hero** (`--pattern-hex`) | F5DS defines exactly four graphic classes — icons, flags, pictograms, illustrations — and a tiled background texture is none of them. Kept because the lattice is the site's strongest NGINX signal, and the 48px-gutter reasoning applies: F5DS assumes a dense console screen and a community docs front page is not one. Confined to `.page-hero.home`, masked out from behind all copy so no contrast pairing changes, clamped to 10% in dark, hidden below 600px, suppressed in print. |
| **No hover lift** — shadow only, no `translateY` | A page of cards rising at once is a lot of motion for a docs site. F5DS's `Elevate Up` is a Motion-page catalogue entry, not a mandate. |
| **Dark theme** | F5DS publishes none (Early Availability only). Authored here, deepening into the same N-ramp — N700 page, N600 surface — with both accents lightened until they clear 4.5:1 on both. |
| **Two button vocabularies** — `.cta*` and `.btn*` | Given identical geometry in `shared.css` rather than merged, because consolidating means editing markup in two pages for no visual gain. Compose new work onto `.btn`. |
| **`--mono` = SF Mono** (not F5DS's Courier) | Courier is unreadable at code-block sizes; docs.nginx.com deviates identically. Inline `code` also sizes at `0.9em`, relative to its context rather than off the scale. |
| **Code syntax palette** (`--code-key`/`-string`/`-comment`/`-keyword`/`-number`/`-punct`) | F5DS publishes no code palette and no syntax-highlighting guidance at all. VS Code Dark+, as the pre-F5DS design and docs.nginx.com both use, adjusted only where contrast required it (`#808080` → `#8B9099`, since VS Code's own separator grey measures 4.19:1 on `--code-bg`). **Do not "fix" these to status hues** — that was tried and broke two rules at once: status hues carry sentiment rather than token role, and `--emerald`/`--amber` were being rendered as text, which this site forbids. The print block inverts them, because the code surface prints light. |
| **Code surface is neutral `#1E1E1E`, not N700 navy** | Hue proximity between a navy code block and the navy top bar and sidebar hurt readability. This is VS Code Dark+'s own editor background, which the syntax palette was designed against. `--code-border` `#333333` is part of the same exemption. |
| **Inline code is a wash with no border and no colour** | Every hue in this system is spoken for: blue is links, green is the accent, pomegranate reads as error, purple and java read as blue-violet and teal — as links again. And a mapping cell holds up to ten annotation names stacked, where ten outlined boxes turn the cell into a grid. GitHub, Slack and Stack Overflow all render inline code the same way. |
| **900px / 600px breakpoints, and all max-widths** | F5DS publishes no breakpoints and never states its fixed grid's maximum width. |
| **48px content gutters** (not F5DS's 20px page margin) | 20px assumes a dense product screen wrapped in heavy navigation; on a wide docs page it puts prose against the viewport edge. |
| **`min-height: 44px` on mobile controls** | WCAG target size beats F5DS's fixed 32px. |
| **`prefers-reduced-motion` kill switch** | F5DS is silent; an addition, not a deviation. |
| **`border-radius: 50%` on dots and spinners** | A 6px state dot and a spinner cannot take a 4px corner. |
| **Hover scale on the checklist marker and scroll-to-top** | Kept by explicit decision — the checklist marker's scale is that row's only hover feedback. |
| **`--topbar-h` 52px** | F5DS publishes no top-bar height. 52px matches the bar the site already shipped; 64px was tried and read as loose. |

## Inferred, not published

Say so when touching these — F5DS does not specify them: table cell padding (there is **no** table component), info-box internal padding, which elevation level a dropdown gets (only Toast=L1 is stated), and any spacing above 40px.

## What the checks can and cannot see

`check-tokens.py` reads literals, `check-contrast.py` asserts a fixed list of pairings, `check-classes.py` resolves class usage. **None of them can see the rendered page**, and `check-contrast.py` only checks pairings that someone remembered to add — which is how the badge palette drifted for months. After any visual change, render and look.

An automated design-system scanner is **not** a sufficient gate either. Scanners generally cannot resolve `var()`, so a correct `var(--space-2x)` is invisible to them while a literal `16px` counts as on-token — a site that uses tokens properly scores *worse*. Read `tokens.css` instead.
