---
description: The full audit of the site from several engineers' perspectives: seven read-only agents in parallel (front-end JS, tooling and CI, AI-assisted development, frontend rendering, UX and accessibility, hands-on QA in a browser, content accuracy as the end user), consolidated into one AUDIT report beside the repo.
argument-hint: "[scope, e.g. haproxy or content]"
disable-model-invocation: true
---

# Auditing the site from several perspectives

When the maintainer asks for an audit, this is what they mean: the 2026-10-09
run, which read the whole site as six kinds of engineer and an end user and
wrote `../AUDIT-kubernetes.nginx.org-2026-10-09.md` (one directory above the
repo). Read that file before starting a new one: it is the template, and its
findings are the baseline the new one is compared against.

It is the heaviest thing done here, seven agents for an hour or more, so it
runs only as `/site-audit`, typed by the maintainer: `disable-model-invocation`
keeps it out of the model's reach. Never reproduce it, or any lens of it, to
finish an adjacent task.

Scope for this run: $ARGUMENTS. When given, audit that surface (a preview
branch's tool, one lens) and say what was left out; when empty, the whole
site.

## The lenses

One agent per lens, all launched in one message so they run in parallel:

| Lens | Reads as | Hunts for |
|---|---|---|
| Front-end JS | senior software engineer | bugs, security, robustness in `assets/js/` and `tools/nic-migrate/` |
| Tooling, CI, checks | software/QA engineer | the nine checks, the test suites, the workflows: what passes while measuring nothing (plant faults in a copy) |
| AI-assisted development | AI engineer | stale claims in AGENTS.md and the skills, where.py misses, recipes that report success when nothing ran, token cost per session |
| Frontend rendering | senior frontend engineer | layout, CSS architecture, performance, F5DS conformance (`f5ds-design` deviations are not defects) |
| UX and accessibility | UX engineer and accessibility specialist | keyboard path, focus, contrast the checks cannot see, forced colors, naming and capitalisation |
| Hands-on QA | QA engineer in a real browser | functional and exploratory testing of every view, with console errors and failed requests captured |
| Content accuracy | the end user migrating, plus a domain expert | whether what the site says is true at the pinned upstream tags; the user's journey; external links |

Add a lens when the site grows one: a preview branch's tool gets its own
content-accuracy agent. Brief the content-accuracy agents with
`migration-tool`'s four-point check and its "Settling what a controller does",
the pinned source tags as local clones, and a slice of the page each (split by
`where.py --outline`, ~1,500 lines per agent) with a deadline.

## The brief every agent shares

- **Read-only on the repo.** No edits, no new files in it, no state-changing
  git command. Scratch in `/tmp/audit-<lens>/`; copy the repo there to plant
  faults.
- **Read AGENTS.md first**, then the skills its lens needs (`verify-visually`
  to render, `f5ds-design` before calling anything a design defect,
  `migration-tool` for the engine recipe, `repo-checks` for the checks), and
  the F5 skill packs in `~/.claude/skills/` for design and naming facts,
  never from memory.
- **Never read the migration page or its source module whole**: `where.py`.
- **Separate ports per agent** (`SHOT_PORT`, the `http.server` port and the CDP
  port), since they render at once; kill everything started before finishing.
- **Already known, do not re-report**: list what the last audit and the
  current state already establish, so seven agents do not rediscover it.
- **Verify every finding with evidence**; drop what cannot be confirmed or
  mark it UNVERIFIED. No style nits, no generic advice. Do not recommend notes
  that a feature also works on NGINX Open Source: parity is the default.
- **Report format**, final message only, under ~2,000 words: per finding a
  severity (critical: a user ships broken or unsafe config; high; medium; low;
  enhancement), where (path:line), what is wrong with the evidence, the
  impact, the fix, and confidence.

## Consolidating

When all seven have reported (their completion notices arrive on their own; no
wakeup timer):

1. **Re-verify before writing anything down.** Agent findings arrive in the
   same confident tone right or wrong. Open each critical and high finding's
   file:line yourself; mark the ones you re-confirmed (✓) and say which were
   taken on the auditor's word. In 2026-10, B5 was withdrawn after its ✓ had
   confirmed only a quote, not the claim built on it.
2. **Merge duplicates**, marking "(×2)" where two auditors found it apart.
3. **Write `../AUDIT-<site>-<date>.md`**, beside the repo, not in it: grouped by
   area (analyzer output, content accuracy, UX/a11y, frontend, checks/CI, AI
   development, operational), each finding numbered for reference (A1, B4…),
   a tally, what was checked and found clean, and a suggested order: what
   ships broken config first, then what gates production, then the rest.
4. **Change nothing in the repo during the audit.** Fixing is a separate step
   the maintainer chooses; say CHANGELOG.md is untouched and that checks were
   not re-run.
