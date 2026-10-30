---
name: site-audit
description: How to audit a migration tool end to end — the analyzer read against the source controller's own parsers, a value sweep checked against NGINX Ingress Controller's admission rules, the reference tables split across agents and checked against pinned source, severity settled on real binaries, and parity between the tools. Use when asked to audit a migration page, its analyzer or the CLI, or to compare two tools.
---

# Auditing a migration tool

The checks prove the site is structurally sound; they do not prove a word of it is
true. An audit is the other half: every claim and every generated value read
against the source of the controller it describes, at the pinned tags. The
2026-10-30 audit found an access-control bypass that had been live on this page
since its fix was "verified", on a site passing all nine checks. This file is
what that audit learned; follow it rather than improvising one.

## Before anything

- **Catch the branch up first.** On a `preview/**` branch, merge `main` (see
  AGENTS.md), then run `check-all.py`: a green baseline is what tells a later
  failure apart from an old one.
- **Get the sources local, at the pinned tags.** The source controller at the
  version in its `*_VERSION` constant, NGINX Ingress Controller at
  `MigrationTool.NIC.VERSION`, and, for the community controller,
  `controller-v1.15.1`. Shallow clones into `$CLAUDE_JOB_DIR/tmp/src/`; check
  each with `git describe`. Never answer from a default branch or from memory.
- **Check the pins are current.** A source several patches behind changes what
  "correct" means, and so does an NGINX Ingress Controller release past the pin
  (`release-update` covers a bump). `kubernetes/ingress-nginx` is archived and
  `controller-v1.15.1` is final, so only the NGINX Ingress Controller pin moves
  for it. Report a stale pin; re-targeting is its own job.

## The four layers

Each layer catches what the others cannot. Do them in this order, because the
analyzer layer changes the page's generated examples.

**1. The analyzer, against the source controller's parsers.** Read how the
source controller reads each value, not what its docs say: the bool parser
(ingress-nginx's is `strconv.ParseBool`, so `on` and `yes` are not booleans),
the time and integer parsers, and the gates (a setting that only fills in
another's rule — `auth-realm` without `auth-type` — did nothing). Then find what
happens to an **invalid** value, parser by parser: the Ingress rejected (a
`ValidationError`, such as an invalid `limit-rps`), the default kept, or the
whole setting dropped. A controller may read the same kind of value several
ways. The analyzer must migrate exactly what took effect, and say why for
everything else.

**2. A value sweep.** Every mapped key × a spread of values × both strategies,
checked against NGINX Ingress Controller's own validators (ported from
`internal/k8s/validation.go`, `pkg/apis/configuration/validation`, and the
ConfigMap parsers in `configmaps.go`). The spread must tell the readers apart:
`''`, `true`, `t`, `1`, `on`, `yes`, `0`, `-1`, `100abc`, `5 seconds`, `500us`,
an address list with one bad entry, a header value with a comma and one with a
colon. The permanent form is the sweep test in `analyzer.test.js` (and its
counterpart for each preview branch's source); extend it rather than writing a
one-off. Two things
it must also catch: a key that ends up neither written nor explained ("did not
say why"), and `http-snippets` content — the ConfigMap keys are validated and
ignored when wrong, but a snippet reaches `nginx.conf` unchecked and a bad line
fails the reload for every resource.

**3. The reference tables, against source.** Split the page by
`where.py --outline` line ranges, one read-only agent per slice of about 1,500
lines (four for a 6,500-line page), each briefed with the pinned source paths,
the four-point check from `migration-tool`, and "report only what you verified,
with file:line; list what you could not verify separately". Tell them the
analyzer is changing under them. **Give each a deadline**: unbounded, they
read for three hours; at three hours, ask for the report and the list of ranges
not reached, and cover those yourself. One agent also curls every external link.

**4. Parity between the tools.** Diff the source modules' `MIGRATION_SOURCE`
keys (a preview branch holds every source to `test-analyzer.js`'s CONTRACT,
which runs only ingress-nginx's),
the two pages' `--outline` for Getting started, the CLI under each `--source`
(`report` must name an unknown key, not only count it; source-specific advice
must name the right source), the e2e cases per source, the `verified:` tags,
and the rows one page offers both forms for and the other only one.

## Verify every finding before acting on it

Agent findings come back in the same confident tone whether right or wrong.
Before an edit, open the cited file:line yourself. Before calling something a
bug, establish what each side does; before calling it severe, establish what a
reader ships.

**Settle behaviour on the real binaries** when the source leaves it open —
`docker run nginx:<the version NGINX Ingress Controller ships>` (its
`build/Dockerfile`), and the source controller's own data plane where it has a
config check. Three traps from the 2026-10-30 audit:

- **`return` answers in the rewrite phase, before access checks.** A test
  location that `return 200`s passes every `allow`/`deny` test. Proxy to a
  backend instead.
- **Docker's port mapping hides the client address.** Set it per request with
  `set_real_ip_from 0.0.0.0/0; real_ip_header X-Test-IP;`, and run a control
  that must fail before trusting the result.
- **Test the addresses a security control must refuse, not only those it must
  admit.** The allow-plus-deny fix was verified with a denied address inside
  the allowed range (403) and the rest of the range (200), and never with one
  outside it — which got 200. A location with access rules of its own inherits
  none from its server.

## Fixing

- **The generator is the source of truth** (`migration-tool`): fix the analyzer,
  then the example; `where.py --diff` shows the drift. A Policy in an example is
  context and is not compared, so an `sslName` missing from one goes unseen —
  read those by hand.
- **Watch every new assertion fail.** Plant the old behaviour, see the test
  report it, restore, and compare byte for byte. If a plant "passes", first
  check the test edit landed: an `Edit` on a file not yet `Read` this session
  fails, and the plant then runs against no test.
- **A defect shared with `main` is fixed on `main`.** The audit of a preview
  page will find bugs in the engine or page the tools share; fix them on
  production `main` in their own commit and merge `main` into the branch,
  never port by hand. A security defect in live output is reported at once.
- **Commit per theme**, not per finding: the commit body lists what each
  finding was and how it was checked, and names the plants.

## Reporting

Lead with what a migrator would ship broken, then what misleads, then minor.
Say which findings were verified and how (source, binary, both), which were
left unverified and why, what was out of reach, and what is unpushed in which
repository. Nothing is pushed without being asked: pushing `main` deploys.
