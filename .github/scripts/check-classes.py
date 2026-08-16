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
import html
import os
import re
import sys

# Repo root: this file lives at <root>/.github/scripts/, so three levels up.
# These checks sit under .github/ rather than scripts/ because GitHub Pages
# publishes this branch and a plain scripts/ directory was being served —
# verified: /scripts/check-tokens.py returned 200. Dot-directories 404 because
# Jekyll runs here and skips dot-prefixed paths. There is deliberately no
# .nojekyll: adding one disables Jekyll rather than configuring it, and the
# dot-prefix exclusion goes with it, publishing .github/ wholesale.
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
    # copy-label   the span shared.js swaps text into so a copy button's icon
    #              survives the "Copied!" state; layout comes from the button
    'hide-mobile', 'plain', 'hint', 'banner-text', 'card-fit', 'copy-label',
    'card-link', 'description', 'str', 'cmd', 'flag', 'comment',
    'nginx-glyph',
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
# Built ahead of the content that will use them, and verified as such with
# `git log -S`: the event banner ran for three weeks in 2026 for a conference
# and will run again, and the annotation grid is waiting on ingress2gateway
# content. They are reported separately from genuinely unused rules so the
# report stays actionable — an unexplained list gets ignored, and then a live
# class gets deleted along with the dead ones.
DORMANT = {
    'event-banner', 'banner-highlight', 'coming-soon-label',
    'annotation-grid-cell', 'annotation-grid-header', 'annotation-preview',
    'annotation-preview-more', 'annotation-preview-toggle', 'annotation-tooltip',
}

RUNTIME_COMPOSED = {
    'badge-policy', 'badge-virtualserver', 'badge-virtualserverroute',
    'badge-transportserver', 'badge-globalconfiguration',
}


def read(path):
    # A missing file here used to raise a bare FileNotFoundError traceback, which
    # is what an absolute asset href produced: the path diagnosis belongs to
    # check_load_order() below, and this only needs to fail legibly.
    full = os.path.join(ROOT, path)
    if not os.path.isfile(full):
        sys.exit(f'check-classes: cannot read {path} — no such file under {ROOT}')
    with open(full, encoding='utf-8') as fh:
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


def page_stylesheets(text):
    """The stylesheets a page actually links, in order.

    Used for the per-page pass below. Without it this check unions every page's
    markup against every stylesheet, so a class used on page A silently
    "covers" a rule that only page B loads. That is not hypothetical: a
    17-line `.copy-btn` ruleset sat in migration.css for the life of the
    restyle styling nothing, because index.html uses `.copy-btn` and the
    global union could not tell the two pages apart.
    """
    return re.findall(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"', text)


def page_scripts(text):
    """The first-party scripts a page loads, in order.

    Anything not under assets/js/ is dropped for the class passes — but only
    after check_load_order() has seen the raw list. Dropping silently here used
    to mean one absolute src made that page's whole JS class usage vanish from
    the per-page union, and the check then reported live classes as "styled but
    unreachable" — an instruction to delete working code, while the real defect
    (the absolute path) went unmentioned.
    """
    return [s for s in page_script_srcs(text) if s.startswith('assets/js/')]


def page_script_srcs(text):
    """Every `src` a page loads, in order, unfiltered."""
    return re.findall(r'<script[^>]+src="([^"]+)"', text)


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


SHARED_BLOCKS = [
    ('top bar', r'<nav class="topbar".*?</nav>'),
    ('sidebar footer', r'<div class="sidebar-ext-links">.*?</aside>'),
]


def shared_markup_skeleton(text, pattern):
    """The ordered class/id sequence of a shared block.

    Not the raw tags: the two pages render icons differently (the landing page
    uses an SVG sprite, the tool inlines them), and that is not what has to
    match. What has to match is what the shared CSS and JS key off — the
    classes and ids, in order.
    """
    m = re.search(pattern, text, re.S)
    if not m:
        return None
    block = m.group(0)
    names = []
    for attr, value in re.findall(r'\s(class|id)="([^"]*)"', block):
        names.extend(sorted(value.split()) if attr == 'class' else ['#' + value])
    return names


def check_shared_markup():
    """The top bar and sidebar footer are duplicated in both pages by hand.

    There is no build step to deduplicate them — the project ships static HTML
    on purpose — so the next best thing is making drift fail a check instead of
    being noticed months later on one page only.
    """
    failures = []
    pages = html_files()
    for label, pattern in SHARED_BLOCKS:
        skeletons = {}
        for f in pages:
            skel = shared_markup_skeleton(re.sub(r'<!--.*?-->', '', read(f), flags=re.S), pattern)
            if skel is None:
                failures.append(f'{f}: no {label} block found')
            else:
                skeletons[f] = skel
        names = sorted(skeletons)
        for other in names[1:]:
            if skeletons[other] != skeletons[names[0]]:
                only_a = [n for n in skeletons[names[0]] if n not in skeletons[other]]
                only_b = [n for n in skeletons[other] if n not in skeletons[names[0]]]
                failures.append(
                    f'{label} markup has drifted between {names[0]} and {other}: '
                    f'only in {names[0]}: {only_a or "-"}; only in {other}: {only_b or "-"}')
    return failures


def check_load_order():
    """The asset invariants AGENTS.md opens with, none of which errored before.

    Every one of these "fails silently": nothing throws, the page just renders
    wrong. Verified by perturbation on a pristine copy — reversing the three
    stylesheet links, swapping the two migration scripts and deleting the font
    preload left every other check green and the page visibly broken.

    Script ORDER for the migration pages is asserted more precisely by
    .github/test/wiring.test.js; what is here is the part that applies to every
    page, including index.html, which that suite does not cover.
    """
    failures = []
    for page in html_files():
        text = read(page)

        # 1. tokens -> shared -> exactly one page sheet.
        sheets = page_stylesheets(text)
        if sheets[:2] != ['assets/css/tokens.css', 'assets/css/shared.css']:
            failures.append(f'{page}: stylesheets must start tokens.css, shared.css — got {sheets[:2]}')
        elif len(sheets) != 3:
            failures.append(f'{page}: expected exactly one page stylesheet after the two shared ones — got {sheets[2:]}')

        # 2. The @font-face lives inside shared.css, so without a preload ahead
        #    of the stylesheets the font is not discoverable until that CSS has
        #    parsed. Compare byte offsets, not tag order in a list.
        preload = re.search(r'<link[^>]+rel="preload"[^>]+as="font"[^>]*>', text)
        first_sheet = re.search(r'<link[^>]+rel="stylesheet"', text)
        if not preload:
            failures.append(f'{page}: no <link rel="preload" as="font"> — the @font-face in '
                            'shared.css is not discoverable until that CSS parses')
        elif not first_sheet or preload.start() > first_sheet.start():
            failures.append(f'{page}: font preload must come before the first stylesheet link')
        elif 'crossorigin' not in preload.group(0):
            failures.append(f'{page}: font preload needs crossorigin, or the browser fetches it twice')

        # 3. shared.js first; where migration-core.js appears, a source module
        #    precedes it because the core reads window.MIGRATION_SOURCE at top level.
        scripts = page_script_srcs(text)
        if not scripts or scripts[0] != 'assets/js/shared.js':
            failures.append(f'{page}: first script must be assets/js/shared.js — got {scripts[:1]}')
        if 'assets/js/migration-core.js' in scripts:
            core = scripts.index('assets/js/migration-core.js')
            sources = [i for i, s in enumerate(scripts)
                       if re.fullmatch(r'assets/js/migration-(?!core)[\w-]+\.js', s)]
            if not sources:
                failures.append(f'{page}: loads migration-core.js with no migration-<source>.js module')
            elif min(sources) > core:
                failures.append(f'{page}: migration-core.js loads before its source module — '
                                'the core reads window.MIGRATION_SOURCE at top level')

        # 4. Relative paths only, and every one of them exists. An absolute path
        #    resolves in production and breaks every other context.
        #
        #    The fragment is split off before the disk test: the brand lockup is
        #    pulled in with <use href="assets/img/nginx-logo.svg#logo">, and a
        #    fragment identifier is not part of the filename. Reported as
        #    "…nginx-logo.svg#logo does not exist on disk" while the file sat
        #    right there, which reads as a missing asset rather than a check
        #    that cannot parse a URL.
        for attr, ref in re.findall(r'\s(?:href|src)="((/)?assets/[^"]+)"', text):
            path = attr.split('#', 1)[0]
            if attr.startswith('/'):
                failures.append(f'{page}: absolute asset path {attr} — must be relative')
            elif not os.path.isfile(os.path.join(ROOT, path)):
                failures.append(f'{page}: {attr} does not exist on disk')

    # 5. sitemap.xml must list exactly the pages that exist.
    sitemap = read('sitemap.xml')
    listed = set()
    for loc in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', sitemap):
        tail = loc.rstrip('/').rsplit('/', 1)[-1]
        listed.add('index.html' if not tail.endswith('.html') else tail)
    missing = sorted(set(html_files()) - listed)
    extra = sorted(listed - set(html_files()))
    if missing:
        failures.append(f'sitemap.xml does not list: {", ".join(missing)}')
    if extra:
        failures.append(f'sitemap.xml lists pages that do not exist: {", ".join(extra)}')

    return failures


# The sidebar label is the <h2> it links to, verbatim — except where the heading
# would clip. `.sidebar-link-name` is `white-space: nowrap` inside a 264px rail
# (~226px usable), so a long heading gets a short label instead. Measured, not
# guessed: "Ingress NGINX config analyzer" is ~285px, while "Phased migration
# strategy" is 150.5px and is therefore spelled out in full.
LABEL_EXCEPTIONS = {
    'yaml-analyzer': 'Config analyzer',
}


def check_label_pairs():
    """Navigation labels against the headings they point at.

    AGENTS.md states twice that these cannot diverge, and they had: the sidebar
    read "Phased migration" against a "Phased migration strategy" heading, and
    nothing on main could report it, so the next person could not discover the
    drift either.
    """
    failures = []
    for page in html_files():
        text = read(page)
        sections = dict(re.findall(
            r'<section id="([\w-]+)"[^>]*>(.*?)</section>', text, re.S))
        for sid, label in re.findall(
                r'data-section="([\w-]+)"[^>]*>.*?'
                r'<span class="sidebar-link-name">([^<]*)</span>', text, re.S):
            body = sections.get(sid)
            if body is None:
                continue
            m = re.search(r'<h2[^>]*>(.*?)</h2>', body, re.S)
            if not m:
                continue
            heading = re.sub(r'<[^>]+>', '', m.group(1))
            heading = html.unescape(heading).strip()
            expected = LABEL_EXCEPTIONS.get(
                re.search(r'<h2 id="([\w-]+)"', body).group(1)
                if re.search(r'<h2 id="([\w-]+)"', body) else '', heading)
            if label.strip() != expected:
                failures.append(
                    f'{page}: sidebar label "{label.strip()}" != <h2> "{heading}" '
                    f'(section #{sid})')

    # Analyzer category names are rendered above the generated YAML
    # (migration-core.js) and as card titles, so their case is user-visible.
    for js in js_files():
        if not re.search(r'migration-(?!core)', js):
            continue
        src = read(js)
        page = None
        for p in html_files():
            if js in page_scripts(read(p)):
                page = p
        if not page:
            continue
        html_text = read(page)
        headings = {
            hid: html.unescape(re.sub(r'<[^>]+>', '', body)).strip()
            for hid, body in re.findall(r'<h3 id="([\w-]+)"[^>]*>(.*?)</h3>', html_text, re.S)
        }
        for category, anchor in re.findall(
                r'category:\s*"([^"]+)"[^}]*?anchor:\s*"([\w-]+)"', src, re.S):
            want = headings.get(anchor)
            if want is not None and category != want:
                failures.append(
                    f'{js}: category "{category}" != <h3 id="{anchor}"> "{want}" in {page}')
    return sorted(set(failures))


def name_in_line(name, line):
    """Whether a class name occurs in a line as a whole token.

    Used only to give the unstyled report a line number: in a 4,952-line file a
    bare filename is not enough to act on.
    """
    return re.search(r'(?<![\w-])' + re.escape(name) + r'(?![\w-])', line) is not None


def classes_defined_in(css_path):
    return set(re.findall(r'\.(-?[A-Za-z_][\w-]*)', css_selectors_only(read(css_path))))


def classes_used_in_markup(html_path):
    text = re.sub(r'<!--.*?-->', '', read(html_path), flags=re.S)
    names = set()
    for attr in re.findall(r'class="([^"]*)"', text):
        names.update(attr.split())
    return names


def classes_used_in_js(js_path):
    text = read(js_path)
    found = []
    found += re.findall(r"classList\.(?:add|remove|toggle|contains)\(([^)]*)\)", text)
    # The whole right-hand side, not just a literal sitting immediately
    # after the `=`. A ternary — `className = x ? 'analyzer-error' :
    # 'analyzer-info'` — used to slip past, so both live classes were
    # reported as unused and were one deletion away from being removed.
    for expr in re.findall(r"(?:className|classList)\s*=\s*([^;\n]+)", text):
        # Every string literal on the right-hand side is a class, EXCEPT one
        # being compared against — `type === 'error' ? 'analyzer-error' :
        # 'analyzer-info'` assigns two classes and compares a third.
        #
        # This used to keep only what followed the `?`, which was wrong in the
        # other direction: `'analyzer-step-number' + (cls ? ' ' + cls : '')`
        # has its base class BEFORE the `?`, so the base was dropped and a live
        # class was reported as unused. Drop comparison operands by name
        # instead of slicing the expression by position.
        compared = set(re.findall(r"[=!]==?\s*'([^']+)'", expr))
        found += [lit for lit in re.findall(r"'([^']+)'", expr) if lit not in compared]
    found += re.findall(r"setAttribute\(\s*'class'\s*,\s*([^)]*)\)", text)
    # Also catch classes inside HTML the renderer builds as a string —
    # otherwise a live class looks unreferenced and could be deleted.
    found += re.findall(r'class="([^"]+)"', text)
    found += re.findall(r"class=\\?'([^'\\]+)", text)
    # ...and classes passed to a querySelector, which are equally live.
    for sel in re.findall(r"querySelector(?:All)?\(\s*'([^']+)'", text):
        found += re.findall(r'\.(-?[A-Za-z_][\w-]*)', sel)
    names = set()
    for blob in found:
        # some patterns above capture a whole argument list, so pull the
        # string literals back out before splitting on whitespace
        parts = re.findall(r"'([^']+)'", blob) if "'" in blob else [blob]
        for part in parts:
            names.update(part.split())
    return names


def check_page_scoped_css():
    """Rules in a page-exclusive stylesheet that its own page never uses.

    The global pass below cannot see these: it unions every page's markup
    against every stylesheet, so a class used on page A covers a rule only
    page B loads. Only stylesheets loaded by exactly one page are checked —
    shared.css and tokens.css legitimately carry rules one page doesn't use.
    """
    pages = html_files()
    sheet_owners = {}
    used_by_page = {}
    for page in pages:
        text = read(page)
        for sheet in page_stylesheets(text):
            sheet_owners.setdefault(sheet, []).append(page)
        names = classes_used_in_markup(page)
        for script in page_scripts(text):
            names |= classes_used_in_js(script)
        used_by_page[page] = names

    problems = []
    for sheet, owners in sorted(sheet_owners.items()):
        if len(owners) != 1:
            continue
        page = owners[0]
        orphans = (classes_defined_in(sheet)
                   - used_by_page[page] - STATE_ONLY - RUNTIME_COMPOSED - DORMANT)
        for name in sorted(orphans):
            problems.append(f'.{name}  ({sheet} is loaded only by {page}, which never uses it)')
    return problems


def main():
    # ── assets first ──────────────────────────────────────────────────────
    # Before anything else, because every pass below follows the page's own
    # href/src values: a broken or absolute path makes those reads fail, and
    # the resulting "cannot read" message describes the symptom rather than
    # the defect. Running this first means the precise diagnosis wins.
    order = check_load_order()
    if order:
        print(f'{len(order)} LOAD-ORDER / ASSET PROBLEM(S):')
        for o in order:
            print(f'  {o}')
        return 1

    # ── what CSS defines ──────────────────────────────────────────────────
    defined = set()
    for f in css_files():
        defined |= classes_defined_in(f)

    # ── what the markup and JS use ────────────────────────────────────────
    used = {}
    for f in html_files():
        for name in classes_used_in_markup(f):
            used.setdefault(name, set()).add(f)
    for f in js_files():
        for name in classes_used_in_js(f):
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

    unreferenced = sorted(
        n for n in defined
        if n not in used and n not in STATE_ONLY
        and n not in RUNTIME_COMPOSED
    )
    dormant = [n for n in unreferenced if n in DORMANT]
    unused = [n for n in unreferenced if n not in DORMANT]

    print(f'{len(defined)} classes defined in CSS, {len(used)} referenced by markup or JS\n')

    if dormant:
        print(f'{len(dormant)} dormant by design (built ahead of their content):')
        print('  ' + ', '.join('.' + n for n in dormant) + '\n')

    if unused:
        print(f'{len(unused)} defined but unreferenced (reported, not failed):')
        for n in unused:
            print(f'  .{n}')
        print('  Not on the dormant list — run `git log -S` and delete if truly dead.\n')

    drift = check_shared_markup()
    if drift:
        print(f'{len(drift)} SHARED MARKUP PROBLEM(S):')
        for d in drift:
            print(f'  {d}')
        print()

    page_scoped = check_page_scoped_css()
    if page_scoped:
        print(f'{len(page_scoped)} STYLED BUT UNREACHABLE ON ITS OWN PAGE:')
        for p in page_scoped:
            print(f'  {p}')
        print()

    labels = check_label_pairs()
    if labels:
        print(f'{len(labels)} LABEL/HEADING DRIFT:')
        for lbl in labels:
            print(f'  {lbl}')
        print()

    if unstyled:
        print(f'{len(unstyled)} USED BUT UNSTYLED:')
        for n, where in sorted(unstyled.items()):
            locs = []
            for f in sorted(where):
                for i, line in enumerate(read(f).split('\n'), 1):
                    if name_in_line(n, line):
                        locs.append(f'{f}:{i}')
                        break
                else:
                    locs.append(f)
            print(f'  .{n}  (first seen at {", ".join(locs)})')

    if unstyled or drift or page_scoped or labels:
        return 1

    print('Every class used by the markup or JS resolves to a CSS rule,')
    print('every page-exclusive stylesheet only styles things its page can render,')
    print('the shared top bar and sidebar footer match across both pages,')
    print('the asset load order holds on every page, and every navigation label')
    print('matches the heading it points at.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
