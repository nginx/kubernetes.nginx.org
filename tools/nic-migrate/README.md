# nic-migrate

Run the migration tool's analyzer over real Ingress manifests, from a terminal:
ingress-nginx by default, or HAProxy or Traefik with `--source`.

> **Beta.** Review the output before you apply anything to a cluster. Command
> names, flags, and the manifests it generates may still change.

The web tools at
[kubernetes.nginx.org/ingress-nginx-migration.html](https://kubernetes.nginx.org/ingress-nginx-migration.html)
and [haproxy-migration.html](https://kubernetes.nginx.org/haproxy-migration.html)
analyze one paste at a time. `nic-migrate` runs the same engine over a
directory of manifests or a live cluster: the same YAML parser, mappings,
value transforms and assembly, read out of `assets/js/` instead of vendored,
so it cannot drift from the published page. Run it from a checkout.

No dependencies. Node 18 or newer. `kubectl` is needed only for `--kubectl`
and `--validate`.

## Getting started

```bash
# What would change, and what the analyzer cannot work out on its own
node tools/nic-migrate/nic-migrate.js report -f ./manifests
node tools/nic-migrate/nic-migrate.js report --source haproxy -f ./manifests
node tools/nic-migrate/nic-migrate.js report --source traefik --whole-input -f ./crs
node tools/nic-migrate/nic-migrate.js report --kubectl -n prod

# Manifests you can apply
node tools/nic-migrate/nic-migrate.js convert -f ./manifests --validate
node tools/nic-migrate/nic-migrate.js convert -f ./in --target ingress -o ./out
node tools/nic-migrate/nic-migrate.js convert --source haproxy --kubectl --class nginx-nic

# The migration checklist, read live from the source's page
node tools/nic-migrate/nic-migrate.js checklist
node tools/nic-migrate/nic-migrate.js checklist --source haproxy
```

`report` summarises what each Ingress becomes and what still needs a person.
Use it to understand a workload. `convert` writes the same resources as
manifests. Use it to migrate one.

## Sources

`--source` picks which of the site's analyzers to run. The mapping data, value
transforms and generators all come from `assets/js/`, so the CLI reports exactly
what the matching page reports.

| | ingress-nginx | haproxy | traefik |
|---|---|---|---|
| module | `assets/js/migration-ingress-nginx.js` | `assets/js/migration-haproxy.js` | `assets/js/migration-traefik.js` |
| page (`checklist`) | `ingress-nginx-migration.html` | `haproxy-migration.html` | `traefik-migration.html` |
| annotation prefixes | `nginx.ingress.kubernetes.io/` | `haproxy.org/`, `haproxy.com/`, `ingress.kubernetes.io/` | `traefik.ingress.kubernetes.io/` |
| kinds read | Ingress | Ingress, Service, ConfigMap, and the Global / Defaults / Backend / Frontend / TCP / ValidationRules CRs | Ingress, IngressRoute(+TCP/UDP), Middleware(+TCP), TraefikService, TLSOption, TLSStore, ServersTransport(+TCP) |
| `--kubectl` reads | `ingress` | `ingress`, `service`, `configmap` and each HAProxy CRD, v3 and v1; a CRD not installed is skipped with a note | `ingress` and each `traefik.io` CRD; a CRD not installed is skipped with a note |

The kinds column is the substantive difference, and the three sources sit at
different points on it. ingress-nginx keeps every setting on the Ingress, so an
Ingress-only scan sees all of it. HAProxy spreads the same job across annotated
Ingress **and Service** objects, its controller ConfigMap and five CRs. Traefik
inverts that: one annotation prefix, and almost everything real in CRs. A scan
that only looked at Ingresses would report "nothing found" on either.

Traefik's static configuration is deliberately not in that list: it is CLI flags
or a `traefik.yml`, not a Kubernetes object, so there is no kind to gate on. The
page documents it; the CLI cannot read it.

### `--whole-input`

By default `report` gives one entry per resource. Each is analyzed with the rest
of the run as context, so a Traefik `IngressRoute` resolves the `Middleware`
documents it references, and a HAProxy Ingress reads its Services, ConfigMap and
CRs. `--whole-input` analyzes everything as one unit instead, the way the web
tool treats a paste, and reports it as one entry. `convert` ignores it.

Both commands migrate one Ingress at a time, and for HAProxy resolve it the
way the controller does: a backend setting from the Service the path routes
to, then the Ingress, then the ConfigMap; a `cr-backend` Backend replaces the
backend annotations of the Service it is named on; a Global or Defaults CR
applies only when the ConfigMap names it in `cr-global` / `cr-defaults`. What
HAProxy applies to the whole controller (ConfigMap-only keys, the CRs,
`tcp-services`) is written once: its keys join the `nginx-config` merge
document, and its GlobalConfiguration and TransportServers are one more
output, `controller`.

Adding a source is one entry in `lib/sources.js` plus a module in `assets/js/`;
`convert` also needs the module to export `migrate` and `migrateMany`.

## Reading a report

```
nic-migrate — advisory report · strategy: crd

e2e-shop/shop  (shop.example.com, b.example.com)
  9 annotations found · 6 migration paths · 3 require CRDs · complexity moderate

  Resources
    Policy/shop-cors
    VirtualServer/shop  host shop.example.com
    VirtualServer/shop-b  host b.example.com
  note: spec.ingressClassName — Set spec.ingressClassName to the NGINX Ingress Controller class ...
  note: cors-allow-headers — Dropped DNT, Keep-Alive from allowHeaders: browsers send these ...

────────────────────────────────────────────────────────────
1 Ingress · 1 with community annotations · 0 blocking · 0 review · 0 note
```

Each Ingress becomes complete resources: under CRD-first one VirtualServer per
host carrying every route, backend, TLS secret, Policy reference and snippet;
under annotation-first the migrated Ingress. Every recognised annotation is
either in the output, with a trailing comment naming it, or in a note saying
why not. Gaps are what a person still has to decide:

| Severity | Meaning |
|---|---|
| `blocking` | Would be rejected, or would lose traffic, if applied as-is |
| `review` | Needs a human decision |
| `note` | Informational |

`--strict` exits non-zero when any `blocking` gap is found, which makes this
usable as a CI gate on a migration branch.

The gaps: `generator-warning`, `needs-attention`, `todo-placeholders`,
`snippet-passthrough`, `unsupported`, `unrecognized`, `class-dropped`; and,
as a guard on the assembly itself, `hosts-dropped`, `backends-dropped`,
`host-conflict`, `policy-unwired` and `tls-dropped`, which compare the source
Ingress with the generated resources.

Watch `generator-warning` in particular. Each translator runs in a
`try`/`catch` that only calls `console.warn`, so a broken one drops its part of
the output while the analysis still looks successful. The failure signal is a
captured warning, not a thrown exception, and both commands exit non-zero on it.

## Converting

`--target virtualserver` (the default) emits one merged VirtualServer per host.
Every path becomes a route, every distinct backend an upstream, Policies are
referenced from `spec.policies`, and TLS, namespace, and `ingressClassName` are
carried over.

NGINX Ingress Controller gives a host to one resource, so every host in the
output has exactly one. An Ingress that routes several hosts is split into one
per host, with a note. A host that several Ingresses of a run share becomes one
VirtualServer with every Ingress's routes: each keeps its own upstreams, and
its Policies go on its own routes (with `--target ingress`: one Ingress with
every path, which makes each Ingress's settings apply to the whole host, and
the notes name each one). Routes are ordered as the community controller tried
them, which matters once an Ingress on the host uses `rewrite-target` or
`use-regex`. The merged resource is written into the file of the Ingress listed
first. The tool never emits VirtualServerRoutes or mergeable minion Ingresses:
they give each team its own resource, but need setting up by hand. Where the Ingresses set a
host-wide value differently, the oldest Ingress's is kept, as the community
controller kept it, and a note says so. `report` analyzes each Ingress alone
and flags the shared host as a `shared-host` gap.

`--target ingress` keeps the Ingress resource and rewrites its annotations to
`nginx.org/*`, adding `nginx.org/policies` for anything that needs a Policy.
It is lower risk and enough for many real workloads, because NGINX Ingress
Controller reads standard `networking.k8s.io/v1` Ingress. It defaults to
`--strategy annotation`, since asking for an Ingress and then running the
CRD-first strategy produces fragments an Ingress cannot carry.

Custom error pages differ by target. `--target ingress` keeps
`nginx.org/custom-http-errors` and turns `default-backend` into
`spec.defaultBackend`, which is where NIC sends the errors. The port comes from
the Service when run with `--kubectl`, and is otherwise left as a reported
placeholder. `--target virtualserver` emits `errorPages`, which can only return
a canned body or redirect, and says so.

Anything the chosen target cannot represent is reported as a note rather than
dropped. That includes a `$n` rewrite on a path with no capture group, which
is faithful to the community annotation and almost never intended.

Nothing here re-implements a mapping: `convert` calls the assembler the page
uses (`source.analyzer.migrate`). Fix a mapping on the page and it is fixed
here on the next run.

`--validate` runs `kubectl apply --dry-run=server`, which is the check that
catches a CRD that is not installed. With no cluster reachable it reports that
validation did not run and exits non-zero, rather than reporting a pass.
`--dry-run=client` needs server discovery to recognize a kind, so it fails on
every VirtualServer, and kubectl has no weaker mode to fall back to. A local
structural check runs instead, labelled as the weaker thing it is.

Run `nic-migrate.js --help` for the full option list. One flag is worth knowing
about before a side-by-side run: with `--target ingress`, the output reuses the
source's name. Applying it replaces the Ingress you are migrating. Pass
`--name-suffix` to write a separate resource instead.

## What is still manual

- **Canary Ingresses on their own.** A canary Ingress names only the canary
  Service. Pass its main Ingress in the same run (same namespace, host and
  path) and the two become one VirtualServer; alone, the stable side is a
  reported placeholder.
- **Snippets.** Carried across as written and never validated. Directives from
  modules the community image included (`more_set_headers`, Lua) do not exist
  in NGINX Ingress Controller and fail the reload; the analyzer names them.
- **NGINX Plus features** (JWT, OIDC, WAF) have no community equivalent to
  convert from. They are additions, not migrations.
- **The controller install.** `checklist` prints the steps. Installing CRDs and
  running both controllers side by side is a cluster operation this tool does
  not perform.
- **ConfigMap keys.** Settings that are global in NGINX Ingress Controller come
  out as `nginx-config.merge.yaml` (or a last document on stdout): keys to merge
  into your `nginx-config`, not a ConfigMap to apply over it.

## Layout

```
nic-migrate.js      CLI: argument parsing, input gathering, output, validation
lib/sources.js      One entry per source: module path, kinds read, CLI strings
lib/engine.js       Boots the site's analyzer headless through .github/test/lib/load.js
lib/ingress.js      Reads Ingresses (List and IngressList items too) and describes them
lib/gaps.js         The gap checks (report only)
lib/render.js       Text report, JSON, and the -o file header
lib/yaml.js         Hands over the site's YAML parser and emitter (MigrationTool.yaml)
lib/convert.js      Runs the shared assembler per Ingress; fills ports from the cluster
```

`lib/engine.js` and `lib/yaml.js` depend on `.github/test/lib/load.js` on
purpose. One loader means a change to how the engine boots breaks the CLI at
startup, instead of leaving a vendored copy to age quietly.

Tests live at `.github/test/nic-migrate.test.js` and
`.github/test/analyzer.test.js`, under `.github/` so Pages does not serve them,
and picked up by the existing `node --test` suite. `_config.yml` at the repo
root keeps `tools/` off the published site.

### About the YAML parser

It lives in `assets/js/migration-core.js` so the page and the CLI read a
manifest the same way; it replaced both the page's line scanner and this
tool's own parser. It folds plain and quoted scalars across lines (kubectl
wraps long annotation values), decodes escapes, and refuses rather than skips:
anchors, aliases, merge keys, non-standard tags, tab indentation, and any line
it did not use are errors that name the line. It matches PyYAML on every
manifest the migration page shows and on 3,000 generated documents.

Considered and rejected: shelling out to `kubectl create --dry-run=client -o
json` to borrow kubectl's parser. It is the more correct parser. But it makes
kubectl a hard requirement for reading a file off disk, and it cannot emit, so
an emitter would have been needed anyway.

One emitter rule is worth knowing: any scalar starting with a digit, `+`, `-`,
or `.` is quoted. Under-quoting is a correctness bug and over-quoting is
cosmetic. `0755` read by a YAML 1.1 parser, which is what Kubernetes uses, is
the integer 493.

## End-to-end test

`e2e/run-e2e.py` proves the conversion on a real cluster in four stages. Each
isolates a different failure mode, so a red run tells you which layer broke.

| Stage | What it establishes |
|---|---|
| `baseline` | ingress-nginx alone serves the fixture, each case checked against its own expectations |
| `nic-installed` | NGINX Ingress Controller is deployed and answering before any converted resource exists |
| `converted` | Both controllers serve at once, and ingress-nginx is re-checked, because a migration must not disturb what is still live |
| `cutover` | The community Ingress is deleted, ingress-nginx is uninstalled, and NGINX Ingress Controller alone still matches the baseline |

```bash
# Checks the runner's own logic. No cluster, no Docker.
python3 tools/nic-migrate/e2e/run-e2e.py --self-test

# Throwaway kind cluster, all four stages, then delete it
python3 tools/nic-migrate/e2e/run-e2e.py
python3 tools/nic-migrate/e2e/run-e2e.py --keep          # leave it up to poke at

# Stop at a checkpoint to debug (implies --keep)
python3 tools/nic-migrate/e2e/run-e2e.py --until baseline

# Use a cluster you already have
python3 tools/nic-migrate/e2e/run-e2e.py --skip-cluster

# The HAProxy Kubernetes Ingress Controller as the source, either target
python3 tools/nic-migrate/e2e/run-e2e.py --source haproxy
python3 tools/nic-migrate/e2e/run-e2e.py --source haproxy --target ingress

# Traefik Proxy as the source, either target
python3 tools/nic-migrate/e2e/run-e2e.py --source traefik
python3 tools/nic-migrate/e2e/run-e2e.py --source traefik --target ingress
```

Needs `kubectl`, `helm`, `node`, and `openssl`, plus `kind` and `docker` unless
you pass `--skip-cluster`. Preflight names anything missing before doing any
work.

With `--source haproxy` the stages are the same, with HAProxy in ingress-nginx's
place. The fixture is `manifests/haproxy-source.yaml`: the Ingress, the
annotated Services HAProxy reads backend settings from, and the controller
ConfigMap, which the runner sets through the chart (`HAPROXY_CONFIG`) instead
of applying it. The chart's image tag must match `HAPROXY_APP_VERSION` unless
you pass `--source-chart`.

With `--source traefik` the fixture is `manifests/traefik-source.yaml`:
Middlewares and IngressRoutes on the same two hosts and three backends. The
runner installs the chart with the image tag `TRAEFIK_APP_VERSION`, which
`check-versions.py` holds to the release the Traefik guide is written against.
An IngressRoute has no Ingress form, so `--target ingress` still converts it to
a VirtualServer. One case is a known difference: Traefik serves a route with
`tls` over HTTPS only and answers plain HTTP with 404, while the VirtualServer
serves both (the analyzer says so and offers `tls.redirect`).

CI runs every source.

Every stage after the first compares against the recorded stage-1 baseline
rather than against literals. The assertion is equivalence: each case goes to
both controllers and the answers are compared. Asserting "NGINX Ingress
Controller returns `/things/42`" would bake in today's belief about how
`rewritePath` handles a capture group. Asserting "it returns whatever
ingress-nginx returned" is what a migration promises. Differences are reported
as findings.

`.github/workflows/e2e.yml` installs `kind` and calls the same script, so there
is no CI-only path to drift out of sync. CI runs it on changes to this tool or the
engine, on demand, and weekly. The weekly run is there to catch upstream drift
in ingress-nginx or NGINX Ingress Controller rather than in our own code.

Scope is NGINX Open Source. A case with no equivalent on a target prints as
`skip` with its reason rather than being dropped, so the count never quietly
shrinks.

### What the real runs found

All of these are now handled by `convert` and by the page.

- **Ingress paths are matched literally.** With `rewrite-target` or
  `use-regex`, the community controller makes every path on the host a
  case-insensitive regex. NGINX Ingress Controller matches Ingress paths
  literally unless told otherwise: without `nginx.org/path-regex`,
  `/api(/|$)(.*)` matched nothing and every `/api/...` request fell through to
  the catch-all `/`, returning 200 from the wrong backend. No dry run would
  have caught it.
- **Regex routes need the community order and case rules.** NGINX takes the
  first regex location that matches, and NIC writes VirtualServer routes in
  order, so they are sorted longest first, as the community controller sorted
  its paths. A route of `~ (?i)^/api…` keeps `/API/x` rewritten; `~* ^/api…`
  matched it and then skipped NIC's case-sensitive rewrite.
- **Snippets are rejected by default.** `enableSnippets` is off, and a resource
  using snippets is rejected outright rather than degraded: `snippet specified
  but snippets feature is not enabled`. The pipeline installs with
  `--set controller.enableSnippets=true`.

The pipeline also answered the question it was built for: `rewritePath` handles
`$2` captures the same way the community `rewrite-target` does. Both
controllers return `/things/42` for `/api/things/42`.

The HAProxy runs found three more, each now a unit test in
`.github/test/conversions.test.js`:

- **A `path-rewrite` regex route on `/` took longer prefixes.** HAProxy picks
  the longest matching path first, then rewrites; the converted `/` route
  matched `/api/...` too. Each such route now excludes the host's longer
  prefixes with a lookahead.
- **A path whose only backend carries a `route-acl` was dropped.** HAProxy adds
  no path-map entry for it, so requests the ACL does not match get its default
  backend, a 404. The converted route now answers 404 unless the match holds.
- **A canary leg applied to every route on the host.** HAProxy tests the
  canary's own path (`{ path -m beg }`), so a leg is now scoped to routes
  under it.

With `--target ingress`, three cases skip with their reason: the two that test
a two-field `path-rewrite`, whose captures `nginx.org/rewrite-target` cannot
keep, and the header canary, since an Ingress has no match annotation. The
analyzer says to use CRD-first for both.
