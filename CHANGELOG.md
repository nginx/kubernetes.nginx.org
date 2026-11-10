
# Changelog

This is a documentation-only site; entries track notable content and tooling updates rather than versioned software releases. The product versions referenced on the site (NGINX Ingress Controller, NGINX Gateway Fabric, ingress2gateway) are kept current as upstream releases ship.

## 1.2.0 (November 10, 2026)

- HAProxy migration tool (`haproxy-migration.html`): migrates the HAProxy Kubernetes Ingress Controller (v3.2.19) to NGINX Ingress Controller (v5.7.0). The analyzer reads annotated Ingress and Service objects, the controller ConfigMap with `tcp-services`, and the Global, Defaults, Backend, Frontend and TCP custom resources in both API groups, and generates the NGINX Ingress Controller resources. The reference guide maps every annotation, ConfigMap key, CRD field and controller flag. `nic-migrate` takes `--source haproxy`.
- Traefik migration tool (`traefik-migration.html`), in beta: migrates Traefik Proxy (v3.7.17) to NGINX Ingress Controller (v5.7.0). The analyzer reads IngressRoute and its TCP and UDP forms, Middleware, TraefikService, TLSOption, TLSStore, ServersTransport and annotated Ingress objects. The reference guide maps the 24 HTTP middlewares of Traefik's open source edition, the Ingress annotations and the static configuration. `nic-migrate` takes `--source traefik`. Its mappings and output may still change.
- ingress2gateway: the landing page now points to the [`nginx/ingress2gateway`](https://github.com/nginx/ingress2gateway) fork, whose NGINX emitter (`--emitter=nginx`) turns NGINX Ingress Controller resources into Gateway API resources plus the NGINX Gateway Fabric policies standard Gateway API has no field for. We are working on merging it upstream in kubernetes-sigs/ingress2gateway pull request 422; until then the page builds the fork from source.
- The three migration tools share one engine (`assets/js/migration-core.js`) and one set of checks, so a fix to one reaches all three. The ingress-nginx analyzer now splits a plain `pathType: Prefix` path at the path segment, as the community controller did, so `/foo` no longer matches `/foobar`.

## 1.1.0 (August 15, 2026)

- Restyled the whole site onto the **F5 Design System**, the system behind the F5 Distributed Cloud console. `assets/css/tokens.css` is now the entire design surface: every colour, size, space, radius, shadow and duration resolves to a token declared there. The typeface is self-hosted Inter; there are no third-party runtime dependencies of any kind.
- Reworked the top bar, and authored a dark theme rather than deriving one. Printing from dark mode previously carried the dark tokens onto paper; the theme is now scoped to `@media screen`.
- Every colour pairing on the site meets WCAG 2.1 AA in both themes. Three pairings F5DS publishes do not, and are replaced with derived values — the reasoning is recorded in `tokens.css` beside each token.
- Added four dependency-free checks under `.github/scripts/` (design tokens, colour contrast, class resolution, analyzer behaviour), now run in CI on every push and pull request.
- The ingress-nginx analyzer now splits YAML documents through the shared engine helper instead of its own copy, so it recognises `---` separators that carry a trailing comment — the form `helm template` emits.
- Replaced `CLAUDE.md` with `AGENTS.md` at the repository root, so every AI coding tool reads the same instructions.

## 1.0.0 (March 4, 2026)

Initial release of the NGINX on Kubernetes site:

- Landing page (`index.html`) — hub for the NGINX Kubernetes ecosystem (NGINX Ingress Controller, NGINX Gateway Fabric, ingress2gateway, and the migration tool).
- NGINX Ingress migration tool (`ingress-nginx-migration.html`) — interactive YAML analyzer, 130+ annotation mappings, CRD migration examples, and ConfigMap migration guidance.
