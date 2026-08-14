#!/usr/bin/env python3
"""Assert every class the markup or JS uses actually has a CSS rule.

This is the check that matters most after a restyle. The two HTML pages carry
~5,600 lines of markup and migration-core.js builds several hundred more nodes
at runtime; the stylesheets were rewritten underneath all of it. A class that
lost its rule does not error — the element simply renders unstyled, which is
easy to miss on a page with thousands of rows.

It reports both directions:
  - USED BUT UNSTYLED is a failure. Something references a class with no rule.
  - DEFINED BUT UNUSED is reported only, never failed. This codebase has
    dormant-by-design CSS: the event banner ran for three weeks in 2026 for a
    conference, the blogs/videos sections are built but unlinked, and the
    ingress2gateway annotation grid is waiting on content. Run `git log -S`
    before deleting anything on that list.

Usage:  python3 .github/scripts/check-classes.py
Exit:   0 nothing unstyled, 1 otherwise.
"""
import os
import re
import sys

# Repo root: this file lives at <root>/.github/scripts/, so three levels up.
# These checks sit under .github/ rather than scripts/ because GitHub Pages
# serves this branch verbatim (.nojekyll), and a plain scripts/ directory
# was being published — verified: /scripts/check-tokens.py returned 200,
# while dot-directories 404.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Classes that are deliberately state-only: JS toggles them and a *combined*
# selector styles the result, so they never need a rule of their own. Listing
# them here is the difference between a useful check and a noisy one.
STATE_ONLY = {
    # toggled on many different elements, always styled via a compound selector
    'active', 'open', 'visible', 'expanded', 'collapsed', 'checked', 'copied',
    'downloaded', 'dragging', 'filled', 'show', 'no-results', 'inactive',
    'has-banner', 'dark-mode',
    # per-section modifiers, styled as .page-hero.nic, .cta-primary.migration…
    'home', 'nic', 'ngf', 'migration', 'i2g', 'blogs', 'videos',
    'green', 'blue', 'old', 'new',
    'simple', 'moderate', 'advanced',
    'configmap', 'crd', 'unsupported', 'unrecognized', 'found', 'paths', 'crds',
    'warning', 'note', 'tip', 'info', 'tip-green', 'desc', 'num', 'label',
    'positive', 'attention', 'negative',
    # utility hooks with no styling of their own
    'hide-mobile', 'plain', 'hint', 'banner-text', 'card-fit',
    'card-link', 'description', 'str', 'cmd', 'flag', 'comment',
    'brand-logo-light', 'brand-logo-dark', 'nginx-glyph',
    'dark-icon-moon', 'dark-icon-sun', 'or-text',

    # Behaviour and layout hooks that carry no styling by design. Verified
    # against main: none of these had a rule before the restyle either, so an
    # empty entry here is the accurate description rather than a gap.
    #   tool-page               visibility comes from the `hidden` attribute,
    #                           not CSS, so find-in-page can still reach an
    #                           inactive view
    #   eol-warning             the JS handle migration-core.js uses to find and
    #                           collapse the banner; its looks come from
    #                           `.info-box.warning`, which it is composed with
    #   analyzer-parser-warning likewise composed onto `.info-box warning`
    #   analyzer-card-header    layout wrapper
    #   found-annotations       layout wrapper
    'tool-page', 'eol-warning', 'analyzer-parser-warning',
    'analyzer-card-header', 'found-annotations',
}

# migration-core.js builds a badge class from a CRD kind while the page runs
# (`kindBadge.className = 'badge badge-' + badgeClass`), so these names never
# appear in the source as whole words and this script cannot find them. They
# are listed here by hand. The list is short and knowable: `kindBadgeMap` in
# that same file contains exactly these five.
#
# This used to skip anything starting with `badge-`, and that shortcut hid a
# real bug. Because every badge class was skipped, `.badge-annotation` stayed
# in the CSS for the whole life of the tool without ever being put on an
# element, and was restyled twice by people who assumed it appeared on the
# page. Keep this an explicit list. If a new kind is added to kindBadgeMap,
# add it here too.
RUNTIME_COMPOSED = {
    'badge-policy', 'badge-virtualserver', 'badge-virtualserverroute',
    'badge-transportserver', 'badge-globalconfiguration',
}


def read(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as fh:
        return fh.read()


def html_files():
    return [f for f in sorted(os.listdir(ROOT)) if f.endswith('.html')]


def css_files():
    d = os.path.join(ROOT, 'assets', 'css')
    return [os.path.join('assets/css', f) for f in sorted(os.listdir(d)) if f.endswith('.css')]


def js_files():
    d = os.path.join(ROOT, 'assets', 'js')
    return [os.path.join('assets/js', f) for f in sorted(os.listdir(d)) if f.endswith('.js')]


def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def css_selectors_only(css):
    """Drop comments, url() payloads and quoted strings before scanning.

    Without this, `url('../fonts/InterVariable-subset.woff2')` and a hostname in
    a comment both look like class selectors (.woff2, .org), which inflates the
    "defined" set and could mask a genuinely missing rule.
    """
    css = strip_comments(css)
    css = re.sub(r'url\([^)]*\)', 'url()', css)
    css = re.sub(r'"[^"]*"', '""', css)
    css = re.sub(r"'[^']*'", "''", css)
    return css


def main():
    # ── what CSS defines ──────────────────────────────────────────────────
    defined = set()
    for f in css_files():
        for name in re.findall(r'\.(-?[A-Za-z_][\w-]*)', css_selectors_only(read(f))):
            defined.add(name)

    # ── what the markup uses ──────────────────────────────────────────────
    used = {}
    for f in html_files():
        text = re.sub(r'<!--.*?-->', '', read(f), flags=re.S)
        for attr in re.findall(r'class="([^"]*)"', text):
            for name in attr.split():
                used.setdefault(name, set()).add(f)

    # ── what JS sets at runtime ───────────────────────────────────────────
    for f in js_files():
        text = read(f)
        found = []
        found += re.findall(r"classList\.(?:add|remove|toggle|contains)\(\s*'([^']+)'", text)
        found += re.findall(r"className\s*=\s*'([^']+)'", text)
        found += re.findall(r"classList\s*=\s*'([^']+)'", text)
        # Also catch classes inside HTML the renderer builds as a string —
        # otherwise a live class looks unreferenced and could be deleted.
        found += re.findall(r'class="([^"]+)"', text)
        found += re.findall(r"class=\\?'([^'\\]+)", text)
        # ...and classes passed to a querySelector, which are equally live.
        for sel in re.findall(r"querySelector(?:All)?\(\s*'([^']+)'", text):
            found += re.findall(r'\.(-?[A-Za-z_][\w-]*)', sel)
        for blob in found:
            for name in blob.split():
                used.setdefault(name, set()).add(f)

    # ── report ────────────────────────────────────────────────────────────
    unstyled = {}
    for name, where in used.items():
        if name in defined or name in STATE_ONLY:
            continue
        if name in RUNTIME_COMPOSED:
            continue
        # A trailing hyphen means the string literal was cut off by a `+`, so
        # this is the stem of a runtime-composed name ('badge badge-' + kind)
        # rather than a class anything renders. The composed results are listed
        # in RUNTIME_COMPOSED above; the stem itself is never a real class.
        if name.endswith('-'):
            continue
        unstyled[name] = where

    unused = sorted(
        n for n in defined
        if n not in used and n not in STATE_ONLY
        and n not in RUNTIME_COMPOSED
    )

    print(f'{len(defined)} classes defined in CSS, {len(used)} referenced by markup or JS\n')

    if unused:
        print(f'{len(unused)} defined but unreferenced (reported, not failed):')
        for n in unused:
            print(f'  .{n}')
        print('  Some of these are dormant by design — check `git log -S` before deleting.\n')

    if unstyled:
        print(f'{len(unstyled)} USED BUT UNSTYLED:')
        for n, where in sorted(unstyled.items()):
            print(f'  .{n}  (referenced in {", ".join(sorted(where))})')
        return 1

    print('Every class used by the markup or JS resolves to a CSS rule.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
