# nic-migrate

> **Beta.** New and under active development. Review its output before applying
> anything to a cluster — command names, flags, and the manifests it generates
> may still change. What it *does* report, it reports honestly: nothing is
> dropped silently, and every construct it cannot express on the chosen target
> is named. That is the part to rely on while the rest settles.

Batch the migration tool's analyzer over real Ingress manifests, from a terminal.

The web tool at [kubernetes.nginx.org/ingress-nginx-migration.html](https://kubernetes.nginx.org/ingress-nginx-migration.html)
analyzes one paste at a time. This runs the *same* engine — same 57 mapping
entries, same ~130 annotations, same value transforms, same CRD generators —
over a directory of manifests or a live cluster, one Ingress document at a time,
and adds the thing a paste box cannot: a per-Ingress account of what the
engine's single-context model left behind.

It reads the mapping database out of `assets/js/` rather than vendoring a copy,
so it cannot drift from the published page. Run it from a checkout.

```bash
# What would change, and what the analyzer cannot do on its own
node tools/nic-migrate/nic-migrate.js report -f ./manifests
node tools/nic-migrate/nic-migrate.js report --kubectl -n prod

# Merged, applyable manifests
node tools/nic-migrate/nic-migrate.js convert -f ./manifests --validate
node tools/nic-migrate/nic-migrate.js convert -f ./in --target ingress -o ./out

node tools/nic-migrate/nic-migrate.js checklist
```

Zero dependencies. Node 18+.

## Two commands, and why both exist

`report` shows you the analyzer's own output — one single-feature illustration
per annotation — and names everything those illustrations leave out. Use it to
understand a workload.

`convert` merges them into manifests you can apply. Use it to migrate one.

The split matters because the engine and the converter know different things:

> the engine supplies correct NIC **values** — `limit-rps: 5` becomes `rate: 5r/s`
> with a burst, `affinity: cookie` becomes a `sessionCookie` block
>
> the converter supplies correct **structure** — one resource per host, every
> route, every backend, Policies wired in, TLS and namespace kept

Nothing re-implements a mapping. Each generated resource is parsed back into
data, its distinguishing fragment is lifted out, and the fragment is grafted
onto a resource built from the real Ingress spec. Fix a mapping on the page and
it is fixed here on the next run.

## report is advisory, on purpose

**Do not apply this output unreviewed.** The engine was written to teach one
annotation at a time, and its shape follows from that:

- `parseInput` keeps **one** host, service, path and TLS secret. A two-path
  Ingress produces output covering the first path only.
- Every CRD generator emits a **self-contained illustration**. `rewrite-target`
  plus `affinity` yields *two* VirtualServers that both claim the same host —
  apply both and NIC accepts one and rejects the other.
- Policies are generated but the reference to them is only ever a comment.
- `namespace`, `ingressClassName` and `spec.tls` are read but not carried into
  any generated resource.

None of that is a bug in the page; it is the right shape for a reference tool
and the wrong shape for a file you would `kubectl apply`. So rather than paper
over it, `nic-migrate` reports it. Every one of those conditions is a named gap:

| Severity | Meaning |
|---|---|
| `blocking` | Would be rejected, or would lose traffic, if applied as-is |
| `review` | Needs a human decision |
| `note` | Informational |

`--strict` exits non-zero when any `blocking` gap is found, so this is usable as
a CI gate on a migration branch.

### Gaps it detects

`generator-warning` · `hosts-dropped` · `paths-dropped` · `backends-dropped` ·
`host-conflict` · `policy-unwired` · `namespace-dropped` · `tls-dropped` ·
`class-dropped` · `todo-placeholders` · `unsupported` · `unrecognized` ·
`snippet-passthrough`

`generator-warning` is the load-bearing one. `buildPlan` runs each generator in
a `try`/`catch` that only `console.warn`s, so a broken generator **drops its
resource** and the analysis still looks successful. A thrown exception is not
the failure signal — a captured warning is.

## Options

```
Input (both commands; defaults to stdin)
  -f, --file <path>        YAML file, or a directory scanned for .yaml/.yml.
                           Repeatable.
  -k, --kubectl            Read live Ingresses with kubectl.
  -n, --namespace <ns>     Namespace for --kubectl (default: all namespaces).
  -s, --strategy <name>    crd | annotation
  -o, --out <dir>          Write per-Ingress files instead of stdout.
      --json               Emit JSON.
      --no-color           Disable ANSI colour (also honours NO_COLOR).

report
      --strict             Exit 1 if any blocking gap was found.

convert
  -t, --target <kind>      virtualserver | ingress     (default: virtualserver)
      --class <name>       Set ingressClassName on the output.
      --validate           Check the output with kubectl apply --dry-run.

checklist                  Print the 22-item migration checklist, read live
                           from the published page.
```

### convert targets

**`--target virtualserver`** (default) emits one merged VirtualServer per host:
every path becomes a route, every distinct backend an upstream, Policies are
referenced from `spec.policies`, and TLS, namespace and `ingressClassName` are
carried over.

**`--target ingress`** keeps the Ingress resource and rewrites its annotations
to `nginx.org/*`, adding `nginx.org/policies` for anything that needs a Policy.
Lower-risk and enough for a large share of real workloads, because NIC reads
standard `networking.k8s.io/v1` Ingress. It defaults to `--strategy annotation`,
since asking for an Ingress and then running the CRD-first strategy produces
fragments an Ingress cannot carry.

Anything the chosen target cannot represent is reported as a note rather than
dropped — including a `$n` rewrite that would be copied onto a path with no
capture group, which is faithful to the community annotation and almost never
what anyone meant.

### --validate

Runs `kubectl apply --dry-run=server`, which is the check that catches a CRD
that is not installed. If no cluster is reachable it reports **validation did
not run** and exits non-zero, rather than reporting a pass: `--dry-run=client`
needs server discovery to recognise a kind, so it fails on every VirtualServer
and there is no weaker kubectl mode to fall back to. A local structural check
runs instead, and is labelled as the much weaker thing it is.

## Layout

```
nic-migrate.js      CLI: argument parsing, input gathering, output, validation
lib/engine.js       Boots the site's analyzer headless via .github/test/lib/load.js
lib/ingress.js      Document splitting and the Ingress scanner (report only)
lib/gaps.js         The gap checks (report only)
lib/render.js       Text report, JSON, and the -o file header
lib/yaml.js         YAML subset parser and emitter (convert only)
lib/convert.js      Ingress model, fragment lifting, resource assembly
```

`lib/ingress.js` is a scanner and `lib/yaml.js` is a parser, and the split is
deliberate: everything the scanner reads ends up in an advisory sentence, so
approximation is acceptable there and not in the converter, where values have to
round-trip into manifests.

Tests are at `.github/test/nic-migrate.test.js` — under `.github/` so Pages does
not serve them, and picked up by the existing `node --test` suite. The tool
itself is excluded from the published site by `_config.yml` at the repo root.

`lib/engine.js` depends on `.github/test/lib/load.js` deliberately: one loader,
so a change to how the engine boots breaks the CLI loudly at startup instead of
leaving a vendored copy to age quietly.

## About the YAML implementation

`lib/yaml.js` is a subset parser and emitter, cross-checked against PyYAML on
realistic manifests and fuzzed over ~5,000 random round-trips. Two bugs came out
of the fuzzing and neither would have been found by reading: `- - k: v` parsed
as a key literally named `- k`, and `- "x: y"` parsed as the mapping
`{'"x': 'y"'}` because the key pattern backtracks into the quoted scalar.

Anchors, aliases, merge keys and tags are **refused with an error**, not
silently dropped. No Kubernetes manifest in the wild needs them, and
half-supporting them is worse than declining.

Considered and rejected: shelling out to `kubectl create --dry-run=client -o
json` to borrow kubectl's parser. It is the more correct parser, but it makes
kubectl a hard requirement for reading a file off disk, and it cannot emit — so
an emitter would have had to be written regardless.

One emitter rule is worth knowing: any scalar starting with a digit, `+`, `-` or
`.` is quoted. Under-quoting is a correctness bug and over-quoting is cosmetic —
`0755` read by a YAML 1.1 parser, which is what Kubernetes uses, is the integer
493.

## End-to-end test

`e2e/run-e2e.py` proves the conversion on a real cluster, in **four stages**.
Each isolates a different failure mode, so a red run tells you which layer broke
rather than only that something did:

| Stage | What it establishes |
|---|---|
| `baseline` | ingress-nginx alone serves the fixture. Every case checked against its own expectations — if this fails, it's the fixture or ingress-nginx, and nothing downstream means anything. |
| `nic-installed` | NIC is deployed and answering *before any converted resource exists*: CRDs present, controller returns 404 from its default server. Separates an install problem from a conversion problem. |
| `converted` | Both controllers serve at once. NIC matches the recorded baseline — **and ingress-nginx is re-checked**, because a migration must not disturb what is still live. |
| `cutover` | The community Ingress is deleted and ingress-nginx is uninstalled. The run proves the old controller no longer answers at all, then asserts NIC alone still matches the stage-1 baseline. |

`--until <stage>` stops after any of them and leaves the cluster up, which is
the debugging entry point.

Every stage after the first compares against the **recorded** stage-1 baseline,
not against literals — so what is asserted is "NIC does what ingress-nginx was
observed to do", which is the thing a migration promises.

```bash
# Needs nothing — no cluster, no Docker. Checks the runner's own logic.
python3 tools/nic-migrate/e2e/run-e2e.py --self-test

# Build a throwaway kind cluster, run all four stages, delete it
python3 tools/nic-migrate/e2e/run-e2e.py
python3 tools/nic-migrate/e2e/run-e2e.py --keep            # ...but leave it up to poke at

# Stop at a checkpoint to debug (implies --keep)
python3 tools/nic-migrate/e2e/run-e2e.py --until baseline       # is the fixture sane?
python3 tools/nic-migrate/e2e/run-e2e.py --until nic-installed  # did NIC come up?
python3 tools/nic-migrate/e2e/run-e2e.py --until converted      # skip the cutover

# Use a cluster you already have (minikube, k3d, Docker Desktop, remote)
python3 tools/nic-migrate/e2e/run-e2e.py --skip-cluster
python3 tools/nic-migrate/e2e/run-e2e.py --skip-cluster --target ingress
```

### Same runner locally and in CI

`.github/workflows/e2e.yml` does not orchestrate anything — it installs `kind`
and calls the identical script. There is no CI-only path to drift out of sync
with the local one, which is why the workflow does *not* use a
cluster-provisioning action to create the cluster on its behalf.

Needs `kubectl`, `helm`, `node` and `openssl`, plus `kind` and `docker` unless
you pass `--skip-cluster`. Preflight names anything missing before doing any
work, and if you already have a reachable cluster it says so and points at
`--skip-cluster` rather than telling you to install kind.

CI runs it on changes to this tool or the engine, on demand, and weekly to catch
upstream drift in ingress-nginx or NIC rather than in our own code.

**The assertion is equivalence, not a hardcoded expectation.** Each case goes to
both controllers and the answers are compared. Asserting "NIC returns
`/things/42`" would bake in today's belief about how `rewritePath` handles a
capture group; asserting "NIC returns whatever ingress-nginx returned" is what a
migration actually promises. When they differ, **the difference is the finding**.

The backends are `nginx:alpine` with a ConfigMap that echoes the URI the backend
received — a rewrite is only observable from the backend's side, so that echo is
what makes the most important case checkable at all. Requests come from a pod
inside the cluster aimed at each controller's ClusterIP Service, which is what
lets both controllers run at once with no hostPort or NodePort collision.

Cases cover host routing, path routing, the rewrite, the second host, an unknown
host, the CORS header, the affinity cookie, TLS termination, and that plain HTTP
is *not* redirected (the fixture sets `ssl-redirect: "false"`, so the converter
must not add `tls.redirect`).

Three unit tests in `.github/test/nic-migrate.test.js` guard the fixtures
against drift without needing a cluster — a Service renamed in `workload.yaml`
while `source-ingress.yaml` still points at the old name would otherwise surface
as a 503 that looks like a migration bug.

Scope is **NGINX OSS**. Everything asserted is satisfiable without a
subscription. A case that has no equivalent on a target is printed as `skip`
with its reason rather than dropped, so the count never quietly shrinks.

### What the first real run found

All three of these are now handled by `convert`, and none was predicted — they
came from running it:

- **NIC matches Ingress paths literally.** The community controller treats an
  `ImplementationSpecific` path containing regex metacharacters as a regex; NIC
  needs `nginx.org/path-regex`. Without it `/api(/|$)(.*)` matched nothing and
  every `/api/...` request fell through to the catch-all `/` — returning `200`
  from the *wrong backend*. A silent routing change is the worst shape a
  migration bug can take, and no dry-run would have caught it.
- **NIC rejects snippets by default.** `enableSnippets` is off, and an Ingress
  using `nginx.org/server-snippets` is *rejected outright* rather than degraded:
  `snippet specified but snippets feature is not enabled`. The annotation
  strategy converts CORS into snippets, so `--target ingress` needs
  `helm --set controller.enableSnippets=true`.
- **Session affinity has no Ingress annotation form.** It maps to VirtualServer
  `upstreams[].sessionCookie`, which works fine on OSS — but there is no
  `nginx.org/*` equivalent, so `--target ingress` loses stickiness silently.

And the question the pipeline existed to answer: **`rewritePath` handles `$2`
captures identically to the community `rewrite-target`.** Both controllers
return `/things/42` for `/api/things/42`. That was a guess before; it is a
measurement now.

## What is still manual

- **Canary and traffic splitting.** `splits`/`matches` need the *other* Ingress
  to be known; a single-resource converter cannot infer it.
- **Snippets.** Carried across verbatim and never validated. Directives valid in
  the community controller may not be valid in the same context under NIC.
- **NGINX Plus features** (JWT, OIDC, WAF) have no community equivalent to
  convert *from* — they are additions, not migrations. Note that session
  affinity is *not* in this group: `sessionCookie` works on OSS.
- **The controller install itself.** `checklist` prints the steps; installing
  CRDs and running both controllers side by side is a cluster operation this
  tool deliberately does not perform.
