---
name: verify-visually
description: How to actually look at this site — shot.sh, DOM measurement, and the four facts that make a correct render command look like it failed (hash-routed SPAs, dark by default, viewport-not-page capture, the 500px macOS clamp). Use after any CSS, markup or layout change.
---

# Rendering and looking

The checks are static readers. They cannot see a stretched grid, a collapsed
flex item, a truncated label, a card wrapping 3+1, or text that has become
unreadable. A clean run means "nothing is structurally broken", not "it looks
right" — so for anything that changes what a reader sees, render it.

```bash
.github/scripts/shot.sh index.html                          # light, 1400px
.github/scripts/shot.sh index.html --dark
.github/scripts/shot.sh 'index.html#ingress2gateway'        # a specific view
.github/scripts/shot.sh ingress-nginx-migration.html --width 900
.github/scripts/shot.sh index.html --measure '.sidebar-link-name'
```

Then **read the PNG**. Writing the file is not verification.

## Four facts that make a correct command look broken

**1. Both pages are hash-routed SPAs.** `index.html` has five `.product-page`
panes, four of them `hidden="until-found"`; the migration tool has three
`.tool-page`. A screenshot with no hash shows the *home* view, so a change to
the ingress2gateway section or the reference tables will not appear and you
will conclude, wrongly, that it did not apply. Deep-link:
`index.html#ingress2gateway`, `ingress-nginx-migration.html#reference`. The
hash applies on first load with no interaction.

**2. Headless Chrome renders the dark theme by default here.** It reports
`prefers-color-scheme: dark`, and the inline flash-prevention script honours
that. `--force-dark-mode` does **not** drive this site — dark mode is a class
toggled from `localStorage.darkMode`. `shot.sh` seeds that key ahead of the
inline script, which is the only reliable way to choose a theme. If you render
by hand and get a dark page you did not ask for, this is why.

**3. `--screenshot` captures the viewport, not the page — and it captures it at
scroll position zero.** Those two together are nastier than either alone: deep-
link to `#mappings`, the document scrolls, and a fixed 1200px capture of a
4,751px page comes back almost entirely blank, because the content has moved out
of the captured band. It looks like the page failed to render.

`shot.sh` handles this by measuring the laid-out document first and sizing the
window to it, capped at 8000px (it says so when it caps). Pass `--height` to
override. If you render by hand, size the window to the document or you will be
looking at empty space.

**4. Widths below 500px are a lie on macOS.** The viewport is clamped, so 320,
375 and 400 all render at 500 and the PNG is cropped — which reads exactly like
horizontal overflow that is not there. For phone widths, measure instead of
looking, or trust the 900/600px breakpoints in the CSS.

## Measuring beats looking

For anything with a number in it — does this label fit, does this row overflow,
is this touch target big enough — take a measurement rather than squinting at
an image. `--measure` takes a CSS selector and prints JSON: each node's box,
its text, whether it is clipped (`scrollWidth > width`), the viewport, and
whether the document overflows horizontally.

That is how the sidebar label question was settled: "Phased migration strategy"
measures 150.5px against ~226px of usable rail, so it fits; "Ingress NGINX
config analyzer" would be ~285px, so it does not, and the sidebar shortens it.
Both facts are now in AGENTS.md because they were measured, not guessed.

Structured output also **diffs**. For a change that should not alter layout,
measure before and after and compare the JSON — far more reliable than
comparing two images by eye.

## When you cannot render

`shot.sh` exits 3 with `NO-BROWSER:` when it finds no Chrome or Chromium. That
is not a reason to skip the step quietly: **say in your summary that you could
not render**, and fall back to diffing structured output against a pristine
worktree. Reporting green checks as visual verification is the specific failure
this exists to prevent — they cannot see layout, which is the whole point.

## Other things worth knowing

- `python3 -m http.server` from the repo root is a fine manual preview. Every
  asset path is relative, so `file://` also mostly works; a server is closer to
  production.
- `index.js` fetches live release versions from the GitHub API, so a rendered
  page shows *current* upstream versions even when the files are stale. Do not
  read a screenshot as evidence that the pinned versions are right — that is
  what `check-versions.py` is for. Pin the network with
  `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` for anything you
  intend to diff.
- Chrome does not always exit after writing its artifact; `shot.sh` wraps it in
  `timeout`, and the PNG is complete even when the wrapper fires.
- There is **no PR preview environment**. Pages serves `main` only. Verify
  locally before pushing, because pushing to `main` is deploying.
