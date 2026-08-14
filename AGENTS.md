# AGENTS.md

Instructions for AI coding agents working on this repository. Claude Code reads this via `.claude/CLAUDE.md`, which imports it; Copilot's coding agent and other tools read it directly.

Keep this file to rules that must apply **before** anything is read — the ones that fail silently. Reference material and procedures live in the skills listed at the bottom.

## What this is

A documentation-only site covering NGINX on Kubernetes: a landing page for the ecosystem plus an interactive migration tool. No build system, no tests, no package manager. Static HTML with CSS/JS in `assets/`, no CDN or third-party runtime dependencies. Owned by F5, Inc., Apache 2.0.

It covers four things: **NGINX Ingress Controller** (`nginx/kubernetes-ingress`), **NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`), the **NGINX Ingress Migration Tool** (community `kubernetes/ingress-nginx` → NIC), and **ingress2gateway** (`kubernetes-sigs/ingress2gateway`).

- `index.html` — the live landing page, a hub linking to all four. Markup only; styles in `assets/css/{shared,index}.css`, behavior in `assets/js/{shared,index}.js`.
- `ingress-nginx-migration.html` — the live migration tool: YAML analyzer, 130+ annotation mappings, CRD examples, ConfigMap guidance.
- Repo `nginx/kubernetes.nginx.org`; GitHub Pages serves `main` at https://kubernetes.nginx.org/.

## Directory layout

```
assets/
  css/  tokens.css        # THE design surface: every colour, size, space, radius, shadow, duration. No selectors.
        shared.css        # @font-face, reset, chrome (topbar/sidebar/banner), components both pages use
        index.css         # landing page only (hero, feature/project grids, compat tables, CTAs)
        migration.css     # migration tool (analyzer UI, mapping/reference tables, badges, checklist, print)
  js/   shared.js         # chrome behavior: dark-mode toggle, sidebar drawer, copy-to-clipboard, copyright year
        index.js          # version auto-fetch, SPA product switching, entrance animation, YouTube
        migration-core.js           # source-agnostic engine: analyzer orchestration/rendering, filtering, nav, checklist; defines window.MigrationTool (NIC target versions + utils)
        migration-ingress-nginx.js  # ingress-nginx SOURCE module: INGRESS_NGINX_VERSION, ANNOTATION_MAPPINGS, parsers, CRD generators, presets; defines window.MIGRATION_SOURCE
  img/  icon.svg, icon-512.png, apple-touch-icon.{svg,png}, og-image.{svg,png}
  fonts/ InterVariable-subset.woff2, OFL.txt, README.md
```

## Load order and asset invariants

These fail silently — nothing errors, the page just renders wrong.

- **CSS order on every page: `tokens.css` → `shared.css` → the page CSS.**
- **`shared.js` before the page JS.** Page scripts are IIFEs calling shared.js globals like `closeSidebar` / `copyToClipboard`.
- **Migration pages load three scripts in this order: `shared.js` → `migration-<source>.js` → `migration-core.js`.** The source module must precede the core, because the core reads `window.MIGRATION_SOURCE` at top level. Source modules never touch the DOM and may dereference `MigrationTool.*` only inside function bodies, never at top level.
- **Asset paths are relative** (`assets/css/…`, no leading `/`) so they resolve identically locally, in PR previews and in production.
- **Every page carries `<link rel="preload" as="font" … crossorigin>` for the woff2 *before* the stylesheet links.** The `@font-face` lives inside `shared.css`, so without the preload the font is not discoverable until that CSS has parsed.
- The inline `<head>` dark-mode flash-prevention script and the page-specific JSON-LD stay inline. Classic (non-module) scripts keep functions global.
- The font is **self-hosted, never a CDN** — see `assets/fonts/README.md` before upgrading or re-subsetting it.

## Shared chrome

The chrome lives in `assets/css/shared.css` and `assets/js/shared.js` as the single source of truth — **edit it once there**, not per page. Its values all come from `tokens.css`; `shared.css` writes no literals. It covers the event banner, the top bar, the sidebar and its drawer, and the dark-mode token overrides plus toggle.

- **The topbar/sidebar/banner markup is duplicated in both HTML pages and must stay structurally in sync** — the shared CSS/JS keys off `#sidebar`, `#sidebarBackdrop`, `#menuToggle`, `#darkToggle`, `.topbar`, `.event-banner`, `#copyright-year`, `#page-announce`.
- **Top bar**: `--topbar-h` 52px. Logo left-aligned at the start of the bar, then a short centred rule (`.topbar-brand::after`, 32px tall) rather than a full-height border, then the heading; GitHub link and dark-mode toggle at the right. The heading is **one line, and which line depends on width** — above 900px `.topbar-eyebrow` carries the site/tool label and `.mobile-breadcrumb` is hidden; at or below 900px they swap, because the drawer hides the sidebar's active-item marker. `index.js` and `migration-core.js` both keep `.mobile-breadcrumb` in step with the active view, so renaming it means touching both.
- **Tried and reverted, don't re-propose**: pinning the branding block to `--sidebar-w` with the logo centred inside it (spends 264px on a 99px logo, and a label like "Networking for Kubernetes" truncated when it sat inside); a `.topbar::after` bottom rule starting at `--sidebar-w`; a stacked eyebrow-over-title heading; a 64px bar.
- **Page-scoped exception — dark-mode content link colours.** These (`a:link`, `a:visited`) must be scoped to the content area (`.page-body` in `index.css`, `.main-inner` in `migration.css`) and stay in the **per-page** CSS. Never in `shared.css`, never global, or they override the topbar/sidebar link colours.

## Design system: the hard rules

The site follows the **F5 Design System (F5DS)**, the system behind the F5 Distributed Cloud console. Never blend it with the F5 **marketing** brand (`f5-brand-core`) — a value correct in one is a defect in the other, and `check-tokens.py` fails on the retired marketing hexes by name.

**`assets/css/tokens.css` is the reference for every value and every measured ratio.** Read it before choosing a colour.

- **Never write a raw value at a call site** — including inline `style=` attributes and JS-generated `cssText`, both of which exist in the migration tool and are easy to miss.
- **Spacing**: base 8, every value a multiple of 4. **12px is not in the system** — resolve to 8 or 16 by context, never to itself.
- **Radius**: `--radius` 4px for everything. `--radius-small` 2px **only when genuinely too small for 4px** — the 3px nav rail, the 16px tick box; not a 20px button. `--radius-pill` for Tags and Badges only.
- **Type**: sizes only through `--fs-*`/`--lh-*`. F5DS pairs a fixed leading with each size, so `line-height` is a length, not a multiplier: **any rule that sets `font-size` must restate the paired `--lh-*`.** Weights 400/500/700 only. **Zero `letter-spacing` declarations anywhere.**
- **Elevation**: `--elev-*` only. Cards are border-only at rest, and there is no hover lift.
- **A status hue is never used as text**, and colour is never the only signal: a status dot always ships with its text label, an info box always with its sentiment icon.
- **Filled green buttons use `--green-dark`**, not `--green` — white on `#009639` is 3.87:1.
- **CRD badges use F5DS's graph palette**, not the sentiment hues.

**Documented deviations — do not "fix" these.** Each has a reason, in the `f5ds-design` skill: NGINX green leads rather than Dodger Blue; the hexagon lattice in the landing hero; no hover lift; the authored dark theme; two button vocabularies (`.cta*` and `.btn*`); `--mono` = SF Mono; the VS Code code palette and its neutral `#1E1E1E` surface; inline code as a borderless wash; the 900/600px breakpoints and all max-widths; 48px content gutters; `min-height: 44px` on mobile controls; `border-radius: 50%` on dots and spinners; hover scale on the checklist marker and scroll-to-top.

## Checks

Four scripts, no dependencies. Run all four after any change, **each on its own line**.

```bash
python3 .github/scripts/check-tokens.py     # token invariants + retired marketing colours + undefined var()
python3 .github/scripts/check-contrast.py   # every colour pairing against WCAG 2.1 AA, both themes
python3 .github/scripts/check-classes.py    # every class used by markup or JS resolves to a CSS rule
node    .github/scripts/test-analyzer.js    # the migration analyzer, under a DOM stub
```

Why one per line: a mistyped shell construct reports "clean" for a check that never ran, which has now happened four times — a `$F` that expanded to one filename, broken `grep -c` arithmetic, a zsh glob swallowing `--include`, and a `for c in "python3 …"; do $c; done` loop where zsh treated each whole string as one command name and printed `exit=0` four times having run nothing. If you must capture status through a pipe, zsh is `${pipestatus[1]}`, not `$?`.

Four things to know about them:

1. **None of the four can see the rendered page.** Every one is a static reader, so the entire class of visual defect — a stretched grid, a collapsed flex item, a truncated label, a card wrapping 3+1 — passes all four green. A clean run means "nothing is structurally broken", not "it looks right". Render and look.
2. **`check-contrast.py` only asserts the pairings listed inside it.** A new coloured surface is unchecked until someone adds it; that is how the badge palette drifted.
3. **`check-classes.py` matters most after a restyle.** A class that loses its rule does not error — the element just renders unstyled, which is invisible on a page with thousands of rows. It reports unused classes too but never fails on them: there is dormant-by-design CSS here (the event banner, the built-but-unlinked blogs/videos sections). Run `git log -S` before deleting anything on that list.
4. **They live under `.github/` because Pages publishes this branch verbatim.** `.nojekyll` disables Jekyll processing but excludes nothing, so a top-level `scripts/` was being served (`/scripts/check-tokens.py` returned 200). Dot-directories 404. Each script derives `ROOT` three levels up from `__file__`, so moving them means fixing that.

## Migration tool: the one rule that cannot wait

**The analyzer's mappings and the static reference tables must agree in both directions.** Editing a mapping or generator means updating the matching reference row *and* the example YAML in its expanded panel; editing a reference row whose construct the analyzer handles means updating the mapping. The generator is the source of truth — a hand-written example drifting from its still-correct generator is the recurring bug here.

Everything else about the tool — ordering rules, collapsed-cell conventions, how to test a generator with no build system, the accuracy checklist — is in the `migration-tool` skill.

## Domain concepts

- **Annotation prefixes**: community `nginx.ingress.kubernetes.io/`; NIC `nginx.org/` (OSS) or `nginx.com/` (Plus).
- **CRDs**: NIC supports VirtualServer, VirtualServerRoute, Policy, TransportServer, GlobalConfiguration.
- **NGINX Plus**: only NIC has Plus features (JWT, OIDC, WAF).
- **Gateway API**: the standard Kubernetes traffic-management API; NGINX Gateway Fabric is the NGINX implementation.
- **Naming**: "NGINX Ingress Controller" — never "Official NGINX Ingress Controller" or "NGINX Inc.". The other one is "the community controller" or `kubernetes/ingress-nginx`.

## Research resources

Prefer GitHub MCP tools over WebFetch for these.

**Community controller** (`kubernetes/ingress-nginx`)

- GitHub: https://github.com/kubernetes/ingress-nginx
- Annotations: https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/nginx-configuration/annotations.md
- Docs site: https://kubernetes.github.io/ingress-nginx — published annotations at `/user-guide/nginx-configuration/annotations/`

**NGINX Ingress Controller** (`nginx/kubernetes-ingress`)

- GitHub: https://github.com/nginx/kubernetes-ingress — docs tree at `docs/content`, CRD types at `pkg/apis/configuration/v1/types.go`
- Annotations: https://github.com/nginx/documentation/blob/main/content/nic/configuration/ingress-resources/advanced-configuration-with-annotations.md
- Docs site: https://docs.nginx.com/nginx-ingress-controller/ — published annotations at `/configuration/ingress-resources/advanced-configuration-with-annotations/`, and the VirtualServer/VirtualServerRoute, Policy, TransportServer and GlobalConfiguration resource pages under `/configuration/`
- Migration guide: https://docs.nginx.com/nginx-ingress-controller/install/migrate-ingress-nginx

**NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`)

- GitHub: https://github.com/nginx/nginx-gateway-fabric
- Docs site: https://docs.nginx.com/nginx-gateway-fabric/

**ingress2gateway**: https://github.com/kubernetes-sigs/ingress2gateway

## Deeper references

These are Claude Code skills, but they are plain markdown — any agent can read them directly.

- **`.claude/skills/f5ds-design/SKILL.md`** — why the design decisions are what they are: the accent split, the three F5DS pairings that fail WCAG AA and their replacements, the badge graph palette, the full type scale, and every deviation with its justification. Read before changing a design value or "fixing" a deviation.
- **`.claude/skills/migration-tool/SKILL.md`** — authoring and verifying the migration tool: the engine split, row ordering and cell conventions, the Node verification recipe and its silent-failure gotcha, and the four-point accuracy check.
- **`.claude/skills/release-update/SKILL.md`** — the checklist for an NIC or NGF release, including the compatibility table and Kubernetes-version rules that are the steps most often missed.
