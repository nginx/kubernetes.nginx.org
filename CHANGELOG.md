
# Changelog

This is a documentation-only site; entries track notable content and tooling updates rather than versioned software releases. The product versions referenced on the site (NGINX Ingress Controller, NGINX Gateway Fabric, ingress2gateway) are kept current as upstream releases ship.

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
