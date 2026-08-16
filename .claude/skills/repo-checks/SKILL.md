---
name: repo-checks
description: How the nine checks work and how to add one — why the runner is Python rather than shell, the seven times a mistyped construct reported clean for a check that never ran, and the fault-injection standard. Use when adding or changing a check, or when one fails.
---

# The checks, and how to add one

One command, no dependencies:

```bash
python3 .github/scripts/check-all.py       # -v to see every check's full output
```

It runs all nine and prints **how many ran**, which is the number that matters.

## Why a runner, and never a shell line

A mistyped shell construct reports "clean" for a check that never ran. That has
now happened **seven** times in this repository:

1. A `$F` that expanded to one filename.
2. Broken `grep -c` arithmetic.
3. A zsh glob swallowing `--include`.
4. `for c in "python3 …"; do $c; done` — zsh treated each whole string as one
   command name, printed `exit=0` four times, and ran nothing.
5. `$b:` followed by a path — zsh parsed it as a history modifier, so
   `$b:assets/…` silently became `mainssets/…`.
6. `node --check assets/js/*.js`, which parses only the **first** glob match.
   That one sat in CI for two months, so `shared.js` had no syntax coverage.
7. `python3 … | head -20; echo "(exit $?)"` — `$?` is `head`'s status, not the
   script's, so a check that correctly exited 1 was reported as exit 0.

If you must capture status through a pipe, zsh is `${pipestatus[1]}`, not `$?`.

`check-all.py` is safe to trust for three specific reasons, and if you change it,
keep all three:

- It is **Python, not shell** — no globbing, word-splitting or history expansion
  happens between the declaration and the process.
- Each check is a literal `(label, argv)` tuple, never a string to be parsed.
- It **asserts it ran every check it declared** and prints the count, so
  "9 of 9 checks ran" is part of the output rather than something you infer from
  the absence of errors.

A missing interpreter or script is a **failure**, never a skip (`FileNotFoundError`
→ exit 127).

The same shape is why the CI test step names its glob and guards on `find`:
`node --test` exits 0 when it matches no files, so a moved directory would turn
it into a green no-op.

## The fault-injection standard

**A new assertion is not finished until you have watched it fail.** Plant the
defect it is meant to catch, confirm the check reports it and exits non-zero,
then restore. Record what you planted and what it said in the commit body —
"planted a misspelled transform; the run reported it and exited 1" is worth far
more later than "fix check".

Two traps, both hit repeatedly here:

- **Injections that silently do not match.** `perl -pi -e` and blind
  `str.replace` happily change nothing and leave you verifying an unmodified
  file. Use Python with `assert new != original` before writing.
- **Injections that are not actually defects.** Replacing *both* a sidebar label
  and its heading leaves them still agreeing, so the label check correctly stays
  green and you conclude, wrongly, that it is broken. Likewise a character you
  add to test font coverage must genuinely be outside the subset — ★ U+2605 and
  ∞ U+221E are; most punctuation is not.

Interactive `cp`/`rm`/`mv` aliases will hang a non-interactive shell until it
times out. Save and restore through Python, or call `/bin/cp` directly.

## What the nine can and cannot see

| Check | Asserts |
|---|---|
| `check-syntax.py` | every script parses — one `node --check` per file, never a glob |
| `check-tokens.py` | token invariants, retired colours/typefaces, undefined `var()`, inline `style=`, type pairing, the manifest, webfont coverage |
| `check-contrast.py` | every pairing against WCAG 2.1 AA in both themes, plus pairings derived from the CSS, plus the measured-ratio comments |
| `check-classes.py` | classes resolve to rules; load order, asset paths, sitemap and navigation labels hold |
| `check-versions.py` | every version string agrees with its source of truth |
| `check-markup.py` | tag balance, duplicate ids, anchors, JSON-LD |
| `test-analyzer.js` | the migration analyzer under a DOM stub; regenerates `mapping-index.json` |
| `node --test .github/test/` | page ↔ engine ↔ module wiring |
| `where.py --self-test` | the locator's resolvers still match, by kind not line number |

Five things to know:

1. **None of them can see the rendered page.** Every one is a static reader, so
   the entire class of visual defect — a stretched grid, a collapsed flex item, a
   truncated label, a card wrapping 3+1 — passes all of them green. A clean run
   means "nothing is structurally broken", not "it looks right". Use the
   `verify-visually` skill.
2. **`check-contrast.py` derives pairings from the stylesheets** as well as
   asserting a hand-written list, so a new coloured surface is measured without
   anyone remembering to add it. Two limits remain: it only sees pairs declared
   through tokens in the same rule (or a dark override of one), and it cannot
   know which text is large enough for the 3:1 bar, so it holds everything to
   4.5:1. It is quiet on success — pass `-v` for all 58 measurements.
3. **`check-classes.py` matters most after a restyle.** A class that loses its
   rule does not error; the element just renders unstyled, which is invisible on
   a page with thousands of rows. It reports unused classes but never fails on
   them: there is dormant-by-design CSS here, listed by name in the script's own
   `DORMANT` set — the event banner and the ingress2gateway annotation grid, both
   built ahead of their content. Run `git log -S` before deleting anything on
   that list.
4. **The checks live under `.github/` because Pages publishes this branch.** A
   top-level `scripts/` was being served (`/scripts/check-tokens.py` returned
   200); dot-directories 404, because Jekyll runs on this branch and skips
   dot-prefixed paths. **There is no `.nojekyll` and adding one would publish
   `.github/` wholesale** — it disables Jekyll rather than configuring it, so the
   dot-prefix exclusion goes with it. Anything else that must not be served goes
   under `.github/` too, which is why the test suite is at `.github/test/`. Each
   script and the test loader derive `ROOT` by walking up from their own path, so
   moving one means fixing that.
5. **`.github/workflows/tests.yml` runs the same nine**, one step each, on every
   push and pull request. Pushing to `main` is deploying and CI finishes at about
   the same time the deploy does, so a red run does not stop a bad commit
   reaching production. Verify before you push.

## Adding a check

1. Write it as a standalone script under `.github/scripts/` that exits non-zero
   on failure and derives `ROOT` from its own path.
2. Make it **quiet on success** — print a one-line summary that includes the
   counts it asserted, so "OK" can never mean "measured nothing". Put the detail
   behind `-v`.
3. Add a literal `(label, argv)` tuple to `CHECKS` in `check-all.py`.
4. Add a step to `.github/workflows/tests.yml`.
5. Fault-inject it, per the standard above, and write what you planted into the
   commit body.

## Adding a test file

Not the same as adding a check — a new `.github/test/*.test.js` joins the
existing "wiring suite" entry rather than becoming a tenth check. Register it in
**both** places or it runs in only one of them:

- `.github/workflows/tests.yml` globs `.github/test/*.test.js`, so CI picks a new
  file up on its own.
- `check-all.py` lists the files by name, so a local run silently uses the
  smaller suite until the name is added there too.

The asymmetry is deliberate — the glob is guarded against matching nothing, and
a literal list is what keeps `check-all.py` honest about how many things ran —
but it means the two can disagree without anything saying so.
