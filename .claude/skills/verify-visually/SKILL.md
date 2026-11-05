---
name: verify-visually
description: How to actually look at this site: shot.sh, the cdp.js helper (deep-link captures, true 320px viewports, overflow and focus-obscured sweeps, forced-colors/print/zoom emulation), DOM measurement, and the four facts that make a correct render command look like it failed (hash-routed SPAs, dark by default, viewport-not-page capture, the 500px macOS clamp). Use after any CSS, markup or layout change.
---

# Rendering and looking

The checks are static readers. They cannot see a stretched grid, a collapsed
flex item, a truncated label, a card wrapping 3+1, or text that has become
unreadable. A clean run means "nothing is structurally broken", not "it looks
right", so for anything that changes what a reader sees, render it.

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
that. `--force-dark-mode` does **not** drive this site: dark mode is a class
toggled from `localStorage.darkMode`. `shot.sh` seeds that key ahead of the
inline script, which is the only reliable way to choose a theme. If you render
by hand and get a dark page you did not ask for, this is why.

**3. `--screenshot` captures the viewport, not the page, and it captures it at
scroll position zero.** Those two together are nastier than either alone: deep-
link to `#mappings`, the document scrolls, and a fixed-height capture of a page
many times taller than the window comes back blank, because the content has
moved out of the captured band. It looks like the page failed to render.

`shot.sh` sizes the window to the laid-out document, capped at 8000px, which
only half solves it. An anchor below the cap (every ConfigMap row) still comes
back blank, so `shot.sh` now **refuses a capture in which no row holds more than
one colour** and exits 5 with `BLANK:`. For anything below the first screenful,
use `cdp.js shot`, which captures from the element itself (below).

**4. Widths below 500px are a lie through `--window-size` on macOS.** The window
is clamped, so 320, 375 and 400 all render at 500 and the PNG is cropped, which
reads exactly like horizontal overflow that is not there. `cdp.js` sets the
viewport with `Emulation.setDeviceMetricsOverride` instead, which is not
clamped: `--width 320` is a true 320px layout.

## Sweeps, deep links and phone widths: `cdp.js`

`shot.sh` drives Chrome from its command line, which cannot set a true small
viewport, click, emulate media or capture a region. `.github/scripts/cdp.js`
drives it over the DevTools protocol instead (Node 22+, no dependencies):

```bash
node .github/scripts/cdp.js shot     'ingress-nginx-migration.html#configmap-identical' --below 600
node .github/scripts/cdp.js overflow index.html --width 320     # every element past the viewport, every clipped text box
node .github/scripts/cdp.js focus    'ingress-nginx-migration.html#reference'   # real Tab presses; focus under the top bar or off-screen
node .github/scripts/cdp.js measure  index.html --select '.sidebar-link-name'
node .github/scripts/cdp.js js       index.html --forced-colors --js 'matchMedia("(forced-colors: active)").matches'
```

Options on every command: `--width N` (a **true** N px viewport via
`Emulation.setDeviceMetricsOverride`; 320 really is 320), `--dark`, `--print`,
`--forced-colors`, `--reduced-motion`, `--zoom F`, `--click SEL` (repeatable,
in order, e.g. to expand a row first), `--scroll SEL`. Exit 1 means the sweep
found problems, 3 no browser, 4 the page did not load, 5 a blank capture.

Three things it does on purpose, each a trap it removes:

- **It navigates via `about:blank`.** A same-document hash change never fires
  `Page.loadEventFired`, so going from `index.html` to `index.html#x` would
  wait forever; a fresh document always fires it.
- **`shot` captures the target, not the viewport.** With a hash or `--select`
  it clips to that element (`--below N` adds what follows it), with
  `captureBeyondViewport`, so an anchor 15,000px down is a picture of the
  anchor. It refuses a blank capture exactly as `shot.sh` does.
- **`focus` presses Tab** rather than calling `element.focus()`, because only a
  keyboard press applies `:focus-visible` (the skip link sits off-screen until
  then), and it waits for a focus transition to finish before hit-testing what
  is painted over the focused element.

It pins the network to localhost, so remote images (YouTube posters, blog
thumbnails) render as broken: that is the pinning, not a defect.

## Measuring beats looking

For anything with a number in it (does this label fit, does this row overflow,
is this touch target big enough), take a measurement rather than squinting at
an image. `--measure` takes a CSS selector and prints JSON: each node's box,
its text, whether it is clipped (`scrollWidth > width`), the viewport, and
whether the document overflows horizontally.

That is how the sidebar label question was settled: "Phased migration strategy"
measures 150.5px against the usable rail, so it fits. Measure again after a type
or rail change: "Ingress-NGINX config analyzer" was ~285px before the F5DS
restyle and is 208px against ~215px usable now (2026-10-27). Both facts are in
the `f5ds-design` skill because they were measured, not guessed.

Structured output also **diffs**. For a change that should not alter layout,
measure before and after and compare the JSON (far more reliable than
comparing two images by eye).

## When you cannot render

`shot.sh` exits 3 with `NO-BROWSER:` when it finds no Chrome or Chromium. That
is not a reason to skip the step quietly: **say in your summary that you could
not render**, and fall back to diffing structured output against a pristine
worktree. Reporting green checks as visual verification is the specific failure
this exists to prevent: they cannot see layout, which is the whole point.

## Other things worth knowing

- `python3 -m http.server` from the repo root is a fine manual preview. Every
  asset path is relative, so `file://` also mostly works; a server is closer to
  production.
- `index.js` fetches live release versions from the GitHub API, so a rendered
  page shows *current* upstream versions even when the files are stale. Do not
  read a screenshot as evidence that the pinned versions are right; that is
  what `check-versions.py` is for. Pin the network with
  `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` for anything you
  intend to diff.
- Chrome does not always exit after writing its artifact; `shot.sh` wraps it in
  `timeout`, and the PNG is complete even when the wrapper fires.
- There is **no PR preview environment**. Pages serves `main` only. Verify
  locally before pushing, because pushing to `main` is deploying.
