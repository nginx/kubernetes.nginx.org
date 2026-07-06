# CLAUDE.md

## Project Overview

Documentation-only project covering NGINX on Kubernetes. The site serves as a general-purpose landing page for NGINX's Kubernetes ecosystem, including:

- **NGINX Ingress Controller** (`nginx/kubernetes-ingress`) — F5 NGINX's Kubernetes Ingress Controller
- **NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`) — F5 NGINX Gateway API-native implementation
- **NGINX Ingress Migration Tool** — Interactive guide for migrating from the community controller (`kubernetes/ingress-nginx`) to the NGINX Ingress Controller
- **ingress2gateway** (`kubernetes-sigs/ingress2gateway`) — CLI tool to convert Ingress resources to Gateway API

Project characteristics:

- No build system, tests, or package manager
- Static HTML + Markdown documentation with CSS/JS in `assets/` (no CDN/third-party runtime dependencies — two deliberate exceptions, both images and neither of them script: the featured videos load poster images from `i.ytimg.com` and are click-to-play into `youtube-nocookie`, so nothing off-origin runs until a reader asks for it; and the two featured-blog thumbnails hotlink each post's own artwork on `blog.nginx.org`'s CDN rather than vendoring a copy that ages in the repo)
- Owned by F5, Inc., Apache 2.0 license

## Directory layout

CSS and JS are split into external files under `assets/` (shared chrome + per-page), so the two HTML pages no longer duplicate styles/scripts. Images live under `assets/img/`.

```
assets/
  css/  shared.css        # chrome: design tokens, reset, topbar, sidebar, event banner, dark mode, layout, accessibility
        index.css         # landing-page-only styles (hero, feature/project grids, compat tables, CTAs, code blocks)
        migration.css     # migration-tool styles shared by all migration pages (analyzer UI, mapping/reference tables, badges, checklist, print)
  js/   shared.js         # chrome behavior: dark-mode toggle, sidebar drawer, copy-to-clipboard, copyright year (globals)
        index.js          # landing-page behavior: version auto-fetch, SPA product switching, entrance animation, YouTube
        migration-core.js           # source-agnostic migration-tool engine: analyzer orchestration/rendering, table filtering, page nav, checklist; defines window.MigrationTool (NIC target versions + shared utils)
        migration-ingress-nginx.js  # ingress-nginx SOURCE module: INGRESS_NGINX_VERSION, ANNOTATION_MAPPINGS, parsers, CRD generators, sample presets; defines window.MIGRATION_SOURCE
  img/  icon.svg, icon-512.png, apple-touch-icon.{svg,png}, og-image.{svg,png}
```

Loading rules (all pages): `shared.css` is linked before the page CSS; `shared.js` is loaded before the page JS (the page scripts are IIFEs that call shared.js globals like `closeSidebar` / `copyToClipboard`). Migration pages load **three** scripts in this exact order: `shared.js` → `migration-<source>.js` → `migration-core.js`. The source module must load before the core (the core reads `window.MIGRATION_SOURCE` at top level); source modules never touch the DOM and may dereference `MigrationTool.*` only inside function bodies (call time), never at top level. Asset paths are **relative** (`assets/css/…`, `assets/js/…`, no leading `/`) so they resolve identically locally, in PR previews, and in production. The inline `<head>` dark-mode flash-prevention `<script>` and the page-specific JSON-LD stay inline; classic (non-module) scripts keep functions global.

## Key Files

- `index.html` — **The live landing page** served via GitHub Pages. Hub page linking to all four projects/tools above. Styles/scripts live in `assets/css/{shared,index}.css` and `assets/js/{shared,index}.js`.
- `ingress-nginx-migration.html` — **The live migration tool** at `https://kubernetes.nginx.org/ingress-nginx-migration.html`. Interactive YAML analyzer, 130+ annotation mappings, CRD migration examples, and ConfigMap migration guidance. Styles live in `assets/css/{shared,migration}.css`; scripts are `assets/js/shared.js` + `assets/js/migration-ingress-nginx.js` + `assets/js/migration-core.js` (in that order).

## Workflow

### Landing page (`index.html`)

- Now markup-only (~690 lines) — styles are in `assets/css/{shared,index}.css` and behavior in `assets/js/{shared,index}.js`. Edit the HTML for content/layout, the CSS/JS files for presentation/behavior.

### Migration tool (`ingress-nginx-migration.html`)

- The live migration tool is `ingress-nginx-migration.html`, linked from the landing page with a relative path (`href="ingress-nginx-migration.html"`) so the link resolves identically when opened locally, in PR previews, and in production. Do not change it to an absolute FQDN — that only works in production and breaks local testing.
- The page runs on the shared engine: the source module (`migration-ingress-nginx.js`) supplies mapping data + `parseInput`/`buildPlan`; `migration-core.js` owns rendering/nav/checklist. **The analyzer's mappings (`ANNOTATION_MAPPINGS` in the source module) and the static reference tables in the HTML must stay in agreement in both directions:** editing a mapping (or its generator) means updating the matching reference-table row — **including the example YAML in the expanded panel, which must match what the corresponding generator emits** — and editing a reference row whose construct the analyzer handles (there is a matching `ANNOTATION_MAPPINGS` entry) means updating the mapping/generator to match. **Exception:** reference rows for NIC-only features with no community equivalent (the left cell reads "No direct equivalent") have no analyzer counterpart, so editing them needs no JS change — e.g. the `apiKey` Policy row, since the community controller has no API-key annotation for the analyzer to map. A recurring bug is a hand-written example drifting from its still-correct generator; treat the generator as the source of truth and fix the example to match it.

#### Verifying analyzer changes (there is no build system or test suite)

The analyzer is pure data — the source module's `parseInput` → `buildPlan` returns a plain `MigrationPlan` object with no DOM. Test generator/mapping edits in Node by loading `assets/js/migration-ingress-nginx.js` + `assets/js/migration-core.js` under a hand-rolled `window`/`document` stub (its `createElement`/`getElementById`/etc. return a chainable no-op element) and calling `MIGRATION_SOURCE.analyzer.parseInput`/`buildPlan` on the sample presets. **Load-bearing gotcha:** `buildPlan` runs each generator in a `try/catch` that only `console.warn`s on failure, so a broken generator **silently drops its resource** from the output instead of throwing — capturing `console.warn` (count > 0, not a thrown exception) is the only way to detect it. `node --check` catches syntax only. Also sanity-check generated `k8s.nginx.org/v1` field names against the `json:` tags in `nginx/kubernetes-ingress/pkg/apis/configuration/v1/types.go` to catch invalid CRD fields.

#### Migration tool ordering and structure rules

- **Annotation mapping rows** within each category table must be sorted alphabetically by the community annotation name (left column).
- **"No direct equivalent" rows** (NIC-only annotations) go at the end of their category table, after all community-to-NIC mappings.
- **NIC-only annotations must not be bundled** into community mapping rows. If an NIC annotation has no community equivalent, it gets its own "No direct equivalent" row — never grouped into an existing row that maps community annotations.
- **Within a single row**, when multiple annotations are listed on either side, they should be in alphabetical order.
- **Collapsed cells stay terse** — the always-visible mapping cells (both columns of a `tr.expandable`) show only badges + `<code>` + a short blurb (≤ ~6 words of prose, e.g. `No direct equivalent`, `Not applicable`, `No direct equivalent (use <code>basicAuth</code>)`). Never put a full explanatory sentence, caveat, or workaround in a collapsed cell. Any such explanation belongs in the expanded panel (`tr.example-row`) as an `info-box` banner: `info-box warning` for hard "no equivalent / no replacement" cases (bold lead-in like `<strong>No direct equivalent:</strong>`), `info-box note` for softer guidance. A `warning` added alongside an existing `note` precedes it.

## Shared UI Elements

The shared "chrome" lives in `assets/css/shared.css` and `assets/js/shared.js` as the single source of truth — **edit it once there**, not in two places. This covers:

- **Event banner** (Announcements) — the green fixed banner, its CSS (`.event-banner`, `body.has-banner` offsets), and JS init
- **Top bar** — the NGINX logo, GitHub link, and dark-mode toggle (CSS + dark-toggle wiring in `shared.js`)
- **Sidebar** — structure, external links, copyright, and the drawer open/close behavior (`shared.js`)
- **Dark mode** — design-token overrides and chrome (topbar/sidebar) colors in `shared.css`; the dark-mode toggle logic in `shared.js`

The HTML markup for these elements (the topbar/sidebar/banner DOM) is still present in both `index.html` and `ingress-nginx-migration.html` and must stay structurally in sync — the shared CSS/JS keys off shared IDs/classes (`#sidebar`, `#sidebarBackdrop`, `#menuToggle`, `#darkToggle`, `.topbar`, `.event-banner`, `#copyright-year`, `#page-announce`).

**Page-scoped exception — dark-mode content link colors:** dark-mode link colors (`a:link`, `a:visited`) must be scoped to the content area (`.page-body` in `index.css`, `.main-inner` in `migration.css`) and stay in the **per-page** CSS — never in `shared.css` and never global, or they override topbar/sidebar link colors.

## Hosting

- **Repository**: https://github.com/nginx/kubernetes.nginx.org
- **GitHub Pages**: https://kubernetes.nginx.org/ (serves `index.html` from `main` branch as the landing page)
- **Migration Tool**: https://kubernetes.nginx.org/ingress-nginx-migration.html

## Domain Concepts

- **Landing page**: The root `index.html` is a hub for the NGINX Kubernetes ecosystem — not just the migration tool
- **Gateway API**: The standard Kubernetes API for traffic management; NGINX Gateway Fabric is the NGINX implementation
- **Annotation prefixes**: Community uses `nginx.ingress.kubernetes.io/`, NGINX Ingress Controller uses `nginx.org/` (OSS) or `nginx.com/` (Plus)
- **CRDs**: NGINX Ingress Controller supports VirtualServer, VirtualServerRoute, Policy, TransportServer, GlobalConfiguration
- **NGINX Plus**: Only the NGINX Ingress Controller supports Plus features (JWT, OIDC, WAF).
- **Naming**: Use "NGINX Ingress Controller" (not "Official NGINX Ingress Controller" or "NGINX Inc."). The community controller is referred to as the "community controller" or by its repo name `kubernetes/ingress-nginx`.

## Research Resources

When verifying information, use GitHub MCP tools to fetch from these authoritative sources:

**Community controller** (`kubernetes/ingress-nginx`):

- GitHub: https://github.com/kubernetes/ingress-nginx
- Docs tree: https://github.com/kubernetes/ingress-nginx/blob/main/docs
- Annotations: https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/nginx-configuration/annotations.md
- Docs site: https://kubernetes.github.io/ingress-nginx
- Published annotations: https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/

**NGINX Ingress Controller** (`nginx/kubernetes-ingress`):

- GitHub: https://github.com/nginx/kubernetes-ingress
- Docs tree: https://github.com/nginx/kubernetes-ingress/tree/main/docs/content
- Annotations: https://github.com/nginx/documentation/blob/main/content/nic/configuration/ingress-resources/advanced-configuration-with-annotations.md
- Docs site: https://docs.nginx.com/nginx-ingress-controller/
- Published annotations: https://docs.nginx.com/nginx-ingress-controller/configuration/ingress-resources/advanced-configuration-with-annotations/
- VirtualServer CRD: https://docs.nginx.com/nginx-ingress-controller/configuration/virtualserver-and-virtualserverroute-resources/
- Policy CRD: https://docs.nginx.com/nginx-ingress-controller/configuration/policy-resource/
- TransportServer CRD: https://docs.nginx.com/nginx-ingress-controller/configuration/transportserver-resource/
- GlobalConfiguration CRD: https://docs.nginx.com/nginx-ingress-controller/configuration/global-configuration/globalconfiguration-resource/

**NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`):

- GitHub: https://github.com/nginx/nginx-gateway-fabric
- Docs site: https://docs.nginx.com/nginx-gateway-fabric/

**ingress2gateway** (`kubernetes-sigs/ingress2gateway`):

- GitHub: https://github.com/kubernetes-sigs/ingress2gateway

**Migration guide**: https://docs.nginx.com/nginx-ingress-controller/install/migrate-ingress-nginx

Prefer GitHub MCP tools over WebFetch for documentation sites.

## Version Accuracy

**Critical rule:** Every annotation, ConfigMap key, CRD field, or feature documented in the migration tool MUST exist in the version referenced by the tool's "Version Reference" banner. Before adding any NIC feature to the migration tool:

1. Check the version stated in the tool's Version Reference (e.g., "v5.4.1").
2. Verify the feature exists in that released version — use `mcp__github__get_file_contents` against the corresponding tag (e.g., `v5.4.1`) to confirm annotations/CRD fields exist in source code or docs.
3. Never document unreleased features, features from `main` branch that haven't been tagged, or features from future versions.

When bumping the referenced version, audit the release notes to identify genuinely new features and update accordingly — but do not pre-document features from versions that haven't shipped yet.

### Bidirectional accuracy (guard against staleness, not just fabrication)

The rule above catches **fabrication** (documenting something that doesn't exist). It does NOT catch **staleness** — describing a construct that *does* exist with outdated semantics, wrong defaults/status codes, or an incomplete field set. Both are accuracy failures, and staleness is the more dangerous because "does it exist?" checks pass right over it. When documenting or reviewing **any** construct (mapping row, generator, note), verify all four — against the tagged source in both repos, never from memory (adversarial intuition about these constructs is wrong roughly half the time):

1. **Exists** — the annotation/field exists in the pinned version (the rule above).
2. **Semantics match** — the behavior, status codes, defaults, and value formats the tool states match the pinned source. (E.g. the community `auth-signin` accepts a full URL, but NIC's externalAuth `authSigninURI` is a **relative** URI — CRD pattern `^/.*$` — so the tool must strip the scheme/host, not pass the URL through.)
3. **Complete** — the tool has not omitted fields/sub-options that exist in the pinned version and that a migrator would hit. (E.g. NIC's `accessControl` Policy is allow **xor** deny — validation requires *exactly one* of `allow`/`deny` — so a source rule needing both becomes two Policies; collapsing it into one silently drops half the intent.)
4. **NIC side checked both ways** — NIC-side claims are neither overstated (e.g. "no HTTP fallback-service field" when VirtualServer/VirtualServerRoute upstreams have `backup`/`backupPort`) nor understated, and any Plus-only NIC capability (e.g. `least_time`, ExternalName upstream services) is labeled as such.

### Release update checklist

When updating the sites for a new release, update **all** of the following.

**Kubernetes compatibility (applies to both NIC and NGF):** the compat tables always show the **latest 3 Kubernetes minor versions** (matches upstream's support window — verify via `kubernetes/kubernetes` releases), not the project's full supported range. Bump these alongside any release update if a newer K8s minor has shipped.

#### NGINX Ingress Controller (NIC) release

**`index.html`:**

- Version fallback text in `data-version="nic.release"` spans in `index.html` (sidebar, hero badge, Key Details)
- Release tag link in the hero badge (`href`) in `index.html`
- Helm chart version in `data-version="nic.helm"` spans and the Helm install command in `index.html`
- JS `VERSION_CONFIG` fallback values for `nic.release` and `nic.helm` — now in `assets/js/index.js`
- **Compatibility table** in the NIC section of `index.html` — update NGINX OSS version (check `NGINX_OSS_VERSION` in `build/Dockerfile` at the release tag) and Kubernetes versions if changed

**Migration tool:**

- Update the NIC target versions in the `MigrationTool.NIC` block at the **top of `assets/js/migration-core.js`** (`VERSION`, `HELM_VERSION` — the install commands and release URL derive from them). This is the single source of truth for the NIC side of the Version Reference banners, the standalone `kubectl apply` example, and the analyzer's CRD-install references on **every** migration page.
- Update the `INGRESS_NGINX_VERSION` constant at the **top of `assets/js/migration-ingress-nginx.js`** (source-controller side of the banner; the release link derives from it). Banner text and release-tag links are populated from these constants at `DOMContentLoaded` via `data-*` attributes. Note: `kubernetes/ingress-nginx` was archived (Mar 2026) and `controller-v1.15.1` is its final release, so this constant should not need bumping again.
- Update the static fallback text inside the `data-*-version` spans / `data-*-release-link` anchors in `ingress-nginx-migration.html` (so no-JS users see the correct version before the JS runs).

#### NGINX Gateway Fabric (NGF) release

**`index.html` only** (the migration tool does not reference NGF):

- Version fallback text in `data-version="ngf.release"` spans (sidebar, hero badge, Key Details)
- Release tag link in the hero badge (`href`)
- Helm chart version in `data-version="ngf.helm"` spans and the Helm install command
- JS `VERSION_CONFIG` fallback values for `ngf.release` and `ngf.helm` — now in `assets/js/index.js`
- **Compatibility table** in the NGF section — update NGINX OSS version (check the NGF release notes / README technical specs table) and Kubernetes versions if changed
- **Supported Resources** tag list — review against `apis/v1alpha1` and `apis/v1alpha2` at the release tag to catch any new CRDs (e.g. `WAFPolicy` was added in v2.6.0). Keep tags alphabetical within the NGF custom-resources block.
- **Gateway API version** in the "Fully Conformant Gateway API" pill and feature card copy (currently mentions v1.5.1) — update if the release bumps the conformant Gateway API version.
