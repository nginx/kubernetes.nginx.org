# AGENTS.md

Instructions for AI coding agents. Claude Code reads this via `.claude/CLAUDE.md`, which imports it; Copilot's coding agent and other tools read it directly.

**This file is loaded into every session, so it costs tokens on every task.** It holds only the rules that must apply *before* anything is read — the ones that fail silently. Everything else lives in the skills at the bottom, which load on demand.

## What this is

A documentation-only site covering NGINX on Kubernetes: a landing page plus an interactive migration tool. No build system, no package manager; there *are* checks and a test suite, and CI runs them on every push and PR. Static HTML with CSS/JS in `assets/`, no CDN and no third-party runtime dependencies — two deliberate exceptions, both images and neither of them script: the featured videos load poster images from `i.ytimg.com` and are click-to-play into `youtube-nocookie`, so nothing off-origin runs until a reader asks for it; and the two featured-blog thumbnails hotlink each post's own artwork on `blog.nginx.org`'s CDN rather than vendoring a copy that ages in the repo. Owned by F5, Inc., Apache 2.0.

It covers four things: **NGINX Ingress Controller** (`nginx/kubernetes-ingress`), **NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`), the **NGINX Ingress Migration Tool** (community `kubernetes/ingress-nginx` → NIC), and **ingress2gateway** (`kubernetes-sigs/ingress2gateway`).

- `index.html` — the landing page, a hub linking to all four. Markup only.
- `ingress-nginx-migration.html` — the migration tool: YAML analyzer, 130 annotation mappings, CRD examples, ConfigMap guidance.
- Repo `nginx/kubernetes.nginx.org`; GitHub Pages serves `main` at https://kubernetes.nginx.org/.

**Never touch `CHANGELOG.md` unless explicitly asked.** Its entries are release-shaped and hand-written, and a released section can already be on `main` and serving production — so "helpfully" appending to one revises a shipped record. Make the change, say in your summary that the changelog is untouched, and let the maintainer decide.

## Reading this repo cheaply

Two files here are far too large to read whole: `ingress-nginx-migration.html` is **5,317 lines / ~97k tokens** (its `#mappings` section alone is lines 457–3813) and `assets/js/migration-ingress-nginx.js` is ~29k. Grepping, guessing a range, reading 400 lines and missing costs more than the edit.

**Ask the locator instead. It prints exact line ranges and the `Read` call to make:**

```bash
python3 .github/scripts/where.py rewrite-target     # annotation: mapping + generator + reference row
python3 .github/scripts/where.py '#mappings'        # a section or heading anchor
python3 .github/scripts/where.py .version-pill      # a CSS class, every rule
python3 .github/scripts/where.py --green-text       # a token: value, dark override, where it is used
python3 .github/scripts/where.py --list green       # matching tokens, light and dark, one line each
python3 .github/scripts/where.py filterTable        # a JS function
python3 .github/scripts/where.py rewrite-target -s  # ...and print the lines
```

It **exits 1 when it finds nothing** rather than returning empty, because "no hits" and "not there" must not look alike. `.github/data/mapping-index.json` (generated) maps every annotation to its category, anchor and CRD generator if you want the whole set at once.

Then `Read` with `offset`/`limit`. Resolving one annotation costs ~3.5k tokens this way against ~126k for reading both files whole.

The general habits matter as much as the big files:

- **`wc -c` before reading anything unfamiliar.** Several files here are over 30KB, and `cat`-ing a handful blind is how a session doubles in size.
- **`Edit`, not `Write`, on a file that already exists.** Rewriting a 17KB file to change six lines costs 17KB of output.
- **`grep -c` or `-l`** when you need a count or existence rather than the matching lines.
- **Batch independent commands into one call**, and don't re-read a file already in context.
- **One `check-all.py` per logical change**, not per step.
- **`git log --oneline`.** Bodies here are long by design; ask for them only when you need the reasoning.

## Directory layout

```
assets/
  css/  tokens.css        # THE design surface: every colour, size, space, radius, shadow, duration.
        #                   Declarations only — `:root` and the `@media screen` dark theme.
        shared.css        # @font-face, reset, top bar, sidebar, banner, components both pages use
        index.css         # landing page only
        migration.css     # migration tool
  js/   shared.js         # dark-mode toggle, sidebar drawer, copy-to-clipboard, copyright year
        index.js          # version auto-fetch, SPA product switching, entrance animation, YouTube
        migration-core.js           # source-agnostic engine; defines window.MigrationTool
        migration-ingress-nginx.js  # ingress-nginx SOURCE module; defines window.MIGRATION_SOURCE
  img/  icon.svg, icon-512.png, apple-touch-icon.{svg,png}, og-image.{svg,png}
  fonts/ InterVariable-subset.woff2, OFL.txt, README.md
tools/
  nic-migrate/  # CLI batching the analyzer over real manifests. Reads the engine
                # out of assets/js/ — never vendor a copy. See its README.
```

**`tools/` is not published.** Pages runs the classic Jekyll build on `main`, which skips dot- and underscore-prefixed paths — that is what keeps `.github/` off the site, and it does nothing for a plain top-level directory. `_config.yml` exists solely to exclude `tools/` by name; it restates Jekyll's default `exclude` list because setting the key replaces those defaults rather than extending them.

## Load order and asset invariants

These fail silently — nothing errors, the page just renders wrong.

- **CSS order on every page: `tokens.css` → `shared.css` → the page CSS.**
- **`shared.js` before the page JS.** Page scripts are IIFEs calling shared.js globals like `closeSidebar` / `copyToClipboard`.
- **Migration pages load three scripts in this order: `shared.js` → `migration-<source>.js` → `migration-core.js`.** The source module must precede the core, because the core reads `window.MIGRATION_SOURCE` at top level. Source modules never touch the DOM and may dereference `MigrationTool.*` only inside function bodies, never at top level.
- **Asset paths are relative** (`assets/css/…`, no leading `/`) so they resolve identically from the filesystem, a local server and production. There is no PR preview environment — Pages serves `main` only.
- **Every page carries `<link rel="preload" as="font" … crossorigin>` for the woff2 *before* the stylesheet links.** The `@font-face` lives inside `shared.css`, so without the preload the font is not discoverable until that CSS has parsed.
- The inline `<head>` dark-mode flash-prevention script and the page-specific JSON-LD stay inline. Classic (non-module) scripts keep functions global.
- The font is **self-hosted, never a CDN** — see `assets/fonts/README.md` before upgrading or re-subsetting.

## Shared header, sidebar and banner

Single source of truth is `assets/css/shared.css` and `assets/js/shared.js` — **edit once there**, not per page. Colours, spacing, type and elevation come from `tokens.css`.

- **The topbar/sidebar/banner markup is duplicated in both HTML pages and must stay structurally in sync** — the shared CSS/JS keys off `#sidebar`, `#sidebarBackdrop`, `#menuToggle`, `#darkToggle`, `#mobileBreadcrumb`, `.topbar`, `.event-banner`, `#copyright-year`, `#page-announce`. `check-classes.py` asserts every id `shared.js` queries exists on every page.
- **Page-scoped exception — dark-mode content link colours.** These (`a:link`, `a:visited`) must be scoped to the content area (`.page-body` in `index.css`, `.main-inner` in `migration.css`) and stay in the **per-page** CSS. Never in `shared.css`, never global, or they override the topbar/sidebar link colours.

Geometry, the 900px heading swap, and the layout ideas already tried and reverted are in the `f5ds-design` skill. Read it before re-proposing a top-bar change.

## Design system: the hard rules

The site follows the **F5 Design System (F5DS)**. Never blend it with the F5 **marketing** brand (Neusa Next Pro Wide / Proxima Nova, F5 Red, the Brand Center ramps) — a value correct in one is a defect in the other, and `check-tokens.py` fails on the retired marketing hexes by name.

**`assets/css/tokens.css` is the reference for every value and every measured ratio.** It is 32KB, so prefer `where.py --list <needle>` (the whole inventory is a fifth the size) or `where.py --<token-name>` for one. Read it before choosing a colour — never guess a hex.

- **Never write a raw value at a call site** — including inline `style=` attributes and JS-generated `cssText`, both of which exist in the migration tool and are easy to miss.
- **Spacing**: base 8, every value a multiple of 4. **12px is not in the system** — resolve to 8 or 16 by context, never to itself.
- **Radius**: `--radius` 4px for everything. `--radius-small` 2px **only when genuinely too small for 4px** — the 3px nav rail, the 16px tick box; not a 20px button. `--radius-pill` for Tags and Badges only.
- **Type**: sizes only through `--fs-*`/`--lh-*`. F5DS pairs a fixed leading with each size, so `line-height` is a length, not a multiplier: **any rule that sets `font-size` must restate the paired `--lh-*`.** Weights 400/500/700 only. **Zero `letter-spacing` declarations anywhere.**
- **Elevation**: `--elev-*` only. Cards are border-only at rest, and there is no hover lift.
- **A status hue is never used as text**, and colour is never the only signal: a status dot always ships with its text label, an info box always with its sentiment icon.
- **Filled green buttons use `--green-text`**, not `--green` — white on `#009639` is 3.87:1.
- **CRD badges use F5DS's graph palette**, not the sentiment hues.
- **Capitalization: sentence case, except buttons and tabs.** Headings, prose, navigation and anything that reads as content are sentence case; button and tab labels take Title Case, which is what F5DS specifies for them. A toggle is not a button — F5DS puts toggles in sentence case, which is why the migration strategy selector stays lowercase. Sidebar labels are the `<h2>` headings they link to and match them verbatim, except where a label would clip the 264px rail (see `f5ds-design`).

**This site deviates from F5DS deliberately in about a dozen places — do not "fix" them.** Each is listed with its reason in the `f5ds-design` skill. Check there before calling anything a defect.

## Checks

```bash
python3 .github/scripts/check-all.py        # -v for every check's full output
```

Nine checks, one command, no dependencies. It prints **how many ran**, which is the number that matters, and a missing script or interpreter is a failure rather than a skip.

**Run them when asked, not after every change.** They are not a per-edit ritual: most edits here are prose or markup no check reads, and a nine-check run after each one is noise. The corollary is not optional — **if you have not run them, say so** and do not describe the work as verified. "I have not run the checks" is a complete and acceptable thing to report.

**Never chain the checks on one shell line.** A mistyped construct reports "clean" for a check that never ran; that has happened seven times here, and `$?` after a pipe is `head`'s status, not the script's (zsh: `${pipestatus[1]}`).

**None of the nine can see the rendered page.** A clean run means "nothing is structurally broken", not "it looks right" — the whole class of visual defect passes green. Render and look; the `verify-visually` skill is how.

**A new assertion is not finished until you have watched it fail.** Plant the defect, confirm the check reports it, restore, and write what you planted into the commit body.

The `repo-checks` skill has the rest: what each check asserts, the seven shell failures in detail, why the scripts live under `.github/` (and why adding `.nojekyll` would publish them), and how to add a check.

## Branches, deploying, and undoing

**Pushing to `main` is deploying.** Pages serves this branch; a push is live in roughly a minute, and CI finishes at about the same time, so a red run does not stop a bad commit reaching production. Verify before you push, not after.

- Commit on the branch you are on. Do not create one unless asked.
- `preview/**` branches carry additional migration tools on the same engine. **`main` owns the shared engine and the checks** — `assets/js/shared.js`, `assets/js/migration-core.js`, `.github/scripts/`, `.github/test/` and this file. A branch behind `main` on those is graded by its own older checks, so CI warns about it. Merge `main` into the branch rather than porting fixes across.
- To undo something on `main`: `git revert <sha>` and push. **Never** `push --force`, `reset --hard` or `clean` on a pushed branch — the deployed history is the record.

Agent permissions, hooks and MCP servers are deliberately **not** checked in: they are a property of whoever is working, not of the project. Nothing here runs the checks automatically, and that is on purpose — a hook that fires at the end of every turn runs the full suite whether or not anyone asked, which costs more time and context than it catches. The obligation above stands in its place: run them when asked, and if you have not, say so.

## Migration tool: the one rule that cannot wait

**The analyzer's mappings and the static reference tables must agree in both directions.** Editing a mapping or generator means updating the matching reference row *and* the example YAML in its expanded panel; editing a reference row whose construct the analyzer handles means updating the mapping. The generator is the source of truth — a hand-written example drifting from its still-correct generator is the recurring bug here. `where.py <annotation>` returns all three at once, which is the point.

Everything else — ordering rules, collapsed-cell conventions, how to test a generator with no build system, the accuracy checklist — is in the `migration-tool` skill.

## Where the reasoning is written down

The commit bodies are the largest body of decision-making here — what was tried, what was rejected, how it was verified. Before re-proposing something or deleting something that looks dead:

```bash
git log --grep='Considered and rejected'   # ideas already weighed and dropped
git log -S'<name>'                         # why a class, token or function exists
```

Write commits the same way: what changed, why, what was rejected, how it was verified.

**Keep it proportionate.** The whole history holds ~4,000 words; a body over ~15
lines is almost always padding. Record the fault you planted and the decision you
rejected, not a narrative of the work. The same goes for what you report back:
answer in a few lines, skip tables and headings for small results, and do not
re-verify what you have already verified.

## Performance budget

Numbers to stay near, not a hard gate. Migration page: **789KB uncompressed** (HTML 333, CSS 128, JS 218, font 110), **4,860 elements**, 130 mapping rows. Content grows this page; if a change moves any of these appreciably, say so.

One invariant behind that: `filterTable` caches row text in a `WeakMap` and is debounced. It used to call `row.textContent.toLowerCase()` on every row on every keystroke, re-serialising 75 row subtrees per character. Do not undo that.

## Spelling

British in agent-facing prose and code comments (`colour`, `behaviour`) — including in `tokens.css` comments, which are served to every visitor. American in user-facing page copy. CSS property names are `color` regardless. If a style tool proposes normalising these, it is out of scope.

## Domain concepts

- **Annotation prefixes**: community `nginx.ingress.kubernetes.io/`; NIC `nginx.org/` (OSS) or `nginx.com/` (Plus).
- **CRDs**: NIC supports VirtualServer, VirtualServerRoute, Policy, TransportServer, GlobalConfiguration.
- **NGINX Plus**: only NIC has Plus features (JWT, OIDC, WAF).
- **Gateway API**: the standard Kubernetes traffic-management API; NGINX Gateway Fabric is the NGINX implementation.
- **Naming**: "NGINX Ingress Controller" — never "Official NGINX Ingress Controller" or "NGINX Inc.". The other one is "the community controller" or `kubernetes/ingress-nginx`.

## Research resources

Prefer GitHub MCP tools over WebFetch. NIC's prose docs are **not** in its code repo — they live in `nginx/documentation`.

| Project | Where |
|---|---|
| Community controller | `kubernetes/ingress-nginx` · [annotations source](https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/nginx-configuration/annotations.md) · https://kubernetes.github.io/ingress-nginx, published at `/user-guide/nginx-configuration/annotations/` |
| NIC | `nginx/kubernetes-ingress` (CRD types at `pkg/apis/configuration/v1/types.go`) · [annotations source](https://github.com/nginx/documentation/blob/main/content/nic/configuration/ingress-resources/advanced-configuration-with-annotations.md) · https://docs.nginx.com/nginx-ingress-controller/, published at `/configuration/ingress-resources/advanced-configuration-with-annotations/` with the VirtualServer, Policy, TransportServer and GlobalConfiguration pages under `/configuration/` · [migration guide](https://docs.nginx.com/nginx-ingress-controller/install/migrate-ingress-nginx) |
| NGINX Gateway Fabric | `nginx/nginx-gateway-fabric` · https://docs.nginx.com/nginx-gateway-fabric/ |
| ingress2gateway | `kubernetes-sigs/ingress2gateway` |

## Deeper references

`.claude/skills/*/SKILL.md` — plain markdown, readable by any agent. Claude Code loads them on demand from their own descriptions, so this list is for everyone else: **f5ds-design** (design values, and every deviation with its reason), **migration-tool** (mappings, generators, the accuracy check), **repo-checks** (what each check asserts, how to add one), **release-update** (version bumps), **verify-visually** (rendering and measuring).
