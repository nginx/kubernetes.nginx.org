# Copilot instructions

**All project instructions live in [`AGENTS.md`](../AGENTS.md) at the repository
root.** Read it first. This file exists only because Copilot Chat and Copilot
code review read this path specifically, while the Copilot coding agent reads
`AGENTS.md` — it is a pointer, not a second copy, and it must not grow into one.

The deeper reference material is in `.claude/skills/*/SKILL.md`. Those are plain
markdown; any tool can read them.

Three rules are inlined here because a reviewer without the full context does
active harm by suggesting the opposite:

1. **Load order is load-bearing and fails silently.** CSS is `tokens.css` →
   `shared.css` → the page stylesheet. Scripts are `shared.js` → the migration
   source module → `migration-core.js`. The font preload comes before the
   stylesheet links. Reordering any of these throws no error; the page just
   renders wrong.

2. **Never write a raw value at a call site.** Every colour, size, space,
   radius, shadow and duration resolves to a token in `assets/css/tokens.css` —
   including inside inline `style=` attributes and JS-generated `cssText`.
   12px is not in the spacing system.

3. **Never edit `CHANGELOG.md`.** Its entries are written by hand at release
   time, and a released section can already be serving production.

Before approving a change, note that the checks in `.github/scripts/` are static
readers: they cannot see the rendered page, so a green run does not mean the
layout is right.
