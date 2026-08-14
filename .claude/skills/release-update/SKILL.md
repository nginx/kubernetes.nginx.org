---
name: release-update
description: The complete checklist for updating this site after an NGINX Ingress Controller or NGINX Gateway Fabric release — every version string, Helm chart version, release-tag link and JS fallback that has to move, plus the compatibility table and Kubernetes-version rules that are the steps most often missed. Use when bumping NIC or NGF to a new version, updating a compat table, or auditing whether the site's stated versions are current.
---

# Release update checklist

Update **all** of the following. The version numbers are scattered across spans, badges, install commands and JS fallbacks, and updating the obvious ones *feels* like finishing the job.

## The two steps that get missed

**The compatibility table.** Never bump a version without it. On **every** NIC *and* NGF release, that product's compat table moves too: its NGINX OSS version and its Kubernetes row.

**Kubernetes versions.** The compat tables always show the **latest 3 Kubernetes minor versions**, matching upstream's support window — verify against `kubernetes/kubernetes` releases. This is not the project's full supported range. Do not widen the list to match a project's broader minimum: writing "1.31 – 1.35" because NGF supports 1.31+ is wrong, because the older minors are end-of-life upstream regardless. When the latest-3 window shifts, the tables shift with it.

## Before documenting anything new

Every feature, annotation, ConfigMap key or CRD field must exist in the released version being referenced. Verify with `mcp__github__get_file_contents` against the tag — never `main`, never from memory. Audit the release notes to identify genuinely new features, but do not pre-document features from versions that have not shipped. For the fuller accuracy procedure, see the `migration-tool` skill.

## Both products — `index.html`

For `<nic|ngf>`, whichever shipped:

- Version fallback text in the `data-version="<nic|ngf>.release"` spans — sidebar, hero badge, Key Details.
- The release-tag link in the hero badge (`href`).
- Helm chart version in the `data-version="<nic|ngf>.helm"` spans **and** in the Helm install command.
- `VERSION_CONFIG` fallback values for `<nic|ngf>.release` and `<nic|ngf>.helm` in `assets/js/index.js`.
- **The compatibility table** in that product's section — NGINX OSS version and Kubernetes rows. The OSS version comes from `NGINX_OSS_VERSION` in `build/Dockerfile` at the release tag for NIC, and from the release notes / README technical-specs table for NGF.

## NGF only

- **Supported Resources** tag list — review against `apis/v1alpha1` and `apis/v1alpha2` at the release tag to catch new CRDs (`WAFPolicy` arrived in v2.6.0). Keep tags alphabetical within the NGF custom-resources block.
- **Gateway API version** in the "Fully Conformant Gateway API" pill and the feature-card copy — update if the release bumps the conformant Gateway API version. It appears twice in `index.html`; as of this writing both read `v1.5.1`, so grep the current value rather than trusting that.

## NIC only — the migration tool

The tool does not reference NGF at all, so an NGF release never touches it.

- `MigrationTool.NIC` at the **top of `assets/js/migration-core.js`** (`VERSION`, `HELM_VERSION`). This is the single source of truth for the NIC side of the Version Reference banners, the standalone `kubectl apply` example, and the analyzer's CRD-install references on **every** migration page — the install commands and release URL derive from it.
- `INGRESS_NGINX_VERSION` at the **top of `assets/js/migration-ingress-nginx.js`** — the source-controller side of the banner; its release link derives from it. Note `kubernetes/ingress-nginx` was archived in March 2026 and `controller-v1.15.1` is its final release, so this should not need bumping again.
- The static fallback text inside the `data-*-version` spans and `data-*-release-link` anchors in `ingress-nginx-migration.html`, so readers without JS see the correct version before the scripts run.

## After

Run all four checks, each on its own line, then render the changed pages and look at them — none of them can see a rendered page.

```bash
python3 .github/scripts/check-tokens.py
python3 .github/scripts/check-contrast.py
python3 .github/scripts/check-classes.py
node    .github/scripts/test-analyzer.js
```
