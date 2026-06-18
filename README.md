
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

This is a documentation-only project with no build system, tests, or package manager. All pages are self-contained HTML with inline CSS/JS and no external dependencies.

## Contributing

Please see the [contributing guide](/CONTRIBUTING.md) for guidelines on how to best contribute to this project.

## License

[Apache License, Version 2.0](/LICENSE)

&copy; [F5, Inc.](https://www.f5.com/) 2026
