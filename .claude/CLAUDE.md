# CLAUDE.md

## Project Overview

Documentation-only project covering NGINX on Kubernetes. The site serves as a general-purpose landing page for NGINX's Kubernetes ecosystem, including:

- **NGINX Ingress Controller** (`nginx/kubernetes-ingress`) — F5 NGINX's Kubernetes Ingress Controller
- **NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`) — F5 NGINX Gateway API-native implementation
- **NGINX Ingress Migration Tool** — Interactive guide for migrating from the community controller (`kubernetes/ingress-nginx`) to the NGINX Ingress Controller
- **ingress2gateway** (`kubernetes-sigs/ingress2gateway`) — CLI tool to convert Ingress resources to Gateway API

Project characteristics:

- No build system, tests, or package manager
- Self-contained HTML + Markdown documentation (inline CSS/JS, no external dependencies)
- Owned by F5, Inc., Apache 2.0 license

## Key Files

- `index.html` — **The live landing page** served via GitHub Pages. Hub page linking to all four projects/tools above.
- `ingress-nginx-migration.html` — **The live migration tool** at `https://kubernetes.nginx.org/ingress-nginx-migration.html`. Self-contained HTML app with an interactive YAML analyzer, 130+ annotation mappings, CRD migration examples, and ConfigMap migration guidance.

## Workflow

### Landing page (`index.html`)

- Can be edited directly for layout/content updates since it is relatively lightweight (~1,165 lines).

### Migration tool (`ingress-nginx-migration.html`)

- The live migration tool is `ingress-nginx-migration.html`, linked from the landing page with a relative path (`href="ingress-nginx-migration.html"`) so the link resolves identically when opened locally, in PR previews, and in production. Do not change it to an absolute FQDN — that only works in production and breaks local testing.

#### Migration tool ordering and structure rules

- **Annotation mapping rows** within each category table must be sorted alphabetically by the community annotation name (left column).
- **"No direct equivalent" rows** (NIC-only annotations) go at the end of their category table, after all community-to-NIC mappings.
- **NIC-only annotations must not be bundled** into community mapping rows. If an NIC annotation has no community equivalent, it gets its own "No direct equivalent" row — never grouped into an existing row that maps community annotations.
- **Within a single row**, when multiple annotations are listed on either side, they should be in alphabetical order.

## Shared UI Elements

The following elements are duplicated across `index.html` and `ingress-nginx-migration.html` and must be kept in sync when either is updated:

- **Event banner** (Announcements) — the green fixed banner at the top of the page, including its CSS (`.event-banner`, `.has-banner` offsets) and JS init
- **Top bar** — the NGINX logo, GitHub link, and dark mode toggle
- **Sidebar external links** — GitHub, Documentation, Blog, YouTube, Community links at the bottom of the sidebar
- **Sidebar copyright** — footer text in the sidebar
- **Dark mode styles** — variable overrides, sidebar link/ext colors. Dark mode link colors (`a:link`, `a:visited`) must be scoped to the content area (`.page-body` in index.html, `.main-inner` in the migration tool) — never applied globally, or they will override topbar/sidebar link colors.

When changing any of these, update both files.

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

### Release update checklist

When updating the sites for a new release, update **all** of the following.

**Kubernetes compatibility (applies to both NIC and NGF):** the compat tables always show the **latest 3 Kubernetes minor versions** (matches upstream's support window — verify via `kubernetes/kubernetes` releases), not the project's full supported range. Bump these alongside any release update if a newer K8s minor has shipped.

#### NGINX Ingress Controller (NIC) release

**`index.html`:**

- Version fallback text in `data-version="nic.release"` spans (sidebar, hero badge, Key Details)
- Release tag link in the hero badge (`href`)
- Helm chart version in `data-version="nic.helm"` spans and the Helm install command
- JS `VERSION_CONFIG` fallback values for `nic.release` and `nic.helm`
- **Compatibility table** in the NIC section — update NGINX OSS version (check `NGINX_OSS_VERSION` in `build/Dockerfile` at the release tag) and Kubernetes versions if changed

**`ingress-nginx-migration.html`:**

- Update the `NIC_VERSION` and `INGRESS_NGINX_VERSION` constants at the top of the main `<script>` block — these are the single source of truth for the Version Reference banners (3 instances), the standalone `kubectl apply` example, and every `crdInstall` URL inside `ANNOTATION_MAPPINGS`. Banner text and release-tag links are populated from these constants at `DOMContentLoaded`.
- Update the static fallback text inside the `data-*-version` spans / `data-*-release-link` anchors (so no-JS users see the correct version before the JS runs).

#### NGINX Gateway Fabric (NGF) release

**`index.html` only** (the migration tool does not reference NGF):

- Version fallback text in `data-version="ngf.release"` spans (sidebar, hero badge, Key Details)
- Release tag link in the hero badge (`href`)
- Helm chart version in `data-version="ngf.helm"` spans and the Helm install command
- JS `VERSION_CONFIG` fallback values for `ngf.release` and `ngf.helm`
- **Compatibility table** in the NGF section — update NGINX OSS version (check the NGF release notes / README technical specs table) and Kubernetes versions if changed
- **Supported Resources** tag list — review against `apis/v1alpha1` and `apis/v1alpha2` at the release tag to catch any new CRDs (e.g. `WAFPolicy` was added in v2.6.0). Keep tags alphabetical within the NGF custom-resources block.
- **Gateway API version** in the "Fully Conformant Gateway API" pill and feature card copy (currently mentions v1.5.1) — update if the release bumps the conformant Gateway API version.
