# AGENTS.md

Instructions for AI coding agents. Claude Code reads this via `.claude/CLAUDE.md`; Copilot's coding agent and other tools read it directly. **It is loaded into every session**, so it holds only the rules that must apply before anything is read: the ones that fail silently. The rest is in the skills listed at the bottom.

## What this is

A static, documentation-only site on NGINX for Kubernetes, owned by F5, Inc., Apache 2.0. No build system and no package manager; there *are* checks and a test suite, and CI runs them on every push and PR. No CDN and no third-party runtime dependencies, with two deliberate exceptions, both images: YouTube poster images (click-to-play into `youtube-nocookie`) and the featured-blog thumbnails hotlinked from `blog.nginx.org`.

It covers **NGINX Ingress Controller** (`nginx/kubernetes-ingress`), **NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`), the **NGINX Ingress Migration Tool** (community `kubernetes/ingress-nginx` → NIC) and **ingress2gateway** (`kubernetes-sigs/ingress2gateway`).

- `index.html` is the landing page, and `ingress-nginx-migration.html` the migration tool: YAML analyzer, annotation mappings, reference tables. Both hold markup only.
- `assets/css/tokens.css` is THE design surface; `shared.css` and one stylesheet per page follow it. `assets/js/` holds `shared.js`, `index.js` and the migration engine (`migration-core.js` plus one source module per tool).
- `tools/nic-migrate/` is a CLI that runs the analyzer over real manifests. It reads the engine out of `assets/js/`; never vendor a copy.

**`tools/` is not published, and neither is `.github/`, for different reasons.** Pages runs the classic Jekyll build on `main`, which skips dot-prefixed paths; that is all that keeps `.github/` off the site, so never add `.nojekyll`. A plain `tools/` gets no such treatment: `_config.yml` exists solely to exclude it, and restates Jekyll's default `exclude` list because setting the key replaces those defaults.

**Never touch `CHANGELOG.md` unless explicitly asked.** A released section can already be on `main` and serving production, so "helpfully" appending to one revises a shipped record. Say in your summary that it is untouched.

## Reading this repo cheaply

The migration page and its source module are each far too large to read whole. **Ask the locator; it prints exact line ranges and the `Read` call to make:**

```bash
python3 .github/scripts/where.py rewrite-target     # mapping + generator + every reference row
python3 .github/scripts/where.py enable-brotli      # any reference row, by a code name in either cell
python3 .github/scripts/where.py '#mappings'        # any element id; an id-less heading by its text
python3 .github/scripts/where.py --outline index.html  # sections and headings with line ranges
python3 .github/scripts/where.py --green-text       # a token: value, dark override, exact uses
python3 .github/scripts/where.py --list green       # matching tokens, light and dark
python3 .github/scripts/where.py .version-pill      # a CSS class;  filterTable  a JS function
python3 .github/scripts/where.py --diff rewrite-target  # a row's example vs what the analyzer emits
python3 .github/scripts/where.py --stats            # sizes and counts, computed now
```

`-s` prints the lines too, and `--tests <name>` lists the tests that mention it. It **exits 1 when it finds nothing**, because "no hits" and "not there" must not look alike. Never quote a size or count from memory; `--stats` computes it.

## Load order and asset invariants

These fail silently: nothing errors, the page just renders wrong.

- **CSS on every page: `tokens.css` → `shared.css` → the page CSS.**
- **`shared.js` before the page JS.** Page scripts are IIFEs calling shared.js globals like `closeSidebar` / `copyToClipboard`.
- **Migration pages: `shared.js` → `migration-<source>.js` → `migration-core.js`.** The core reads `window.MIGRATION_SOURCE` at top level. Source modules never touch the DOM, and dereference `MigrationTool.*` only inside function bodies.
- **Asset paths are relative** (`assets/css/…`, no leading `/`), so the filesystem, a local server and production all resolve them. There is no PR preview environment.
- **The woff2 `<link rel="preload" as="font" … crossorigin>` comes before the stylesheet links**, because `@font-face` lives inside `shared.css`.
- The inline dark-mode flash-prevention script and the JSON-LD stay inline; classic (non-module) scripts keep functions global.
- The font is **self-hosted, never a CDN**. Read `assets/fonts/README.md` before upgrading or re-subsetting, or adding a row with a character outside the subset.

## Shared header, sidebar and banner

The single source of truth is `shared.css` and `shared.js`: **edit once there**, not per page.

- **The topbar/sidebar/banner markup is duplicated in both pages and must stay structurally in sync**, because the shared CSS/JS keys off `#sidebar`, `#sidebarBackdrop`, `#menuToggle`, `#darkToggle`, `#mobileBreadcrumb`, `.topbar`, `.event-banner`, `#copyright-year`, `#page-announce`.
- **Dark-mode content link colours** (`a:link`, `a:visited`) are scoped to the content area (`.page-body` in `index.css`, `.main-inner` in `migration.css`) and stay in the per-page CSS, never in `shared.css` or global, or they override the topbar/sidebar links.

Top-bar geometry and the layouts already tried and reverted are in `f5ds-design`; read it before re-proposing one.

## Design system: the hard rules

The site follows the **F5 Design System (F5DS)**. Never blend it with the F5 **marketing** brand (Neusa Next Pro Wide / Proxima Nova, F5 Red, the Brand Center ramps): a value correct in one is a defect in the other. `tokens.css` is the reference for every value and measured ratio; look values up with `where.py --list`, never guess a hex.

- **Never write a raw value at a call site**, inline `style=` attributes and JS-generated `cssText` included.
- **Spacing**: multiples of 4 on a base of 8. **12px is not in the system**: resolve it to 8 or 16, never to itself.
- **Radius**: `--radius` (4px) for everything; `--radius-small` only when genuinely too small for 4px; `--radius-pill` for Tags and Badges only.
- **Type**: sizes only through `--fs-*`/`--lh-*`, and **any rule that sets `font-size` restates the paired `--lh-*`**. Weights 400/500/700. **No `letter-spacing` anywhere.**
- **Elevation**: `--elev-*` only; cards are border-only at rest, with no hover lift.
- **A status hue is never text**, and colour is never the only signal: a status dot ships with its label, an info box with its icon.
- **Filled green buttons use `--green-text`**, not `--green`. **CRD badges use the graph palette**, not the sentiment hues.
- **Sentence case, except button and tab labels** (Title Case). A toggle is not a button. Sidebar labels match the `<h2>` they link to verbatim unless the label would clip the rail.

**The site deviates from F5DS deliberately in several places; do not "fix" them.** Each is in `f5ds-design` with its reason.

## Checks

`python3 .github/scripts/check-all.py` runs them all and prints **how many ran**; a missing interpreter is a failure, never a skip.

- **Run them when asked, not after every change, and if you have not run them, say so.** Never describe unrun work as verified.
- **Never chain the checks on one shell line.** A mistyped construct reports "clean" for a check that never ran (the incident list is in `repo-checks`); `$?` after a pipe is the last command's status (zsh: `${pipestatus[1]}`).
- **None of them can see the rendered page.** A clean run means nothing is structurally broken, not that it looks right. Render it (`verify-visually`).
- **A new assertion is not finished until you have watched it fail.** Plant the defect, see it reported, restore, and name it in the commit body.
- **The e2e is not one of the nine, and has its own rule: run it at the end of every substantial piece of work**, every source on the branch, both targets (`tools/nic-migrate/e2e/run-e2e.py`; how in `migration-tool`). It is the only test that applies the output to NGINX Ingress Controller.

## Branches, deploying, and undoing

**Pushing to `main` is deploying**: it is live in about a minute, and CI finishes at about the same time, so a red run does not stop a bad commit reaching production. Verify before you push.

- Commit on the branch you are on; do not create one unless asked. **Stage by path, never `git add -A` or `commit -a`**, and run `git status --short` just before: another session may have work in the same tree, and a sweep once committed it. Files you did not touch are not yours; leave them unstaged, and do not stash them.
- No `Co-Authored-By` trailer.
- **Back-to-back commits of one type are one commit.** When a new commit has the same Conventional Commits type (`feat`, `fix`, `docs`, …) as the unpushed commit right before it, fold it into that one, with a message covering both, instead of stacking another; do it unasked. Only unpushed commits: what is already on a remote stays as it is.
- **Push only when asked**, and to `main` only on an explicit go each time.
- **Stay on the tool you were asked about.** Work on one preview branch does not touch another, or `main`, unless asked by name. The exception is a fix to what `main` owns (below): it goes on `main`, and says so. A finding about another tool is reported, not committed. A bare "continue" after a finished task means ask which flagged item, if any, comes next.
- `preview/**` branches carry further migration tools on the same engine. **`main` owns the shared engine and the checks** (`shared.js`, `migration-core.js`, `.github/scripts/`, `.github/test/`, this file): merge `main` into a branch rather than porting fixes across.
- Undo on `main` with `git revert <sha>`. **Never** `push --force`, `reset --hard` or `clean` a pushed branch without the maintainer's go, asked each time: say what the remote tip loses, and keep anything only it has under an `archive/*` tag first.

## Migration tool: the one rule that cannot wait

**The analyzer's mappings and the static reference tables must agree in both directions.** Editing a mapping or generator means updating the reference row *and* the example YAML in its panel; editing a row the analyzer handles means updating the mapping. The generator is the source of truth; a hand-written example drifting from a correct generator is the recurring bug here. `where.py <annotation>` finds all three; `where.py --diff <annotation>` compares the example with what the analyzer emits. The rest is in `migration-tool`.

## Reasoning, spelling and naming

Commit bodies are the record of what was tried and rejected: run `git log --grep='Considered and rejected'` or `git log -S'<name>'` before re-proposing or deleting anything. Write yours the same way (`CONTRIBUTING.md`), and keep commits and reports proportionate: a body of ~15 lines, a report of a few, no tables or headings for a small result.

**Every commit message gets a plain-writing pass before you commit**, subject and body, and so does any edit to the docs, the skills or page prose: no dash joining two clauses, no "not X but Y" where nobody claimed X, no one-line closer restating the paragraph, no triad for rhythm, no inflated or stock AI words. Facts, names, numbers and the "Considered and rejected" record stay as they are. How, with examples and the deliberate exceptions, is in `writing-style`.

- **A finding is verified only as far as you checked it.** A quote can be right and its premise wrong: read the section it is about and who it addresses before calling it confirmed, say which part you checked, and keep "re-verified" apart from "as reported".
- **During a mockup review, a stated preference changes the mockups, not the repo**, until the maintainer says to implement it.
- **British** in agent-facing prose and comments (`colour`), including `tokens.css` comments; **American** in page copy; `color` in CSS regardless. Normalising this is out of scope.
- Prefixes: community `nginx.ingress.kubernetes.io/`; NIC `nginx.org/` (OSS) or `nginx.com/` (Plus). NIC CRDs: VirtualServer, VirtualServerRoute, Policy, TransportServer, GlobalConfiguration. Only NIC has NGINX Plus features (JWT, OIDC, WAF).
- **"NGINX Ingress Controller"**, never "F5 NGINX Ingress Controller" (an open source project takes no F5 prefix), "Official NGINX Ingress Controller" or "NGINX Inc.". The other one is "Ingress-NGINX" in titles and headers, "the community controller" or `kubernetes/ingress-nginx` in prose; the tool is the "NGINX Ingress Migration Tool". NGINX Gateway Fabric is the NGINX implementation of the Gateway API. Page copy and analyzer output never shorten these to NIC or NGF (a test checks), and a sentence about what a controller does names it: not "it reads", "the default is" or "the community", since both controllers are always in play. The same goes for resources, in test names and commits too: "a community Ingress" for the input, the output by its kind (VirtualServer, migrated Ingress), never a bare "Ingress" or "resource". Details are in `migration-tool`.

## Deeper references

`.claude/skills/*/SKILL.md`, plain markdown that any agent can read: **f5ds-design** (design values and every deviation), **migration-tool** (mappings, generators, the test harness, the accuracy check, research sources), **repo-checks** (what each check asserts, when to run them, how to add one), **release-update** (version bumps, patch and minor), **verify-visually** (rendering, measuring, the CDP helper), **writing-style** (the plain-writing pass and its exceptions). Two commands in `.claude/commands/` run only when the maintainer types them: `/checks` and `/site-audit` (the multi-perspective audit).

**A rule the maintainer gives you goes here or in a skill, committed**, never only in an agent's private memory: other agents and sessions do not see that, and it is lost with the agent. A rule that must apply before anything is read goes in this file; the how goes in the skill it belongs to.
