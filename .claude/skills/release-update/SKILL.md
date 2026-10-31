---
name: release-update
description: Checklist for an NIC, NGF or ingress2gateway release, patch or minor — the three version formats a plain grep misses, the extra steps a minor (x.Y.0) brings (featured release post, new constructs, docs links), the feature badges that must not be swept along, and the compatibility and Kubernetes-version rules most often missed. Use when bumping any product version.
---

# Release update checklist

Update **all** of the following. The version numbers are scattered across spans, badges, install commands and JS fallbacks, and updating the obvious ones *feels* like finishing the job.

**Run `python3 .github/scripts/check-versions.py` first and last.** It parses `VERSION_CONFIG` and `MigrationTool.NIC` and asserts every copy on the site agrees with them, so it tells you what a bump still has left to do — and, run first, it tells you whether the site was already consistent before you started. It does *not* know what the correct upstream version is; that judgement is yours.

Note the asymmetry that makes a half-finished bump hard to notice by eye: `index.js` fetches live releases, so the landing page renders current versions in a browser regardless of what the file says. The migration tool has no fetch path. So the page that *looks* right is the one that self-heals, and the one nobody notices is the one readers copy install commands from.

## The three version formats

A `v`-prefixed grep misses two of them. The format is set per call site by `data-version-format`:

| Format | Renders | Where |
|---|---|---|
| *(default)* | `v5.5.4` | release tags, hero badges, sidebar |
| `bare` | `2.6.4` | Helm `--version` flags, which reject a leading `v` |
| `atv` | `@v1.2.0` | the `go install` module suffix |

## The two steps that get missed

**The compatibility table.** Never bump a version without it. On **every** NIC *and* NGF release, that product's compat table moves too: its NGINX Open Source version and its Kubernetes row.

**Kubernetes versions.** The compat tables always show the **latest 3 Kubernetes minor versions**, matching upstream's support window — verify against `kubernetes/kubernetes` releases. This is not the project's full supported range. Do not widen the list to match a project's broader minimum: writing "1.31 – 1.35" because NGF supports 1.31+ is wrong, because the older minors are end-of-life upstream regardless. When the latest-3 window shifts, the tables shift with it.

## Patch or minor? Decide first

Compare the minor you are leaving with the one you are going to. A patch (`5.6.2` → `5.6.3`) is the checklist below and nothing more. A **minor** (`5.5.x` → `5.6.x`, `2.6.x` → `2.7.x`) is that checklist **plus** everything in this section — and several patches can hide a minor: `v5.5.4` → `v5.6.3` is one.

This section exists because a minor-only step was missed three releases running (NIC 5.5, NGF 2.5 and 2.6). The checklist had no patch/minor split, so every bump was handled as a patch.

1. **Featured content on the home view.** Release posts exist only for minors (blog.nginx.org has none for patches), and the two Featured-blog cards should promote the current NIC and NGF minors. Replace a card's link, title (the post's H1, verbatim) and one-line summary, and use the post's own artwork — the 1024-wide size of its `og:image` on `blog.nginx.org/wp-content/uploads/`, which is what the head `preconnect` points at (the `og:image` itself may name a CDN host; use the same path on blog.nginx.org). Since October 2026 the artwork is 16:9, so that size is `-1024x576`, which fills the card's 16/9 frame; older posts were `-1024x536`. Check it returns 200 before using it: a size that does not exist is a broken image, and headless captures show none of these images either way. Write the summary from the post, then check each claim against the tagged source: the NIC 5.6 post says the HSTS Policy works on VirtualServerRoute and Ingress, and `addHSTSConfig` at v5.6.3 rejects everything but a VirtualServer's `spec.policies`. If the post is not out yet, leave the card and say so — `check-versions.py` keeps reporting it until it is fixed.
2. **NIC: what the minor added or changed.** Read the release notes, then diff the tagged sources between the two minors (`internal/configs/annotations.go`, `configmaps.go`, `pkg/apis/configuration/v1/types.go`, `pkg/apis/configuration/validation/`). New *and changed* constructs both count — a changed validator makes an existing example wrong. Then add the `New vX.Y.0` badges, a `vX.Y.0` tab in the Key differences "New in NGINX Ingress Controller" box (first, and active: newest first), and analyzer coverage, following the `migration-tool` skill (precedent: `6f4291f`, NIC 5.5). **Account for every Features entry in the release notes before calling the bump done:** mapped, noted on the page, or ruled out with a reason (Plus-only, Helm-only, no community counterpart). "Not yet assessed" is not an outcome; in the 5.7 bump, three features the community controller also had were deferred that way.
3. **Every docs link on both pages.** Minors are when upstream restructures its docs; NGF 2.7 renamed `tls-passthrough/` to `tlsroute/` and `installation/` to `install/`. A redirect still works, but it means the page is no longer maintained there:
   `grep -o 'href="https://docs.nginx.com/[^"]*"' index.html ingress-nginx-migration.html | sed 's/.*href="//;s/"$//;s/#.*//' | sort -u | while read u; do c=$(curl -s -o /dev/null -w '%{http_code}' "$u"); [ "$c" = 200 ] || echo "$c $u"; done`
4. **NGF: the Gateway API surface.** The conformant Gateway API version comes from the release's `conformance-profile.yaml` asset (`gatewayAPIVersion`), not the README. NGF's own CRDs come from `deploy/crds.yaml` at the tag; the Gateway API kinds it supports come from NGF's Gateway API compatibility doc in `nginx/documentation`. The quick start's Gateway API CRD step is bound to `ngf.release`, so it moves on its own.
5. **Chart minors move too.** NIC's chart minor tracks the controller's (5.6.x ships chart 2.7.x), so the e2e pin `NIC_CHART_VERSION` in `tools/nic-migrate/e2e/run-e2e.py` moves with it.

## Before documenting anything new

Every feature, annotation, ConfigMap key or CRD field must exist in the released version being referenced. Verify with `mcp__github__get_file_contents` against the tag — never `main`, never from memory. Audit the release notes to identify genuinely new features, but do not pre-document features from versions that have not shipped. For the fuller accuracy procedure, see the `migration-tool` skill.

## Both products — `index.html`

For `<nic|ngf>`, whichever shipped:

- Version fallback text in the `data-version="<nic|ngf>.release"` spans — sidebar, hero badge, Key Details.
- The release-tag link in the hero badge (`href`).
- Helm chart version in the `data-version="<nic|ngf>.helm"` spans **and** in the Helm install command.
- `VERSION_CONFIG` fallback values for `<nic|ngf>.release` and `<nic|ngf>.helm` in `assets/js/index.js`.
- **The compatibility table** in that product's section — NGINX Open Source version and Kubernetes rows. The OSS version comes from `NGINX_OSS_VERSION` in `build/Dockerfile` at the release tag for NIC, and from the release notes / README technical-specs table for NGF.

## NGF only

- **Supported Resources** tag list — review against `deploy/crds.yaml` at the release tag to catch new CRDs (`WAFPolicy` arrived in v2.6.0; `ExternalLoadBalancer` and `PayloadProcessor` in v2.7.0). Gateway API kinds come first, then NGF's own, each group alphabetical.
- **Gateway API version** in the "Fully Conformant Gateway API" pill and the feature-card copy — update if the release bumps the conformant Gateway API version. It appears twice in `index.html`; grep the current value rather than trusting any number written here.

## ingress2gateway only

It has no Helm chart and no compatibility table, which is exactly why it is the product that goes stale: nothing about it looks like the NIC/NGF checklist above, so following that checklist skips it entirely. Four places:

- `VERSION_CONFIG.i2g.fallback.release` in `assets/js/index.js`.
- The sidebar `data-version="i2g.release"` span.
- The hero badge — both its text and its `releases/tag/` href.
- The `go install` line, which is `data-version-format="atv"` and so renders `@v1.2.0`.

## Feature badges are not version pins

The migration tool carries `badge badge-new` spans (`New v5.4.0`, `New v5.5.0`, …). They state **which release introduced a construct** and must never be swept along with a bump — moving one turns a true statement into a false one. They are unmanaged: when a release adds a construct, add its badge by hand against that release's notes, and leave every existing badge alone. `check-versions.py` deliberately ignores them.

The same applies to `INGRESS_NGINX_VERSION`: `kubernetes/ingress-nginx` is archived and `controller-v1.15.1` is its final release, so it is a constant rather than a pin.

## NIC only — the migration tool

The tool does not reference NGF at all, so an NGF release never touches it.

- `MigrationTool.NIC` at the **top of `assets/js/migration-core.js`** (`VERSION`, `HELM_VERSION`). This is the single source of truth for the NIC side of the Version Reference banners, the standalone `kubectl apply` example, and the analyzer's CRD-install references on **every** migration page — the install commands and release URL derive from it.
- `INGRESS_NGINX_VERSION` at the **top of `assets/js/migration-ingress-nginx.js`** — the source-controller side of the banner; its release link derives from it. Note `kubernetes/ingress-nginx` was archived in March 2026 and `controller-v1.15.1` is its final release, so this should not need bumping again.
- The static fallback text inside the `data-*-version` spans and `data-*-release-link` anchors in `ingress-nginx-migration.html`, so readers without JS see the correct version before the scripts run.

## After

Run the checks through the runner, then render the changed pages and look at them — none of them can see a rendered page.

```bash
python3 .github/scripts/check-all.py
```

Not a hand-written list of the scripts: the shell loop this section used to give (`for f in assets/js/*.js; do node --check "$f" || break; done`) exits 0 when `node` is missing, because the `||` swallows the 127, so it reported a clean parse having run nothing. `check-all.py` treats a missing interpreter as a failure and prints how many checks ran.

Also update the compat cells, which carry `data-compat="nginx"` and `data-compat="kubernetes"` so they can be found per product rather than by matching a bare number that appears elsewhere on the page. Nothing derives them, so they remain the one part of a release that only a human can confirm.
