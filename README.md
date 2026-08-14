
[![Project Status: Active – The project has reached a stable, usable state and is being actively developed.](https://www.repostatus.org/badges/latest/active.svg)](https://www.repostatus.org/#active)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/nginx/kubernetes.nginx.org/badge)](https://securityscorecards.dev/viewer/?uri=github.com/nginx/kubernetes.nginx.org)
[![Community Support](https://badgen.net/badge/support/community/cyan?icon=awesome)](/SUPPORT.md)
[![Community Forum](https://img.shields.io/badge/community-forum-009639?logo=discourse&link=https%3A%2F%2Fcommunity.nginx.org)](https://community.nginx.org)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/license/apache-2-0)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-3.0-4baaaa.svg)](/CODE_OF_CONDUCT.md)

# kubernetes.nginx.org

The community site for NGINX's Kubernetes ecosystem, served via GitHub Pages at [kubernetes.nginx.org](https://kubernetes.nginx.org/).

## What's Here

- **[Landing Page](https://kubernetes.nginx.org/)** (`index.html`) — Hub page covering the NGINX Kubernetes projects and related tools:
  - [NGINX Ingress Controller](https://github.com/nginx/kubernetes-ingress) — F5 NGINX's Kubernetes Ingress Controller
  - [NGINX Gateway Fabric](https://github.com/nginx/nginx-gateway-fabric) — F5 NGINX's Gateway API implementation
  - [ingress2gateway](https://github.com/kubernetes-sigs/ingress2gateway) — Kubernetes SIG CLI tool to convert Ingress resources to Gateway API

- **[NGINX Ingress Migration Tool](https://kubernetes.nginx.org/ingress-nginx-migration.html)** (`ingress-nginx-migration.html`) — Interactive tool for migrating from the community Ingress-NGINX controller (`kubernetes/ingress-nginx`) to the NGINX Ingress Controller. Features include:
  - Interactive YAML analyzer
  - 130+ annotation mappings
  - CRD migration examples
  - ConfigMap migration guidance

## Project Structure

This is a documentation-only project with **no build system and no package manager**. All pages are static HTML with first-party CSS/JS under `assets/` and no third-party runtime dependencies of any kind — including the webfont, which is self-hosted.

The site follows the **F5 Design System**, the design system behind the F5 Distributed Cloud console. `assets/css/tokens.css` is the whole design surface: every colour, size, space, radius, shadow and duration used anywhere resolves to a token declared there.

### Running it locally

Paths are relative, so opening `index.html` straight from the filesystem works. For a closer match to production:

```console
python3 -m http.server
```

Then open <http://localhost:8000>.

### Checks

There is no CI for these yet; run them before opening a pull request.

```console
python3 .github/scripts/check-tokens.py     # token invariants, retired colours, undefined var()
python3 .github/scripts/check-contrast.py   # every colour pairing against WCAG 2.1 AA, both themes
python3 .github/scripts/check-classes.py    # every class used by markup or JS resolves to a CSS rule
node    .github/scripts/test-analyzer.js    # the migration analyzer, under a DOM stub
```

Two of those are worth a word. `check-classes.py` matters most after a style change: a class that loses its rule does not error, the element just renders unstyled, which is invisible on a page with thousands of rows. And `test-analyzer.js` exists because `buildPlan` runs each CRD generator inside a `try/catch` that only warns — a broken generator silently drops its resource and the tool still looks like it worked, so the script counts `console.warn` rather than waiting for a thrown exception.

`AGENTS.md` holds the working spec every coding agent reads, with the detail in `.claude/skills/`: the design-system rules and their documented deviations, the migration tool's data-versus-presentation boundary, the version-accuracy rules and the release checklist.

## Contributing

Please see the [contributing guide](/CONTRIBUTING.md) for guidelines on how to best contribute to this project.

## License

[Apache License, Version 2.0](/LICENSE)

&copy; [F5, Inc.](https://www.f5.com/) 2026
