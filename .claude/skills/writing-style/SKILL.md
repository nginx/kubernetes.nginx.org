---
name: writing-style
description: The plain-writing pass every commit message, doc, skill and page prose change gets here: the AI-writing patterns this repo removes, each with a real before and after, the places a pattern is deliberate and stays, and how to check a rewrite lost no fact. Use before committing, and when editing AGENTS.md, CONTRIBUTING.md, a skill, page copy or analyzer notes.
---

# Writing in this repo

`AGENTS.md` makes the pass a rule: every commit message gets it before you commit. This file is how to do it, and it is enough on its own, so any agent or person can follow it without installing anything.

The patterns come from the `humanizer` skill (`blader/humanizer`, MIT), which is longer and covers prose this repo does not have: fiction, blog voice, biography. Where your agent has it, run it in embedded mode. Where it and this file disagree, it wins, except for the deliberate exceptions below: those hold here whatever it says. To install it for Claude Code: `claude plugin marketplace add blader/humanizer`, then `claude plugin install humanizer@humanizer`. For other agents, `npx skills add blader/humanizer`.

## What it applies to

Commit subjects and bodies; `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, the skills and the commands; page copy and analyzer notes. Not code, not quoted CLI output, and not `CHANGELOG.md` unless the maintainer asks: a released section there is a shipped record.

## The patterns

**Dashes joining clauses.** The most common tell here, and the one a rewrite most often leaves behind. A dash skips choosing how two clauses relate, so choose: a colon when the second explains the first, a semicolon for two equal statements, parentheses for an aside, a comma or a period otherwise. From the repo's own wording pass:

- "It is quiet on success — pass `-v` for all 58 measurements." became "It is quiet on success; pass `-v` for all 58 measurements."
- "whether or not anyone asked — more time and context than it catches" became "whether or not anyone asked: more time and context than it catches"
- "only the failing checks' output — for the node suites, only the failing tests — so" became parentheses around the aside.

A spaced double hyphen used as a dash counts too.

**Not X but Y.** A contrast whose first half nobody claimed adds weight and no fact. "This is not a cosmetic change but a correctness fix" says less than naming the annotation, the value the analyzer emitted and the value it should have. Keep a contrast when the first half is a belief the reader holds, or a real alternative (see the exceptions).

**One-line closers.** A sentence after the evidence that restates it: "That is the whole fix.", "Nothing else changes." (when the diff already shows it). End on the last fact.

**Triads for rhythm.** Three items because three sounds complete. Keep three when there are three; merge or cut when two are the same point.

**Inflated and stock words.** crucial, pivotal, robust (figurative), seamless, leverage, key (adjective), highlight or underscore (verbs), showcase, delve, landscape (abstract), testament. Use *is*, *has* and *uses* where "serves as", "boasts" or "features" stood. A CI gate is a technical term and stays.

**Riders and staging.** An "-ing" phrase bolted on to sound deeper ("…, ensuring consistency across the tool"), a run-up before the point ("Here's the thing:", "Let's look at"), and a defence against an objection nobody raised ("To be clear, this does not…").

**Chat residue in commits.** "This commit…", "I", offers and sign-offs. A commit body states what changed and why; it does not address anyone.

**Writing about the document.** "The table below compares…" when the reader can see the table, or an account of how a file was assembled. Keep a caveat that changes what the reader does.

**Re-explaining in reports.** A report to the maintainer leads with the result. Background they wrote or agreed to, and evidence they did not ask for, push the answer to the last line.

## Deliberate exceptions

These look like patterns and stay. Do not "fix" them.

- **"Considered and rejected" contrasts.** "Rendering the tables from the mapping data at load was rejected because…" names an option someone really proposed. That record is why commit bodies here exist (`CONTRIBUTING.md`), so "X rather than Y" stays when Y was a real alternative.
- **The page's layout dashes.** The "— or —" in a collapsed cell and the " — " between a code and its reason are layout the page uses for scanning, not clause joins.
- **Dashes inside code, numeric ranges, image alt text naming a card's title, and quoted CLI output.** The text is quoted, not written.
- **Bold in `AGENTS.md`.** That file is loaded into every session and skimmed; the bold marks the rule a reader must not miss. It is not decoration, and the skills use bold the same way, sparingly.
- **Naming and spelling.** The product names and the British/American split in `AGENTS.md` come first; a rewrite never changes "NGINX Ingress Controller" to something shorter.

## Checking a rewrite

Read the result once for meaning: every fact, name, number, path, commit SHA and planted-fault record must still be there. For a long file, compare a word count of the terms before and after; the repo's own wording pass did that and found no term lost. Then search for what survives most often:

```bash
grep -n '—\|–' <file>        # dashes, outside the exceptions above
```

For a commit message, write it to a file, run the pass on that file, and commit with `git commit -F <file>`. Fold the change into the unpushed commit of the same type when there is one (`AGENTS.md`).
