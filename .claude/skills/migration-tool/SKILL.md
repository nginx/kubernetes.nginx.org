---
name: migration-tool
description: How to author and verify the ingress-nginx migration tool — the source-module/core engine split, the rule that analyzer mappings and reference tables must agree in both directions, row ordering and collapsed-cell conventions, how to test generator changes in Node with no build system, and the four-point accuracy check for any documented annotation or CRD field. Use when editing ingress-nginx-migration.html, assets/js/migration-core.js or assets/js/migration-ingress-nginx.js, adding or changing an annotation mapping, or verifying that a documented construct matches the pinned NIC version.
---

# The migration tool

`ingress-nginx-migration.html` is live at https://kubernetes.nginx.org/ingress-nginx-migration.html — an interactive YAML analyzer with 130+ annotation mappings, CRD migration examples and ConfigMap guidance.

## Engine

The page runs on a source-agnostic engine:

- `assets/js/migration-ingress-nginx.js` — the **source module**. Supplies `INGRESS_NGINX_VERSION`, `ANNOTATION_MAPPINGS`, parsers, CRD generators and sample presets; defines `window.MIGRATION_SOURCE`. Never touches the DOM, and may dereference `MigrationTool.*` only inside function bodies (call time), never at top level.
- `assets/js/migration-core.js` — the **core**. Owns analyzer orchestration and rendering, table filtering, page nav and the checklist; defines `window.MigrationTool` (NIC target versions plus shared utils).

Load order is `shared.js` → `migration-<source>.js` → `migration-core.js`, and the source must precede the core because the core reads `window.MIGRATION_SOURCE` at top level.

The page is linked from the landing page with a **relative** path (`href="ingress-nginx-migration.html"`) so it resolves identically locally, in PR previews and in production. Do not change it to an absolute FQDN — that only works in production and breaks local testing.

## Mappings and reference tables must agree in both directions

This is the rule that generates the most bugs.

- Editing a mapping or its generator means updating the matching reference-table row — **including the example YAML in the expanded panel, which must match what the corresponding generator emits.**
- Editing a reference row whose construct the analyzer handles (there is a matching `ANNOTATION_MAPPINGS` entry) means updating the mapping or generator to match.

A recurring failure is a hand-written example drifting from its still-correct generator. **Treat the generator as the source of truth** and fix the example to match it.

**Exception:** reference rows for NIC-only features with no community equivalent — the left cell reads "No direct equivalent" — have no analyzer counterpart, so editing them needs no JS change. The `apiKey` Policy row is one, since the community controller has no API-key annotation for the analyzer to map.

## Verifying analyzer changes (there is no build system or test suite)

The analyzer is pure data: `parseInput` → `buildPlan` returns a plain `MigrationPlan` object with no DOM. Test generator and mapping edits in Node by loading `assets/js/migration-ingress-nginx.js` + `assets/js/migration-core.js` under a hand-rolled `window`/`document` stub — one whose `createElement`/`getElementById`/etc. return a chainable no-op element — then calling `MIGRATION_SOURCE.analyzer.parseInput` and `buildPlan` on the sample presets. `.github/scripts/test-analyzer.js` already does this; extend it rather than writing a new harness.

**Load-bearing gotcha:** `buildPlan` runs each generator in a `try/catch` that only `console.warn`s on failure, so a broken generator **silently drops its resource** from the output instead of throwing. Capturing `console.warn` — count > 0, not a thrown exception — is the only way to detect it. `node --check` catches syntax only.

Also sanity-check generated `k8s.nginx.org/v1` field names against the `json:` tags in `nginx/kubernetes-ingress/pkg/apis/configuration/v1/types.go` to catch invalid CRD fields.

## Ordering and structure rules

- **Annotation mapping rows** within each category table are sorted alphabetically by the community annotation name (left column).
- **Within a single row**, when multiple annotations are listed on either side, they are in alphabetical order.
- **"No direct equivalent" rows** (NIC-only annotations) go at the end of their category table, after all community-to-NIC mappings.
- **NIC-only annotations must not be bundled** into community mapping rows. If an NIC annotation has no community equivalent it gets its own "No direct equivalent" row — never grouped into a row that maps community annotations.
- **Collapsed cells stay terse.** The always-visible cells (both columns of a `tr.expandable`) show only badges + `<code>` + a short blurb of at most ~6 words — `No direct equivalent`, `Not applicable`, `No direct equivalent (use <code>basicAuth</code>)`. Never put a full explanatory sentence, caveat or workaround in a collapsed cell. Any such explanation belongs in the expanded panel (`tr.example-row`) as an `info-box` banner: `info-box warning` for hard "no equivalent / no replacement" cases, with a bold lead-in like `<strong>No direct equivalent:</strong>`, and `info-box note` for softer guidance. A `warning` added alongside an existing `note` precedes it.

## Accuracy: check all four, not just "does it exist?"

Every annotation, ConfigMap key, CRD field or feature documented here **must exist in the version the tool's Version Reference banner names**. Verify with `mcp__github__get_file_contents` against that tag — not `main`, and never from memory. Never document unreleased features.

That rule catches **fabrication**. It does not catch **staleness** — a construct that does exist but is described with outdated semantics, wrong defaults or status codes, or an incomplete field set. Staleness is the more dangerous of the two because an existence check passes straight over it, and adversarial intuition about these constructs is wrong roughly half the time. So check all four against the tagged source in both repos:

1. **Exists** — the annotation or field is in the pinned version.
2. **Semantics match** — behaviour, status codes, defaults and value formats match the pinned source. *Example:* the community `auth-signin` accepts a full URL, but NIC's externalAuth `authSigninURI` is a **relative** URI (CRD pattern `^/.*$`), so the tool must strip the scheme and host rather than pass the URL through.
3. **Complete** — no omitted fields or sub-options that exist in the pinned version and that a migrator would hit. *Example:* NIC's `accessControl` Policy is allow **xor** deny — validation requires exactly one of `allow`/`deny` — so a source rule needing both becomes two Policies; collapsing it into one silently drops half the intent.
4. **NIC side checked both ways** — NIC-side claims are neither overstated (e.g. "no HTTP fallback-service field" when VirtualServer/VirtualServerRoute upstreams have `backup`/`backupPort`) nor understated, and any Plus-only NIC capability (e.g. `least_time`, ExternalName upstream services) is labelled as such.

## Research sources

Prefer GitHub MCP tools over WebFetch.

- Community annotations: `kubernetes/ingress-nginx` → `docs/user-guide/nginx-configuration/annotations.md`
- NIC annotations: `nginx/documentation` → `content/nic/configuration/ingress-resources/advanced-configuration-with-annotations.md`
- NIC CRD source: `nginx/kubernetes-ingress` → `pkg/apis/configuration/v1/types.go`
- Published NIC docs: https://docs.nginx.com/nginx-ingress-controller/ — the VirtualServer/VirtualServerRoute, Policy, TransportServer and GlobalConfiguration resource pages under `configuration/`
- Migration guide: https://docs.nginx.com/nginx-ingress-controller/install/migrate-ingress-nginx
