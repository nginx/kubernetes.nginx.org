
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
  - 130 annotation mappings
  - CRD migration examples
  - ConfigMap migration guidance

## Project Structure

This is a documentation-only project with **no build system and no package manager**. All pages are static HTML with first-party CSS/JS under `assets/` and no CDN or third-party runtime dependencies — including the webfont, which is self-hosted. The one exception is deliberate: the featured videos load poster images from `i.ytimg.com` and are click-to-play into `youtube-nocookie`, so nothing off-origin runs until a reader asks for it.

The site follows the **F5 Design System**, the design system behind the F5 Distributed Cloud console. `assets/css/tokens.css` is the whole design surface: every colour, size, space, radius, shadow and duration used anywhere resolves to a token declared there.

### Running it locally

Paths are relative, so opening `index.html` straight from the filesystem works. For a closer match to production:

```console
python3 -m http.server
```

Then open <http://localhost:8000>.

### Finding your way around

`ingress-nginx-migration.html` is 5,317 lines and its annotation tables alone run from line 457 to 3813, so scrolling for the row you want is slow by hand and expensive for an AI agent. The locator prints exact line ranges instead:

```console
python3 .github/scripts/where.py rewrite-target   # an annotation: mapping, CRD generator and reference row
python3 .github/scripts/where.py '#mappings'      # a section or heading anchor
python3 .github/scripts/where.py .version-pill    # a CSS class, every rule that defines it
python3 .github/scripts/where.py --list green     # matching design tokens, light and dark values
python3 .github/scripts/where.py filterTable      # a JS function
```

Add `-s` to print the lines as well as locate them. It exits non-zero when it finds nothing, so an empty result never passes for "not in this repo".

### Checks

CI runs all of these on every push and pull request, one step each, via [`.github/workflows/tests.yml`](/.github/workflows/tests.yml). Locally, one command runs the lot:

```console
python3 .github/scripts/check-all.py
```

It prints how many checks *ran* as well as how many passed — a check that silently does not run is the failure this project has recorded seven times. The individual checks, when you want one's full output:

```console
python3 .github/scripts/check-syntax.py     # every script parses (one `node --check` per file)
python3 .github/scripts/check-tokens.py     # token invariants, retired colours and typefaces, undefined var(), webfont coverage
python3 .github/scripts/check-contrast.py   # every colour pairing against WCAG 2.1 AA, both themes (-v for each measurement)
python3 .github/scripts/check-classes.py    # classes resolve to rules; load order, asset paths and navigation labels hold
python3 .github/scripts/check-versions.py   # every version string agrees with its source of truth
python3 .github/scripts/check-markup.py     # tag balance, duplicate ids, anchors, JSON-LD
node    .github/scripts/test-analyzer.js    # the migration analyzer, under a DOM stub
node --test .github/test/*.test.js          # page <-> engine <-> module wiring
python3 .github/scripts/where.py --self-test  # the locator's resolvers still match
```

A few are worth a word. The syntax check runs one file per invocation because `node --check` parses only its first argument and ignores the rest. `check-classes.py` matters most after a style change: a class that loses its rule does not error, the element just renders unstyled, which is invisible on a page with thousands of rows. `test-analyzer.js` exists because `buildPlan` runs each CRD generator inside a `try/catch` that only warns — a broken generator silently drops its resource and the tool still looks like it worked, so the script counts `console.warn` rather than waiting for a thrown exception. And the wiring suite catches breaks invisible to all of the above: an element id the engine queries but the page no longer has, a `data-action` with no handler, or scripts loading in the wrong order.

**None of them can see the rendered page**, so a green run means nothing is structurally broken — not that it looks right. To look:

```console
.github/scripts/shot.sh index.html                     # writes a PNG
.github/scripts/shot.sh index.html --dark
.github/scripts/shot.sh 'index.html#ingress2gateway'   # a specific view
```

Both pages are single-page apps, so without the `#anchor` you will screenshot the home view.

`AGENTS.md` holds the working spec every coding agent reads, with the detail in `.claude/skills/`: the design-system rules and their documented deviations, the migration tool's data-versus-presentation boundary, the version-accuracy rules and the release checklist.

## Contributing

Please see the [contributing guide](/CONTRIBUTING.md) for guidelines on how to best contribute to this project.

## License

[Apache License, Version 2.0](/LICENSE)

&copy; [F5, Inc.](https://www.f5.com/) 2026
