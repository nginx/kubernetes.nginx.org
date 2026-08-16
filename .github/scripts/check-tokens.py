#!/usr/bin/env python3
"""Assert the design-token invariants across every stylesheet, page and script.

These replace the shell greps this project used to run. A script rather than
greps because several of the rules are arithmetic (every spacing value a
multiple of 4; anything above 40 a multiple of 8), and because a mistyped
shell variable silently reports "clean" for a check that never ran.

Note what this catches that the F5DS scanner cannot: the scanner does not
resolve var(), so a correct `var(--space-2x)` is invisible to it while a
literal `16px` counts as on-token. Its spacing and typography dimensions read
low precisely *because* this site uses tokens. These checks read literals.

Usage:  python3 .github/scripts/check-tokens.py
Exit:   0 all invariants hold, 1 one or more violations.
"""
import json
import os
import re
import sys

# Repo root: this file lives at <root>/.github/scripts/, so three levels up.
# These checks sit under .github/ rather than scripts/ because GitHub Pages
# publishes this branch and a plain scripts/ directory was being served —
# verified: /scripts/check-tokens.py returned 200. Dot-directories 404 because
# Jekyll runs here and skips dot-prefixed paths. There is deliberately no
# .nojekyll: adding one disables Jekyll rather than configuring it, taking the
# dot-prefix exclusion with it and publishing .github/ wholesale.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CSS_DIR = os.path.join(ROOT, 'assets', 'css')
JS_DIR = os.path.join(ROOT, 'assets', 'js')

# ── Typeface ──────────────────────────────────────────────────────────────
# The retired-colour list below catches the marketing palette by hex, but
# nothing read a font-family, which left the typeface — the most visible thing
# on the page — as the one part of the marketing brand with no guard at all.
#
# This site follows the F5 *product* design system, so the face is Inter,
# self-hosted and subsetted. Neusa Next Pro Wide and Proxima Nova belong to the
# marketing brand: correct there, a defect here, and licence-gated and unhosted
# besides, so swapping one in falls back to a system face for every visitor
# while every other check stays green.
FONT_TOKENS = ('var(--font)', 'var(--font-display)', 'var(--mono)')
# Declared literally on purpose: the @font-face family, and the metric-matched
# local fallback that holds the layout until the woff2 arrives.
FONT_LITERALS = ("'InterVariable'", "'Inter Fallback'")
RETIRED_FONTS = ('Neusa', 'Proxima')

# Sanctioned deviations, each with the reason it is allowed. A violation whose
# (file, line-content) matches one of these is reported as an exemption rather
# than a failure, so the list stays visible instead of silently shrinking.
EXEMPT = [
    ('font-size: 0.9em',
     'inline code sizes relative to its context, not off the scale'),
    ('border-radius: 50%',
     'a status dot and a spinner cannot take a 4px corner'),
    ("isDark ? '#0F1E57' : '#FFFFFF'",
     'a <meta> content attribute cannot hold a var() — asserted against '
     '--surface instead, below'),
]

SPACING_PROPS = r'(?<![\w-])(?:padding|margin|gap|row-gap|column-gap)[a-z-]*'

# Files from the pre-rebuild site that are still serving live pages and have
# not been replaced yet. Their violations are reported separately and do not
# fail the run, because deleting them before their pages are rebuilt would
# break the site mid-rebuild.
#
# THIS LIST MUST BE EMPTY when the rebuild lands. Every entry is a file that
# a later phase deletes outright — if one is still here at the end, either a
# phase was skipped or a file was kept that should not have been.
LEGACY = set()


def walk(directory, suffix):
    out = []
    for dirpath, _, names in os.walk(directory):
        for n in sorted(names):
            if n.endswith(suffix):
                out.append(os.path.join(dirpath, n))
    return out


def html_files():
    out = []
    for dirpath, dirnames, names in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames
                       if d not in ('.git', 'node_modules', '.claude', 'scripts')]
        for n in sorted(names):
            if n.endswith('.html'):
                out.append(os.path.join(dirpath, n))
    return out


def rel(path):
    return os.path.relpath(path, ROOT)


def is_exempt(line):
    for needle, _ in EXEMPT:
        if needle in line:
            return True
    return False


def strip_css_comments(text):
    """Blank out comment bodies but keep line count, so numbers stay accurate."""
    def blank(m):
        return re.sub(r'[^\n]', ' ', m.group(0))
    return re.sub(r'/\*.*?\*/', blank, text, flags=re.S)


class Check:
    def __init__(self):
        self.failures = []
        self.legacy = []
        self.exemptions = []

    def fail(self, path, lineno, message, line):
        entry = f'{rel(path)}:{lineno}  {message}\n       {line.strip()}'
        if rel(path) in LEGACY:
            self.legacy.append(entry)
        else:
            self.failures.append(entry)

    def note(self, path, lineno, line):
        # Deduplicated: two scans below (spacing/radius/type, then colour) share
        # the same EXEMPT list, so a line like `border-radius: 50%` is reached
        # by both and used to be listed — and counted — twice.
        if rel(path) in LEGACY:
            return
        entry = f'{rel(path)}:{lineno}  {line.strip()}'
        if entry not in self.exemptions:
            self.exemptions.append(entry)


def check_value_rules(c, path, lineno, line):
    """The declaration-local literal rules.

    Factored out so they can run over inline `style=` attributes as well as
    stylesheets. AGENTS.md names inline style= and JS-generated cssText as the
    two places raw values hide and calls them "easy to miss" — and they were
    exactly the two places nothing looked. Verified by planting
    `style="padding: 13px; border-radius: 9px; font-size: 11px;
    letter-spacing: .05em"` in the markup: the run reported "All design-token
    invariants hold", including the tracking AGENTS.md says appears nowhere.
    """
    # 12px is explicitly outside the F5DS spacing system.
    if re.search(SPACING_PROPS + r':[^;{}"]*\b12px', line):
        c.fail(path, lineno, '12px is not in the spacing system', line)

    # Radius comes from a token; 50% is exempted above.
    if re.search(r'border-radius:[^;}"]*\d+px', line):
        c.fail(path, lineno, 'literal border-radius (use --radius*)', line)

    # The pill token is 999, not 9999.
    if '9999px' in line:
        c.fail(path, lineno, '9999px (the pill token is 999px)', line)

    # Every font-size goes through the scale.
    if re.search(r'font-size: *[0-9]', line):
        c.fail(path, lineno, 'literal font-size (use --fs-*)', line)

    # The scale specifies no tracking anywhere.
    if 'letter-spacing' in line:
        c.fail(path, lineno, 'letter-spacing (the scale specifies none)', line)

    # Every font-family goes through a token, except the two literals the
    # @font-face block and its metric-matched fallback declare.
    m = re.search(r'font-family: *([^;}]+)', line)
    if m:
        value = m.group(1).strip()
        if any(f.lower() in value.lower() for f in RETIRED_FONTS):
            c.fail(path, lineno,
                   'marketing-brand typeface (this site is F5DS: Inter)', line)
        elif value not in FONT_TOKENS and value not in FONT_LITERALS:
            c.fail(path, lineno,
                   'literal font-family (use --font/--font-display/--mono)', line)

    # Off-system weights. A two-number value is a variable font's weight AXIS
    # RANGE in @font-face, not a weight being applied.
    m = re.search(r'font-weight: *([^;}]+)', line)
    if m:
        value = m.group(1).strip()
        if re.fullmatch(r'\d+', value) and value not in ('400', '500', '700'):
            c.fail(path, lineno, f'font-weight {value} (400/500/700 only)', line)

    # Arithmetic: every spacing literal a multiple of 4; >40 a multiple of 8.
    # 1px hairlines and the documented 2px label-to-control gap are excepted.
    for m in re.finditer(SPACING_PROPS + r': *([^;}]+)', line):
        for px in re.findall(r'-?\d+px', m.group(1)):
            n = abs(int(px[:-2]))
            if n % 4 and n not in (1, 2):
                c.fail(path, lineno, f'off-grid spacing {px}', line)
            elif n > 40 and n % 8:
                c.fail(path, lineno, f'spacing {px} above 40 is not /8', line)


def check_inline_styles(c, html_paths):
    """Run the same literal rules over every inline style= attribute."""
    for path in html_paths:
        with open(path, encoding='utf-8') as fh:
            for lineno, line in enumerate(fh, 1):
                for decls in re.findall(r'style="([^"]*)"', line):
                    if is_exempt(decls):
                        c.note(path, lineno, decls)
                        continue
                    check_value_rules(c, path, lineno, decls)
                    check_type_pairing(c, path, lineno, decls)


def check_type_pairing(c, path, lineno, block):
    """F5DS pairs a fixed leading with each size, so --fs-X needs --lh-X.

    AGENTS.md: "any rule that sets font-size must restate the paired --lh-*".
    Suffix-matching is the strict form and every existing site already
    satisfies it, so there is no reason to accept the loose one.
    """
    fs = re.search(r'font-size: *var\(--fs-([\w-]+)\)', block)
    if not fs:
        return
    lh = re.search(r'line-height: *var\(--lh-([\w-]+)\)', block)
    if not lh:
        c.fail(path, lineno, f'font-size --fs-{fs.group(1)} with no paired line-height', block)
    elif lh.group(1) != fs.group(1):
        c.fail(path, lineno,
               f'--fs-{fs.group(1)} paired with --lh-{lh.group(1)} (suffixes must match)',
               block)


def subset_codepoints():
    """The codepoints the shipped woff2 covers, read out of the font README.

    Parsed rather than duplicated, so the README stays the single source of
    truth for the subset — it is also the file that documents how to
    regenerate it.
    """
    path = os.path.join(ROOT, 'assets', 'fonts', 'README.md')
    if not os.path.isfile(path):
        return None
    with open(path, encoding='utf-8') as fh:
        m = re.search(r"--unicodes='([^']+)'", fh.read())
    if not m:
        return None
    allowed = set()
    for part in m.group(1).split(','):
        part = part.strip()
        if '-' in part:
            lo, hi = part.split('-')
            allowed.update(range(int(lo.replace('U+', ''), 16),
                                 int(hi.replace('U+', ''), 16) + 1))
        elif part:
            allowed.add(int(part.replace('U+', ''), 16))
    return allowed


def check_font_coverage(c, html_paths, js_paths):
    """Every rendered character must exist in the subsetted webfont.

    This is a silent-failure surface that only CONTENT work triggers, which is
    why nothing pointed at it: assets/fonts/README.md names the symptom
    exactly — "one glyph rendering in a different face" — but AGENTS.md sends
    you there only "before upgrading or re-subsetting", and the trigger is
    writing a new table row containing a character nobody thought about. No
    check, no reviewer and no screenshot at normal size catches one arrow
    rendering in the fallback face.

    Text nodes and JS string literals only: attribute values, class names and
    URLs never reach the page as glyphs.
    """
    allowed = subset_codepoints()
    if allowed is None:
        return
    for path in html_paths:
        with open(path, encoding='utf-8') as fh:
            raw = fh.read()
        raw = re.sub(r'<(script|style)\b.*?</\1>', ' ', raw, flags=re.S)
        for lineno, line in enumerate(raw.split('\n'), 1):
            # Strip tags so attribute values are not mistaken for content.
            for ch in re.sub(r'<[^>]*>', '', line):
                if ord(ch) > 127 and ord(ch) not in allowed:
                    c.fail(path, lineno,
                           f'U+{ord(ch):04X} {ch!r} is outside the webfont subset — it '
                           'will render in a fallback face (see assets/fonts/README.md)',
                           line)
    for path in js_paths:
        with open(path, encoding='utf-8') as fh:
            for lineno, line in enumerate(fh, 1):
                for lit in re.findall(r"'([^'\\]*)'|\"([^\"\\]*)\"", line):
                    for ch in (lit[0] or lit[1]):
                        if ord(ch) > 127 and ord(ch) not in allowed:
                            c.fail(path, lineno,
                                   f'U+{ord(ch):04X} {ch!r} is outside the webfont subset',
                                   line)


def check_manifest(c, expected):
    """site.webmanifest holds two colours that are copies of tokens.

    The theme-color check goes to real trouble asserting the four <meta> copies
    track --surface, and its file set is CSS + JS + root HTML — so the manifest
    was the one copy nobody looked at, in a repo whose most-repeated rule is
    never to write a raw value at a call site. JSON cannot hold a var(), so
    this asserts the value instead.

    `expected` is {json key: (token name, resolved value)}.
    """
    path = os.path.join(ROOT, 'site.webmanifest')
    if not os.path.isfile(path):
        return
    with open(path, encoding='utf-8') as fh:
        try:
            manifest = json.load(fh)
        except json.JSONDecodeError as err:
            c.fail(path, 1, f'site.webmanifest is not valid JSON: {err}', '')
            return
    for key, (token, want) in expected.items():
        got = manifest.get(key)
        if want and got and got.upper() != want.upper():
            c.fail(path, 1, f'{key} is {got}, but {token} is {want}', f'"{key}": "{got}"')


def run():
    c = Check()
    css = walk(CSS_DIR, '.css')
    js = walk(JS_DIR, '.js')
    html = html_files()

    if not css:
        sys.exit('no stylesheets found — is this being run from the repo root?')

    # ── CSS rules ─────────────────────────────────────────────────────────
    for path in css:
        with open(path, encoding='utf-8') as fh:
            raw = fh.read()
        for lineno, line in enumerate(strip_css_comments(raw).split('\n'), 1):
            if not line.strip():
                continue

            if is_exempt(line):
                c.note(path, lineno, line)
                continue

            check_value_rules(c, path, lineno, line)

            # Elevation is N700-tinted. Black is allowed only inside the dark
            # theme, where an 8% N700 tint would be invisible. Needs the
            # surrounding rule block, so it stays here rather than moving into
            # check_value_rules with the declaration-local rules.
            if re.search(r'box-shadow:[^;}"]*rgba\(0, *0, *0', line):
                if '.dark' not in raw[:raw.find(line)].rsplit('}', 1)[-1]:
                    c.fail(path, lineno, 'raw black shadow (use --elev-*)', line)

            # One focus idiom: outline, never a ring.
            if re.search(r':focus[^{]*\{[^}]*box-shadow', line):
                c.fail(path, lineno, 'focus via box-shadow (use outline)', line)

        # Type pairing is per rule BLOCK, not per line: the two declarations
        # are usually on consecutive lines.
        for block in re.finditer(r'\{[^{}]*\}', strip_css_comments(raw)):
            if 'font-size' not in block.group(0):
                continue
            if is_exempt(block.group(0)):
                continue
            lineno = raw[:block.start()].count('\n') + 1
            check_type_pairing(c, path, lineno, block.group(0))

    # ── Inline style= attributes ──────────────────────────────────────────
    check_inline_styles(c, html)

    # ── Webfont coverage ──────────────────────────────────────────────────
    check_font_coverage(c, html, js)

    # ── JS rules ──────────────────────────────────────────────────────────
    for path in js:
        with open(path, encoding='utf-8') as fh:
            for lineno, line in enumerate(fh, 1):
                if re.search(r"fontSize *= *['\"][0-9]", line):
                    c.fail(path, lineno, 'literal font-size in JS (use a class)', line)
                if 'letterSpacing' in line:
                    c.fail(path, lineno, 'letter-spacing in JS', line)
                if 'fontFamily' in line or 'font-family' in line:
                    c.fail(path, lineno, 'font-family in JS (use a class)', line)

    # ── Raw colour literals at call sites ─────────────────────────────────
    # "Never write a raw value at a call site" is the most-repeated rule in
    # AGENTS.md, and for colour it was unenforced: the only colour check below
    # is a list of RETIRED hexes by name, so any *new* hex passed. That is how
    # three raw hexes reached the print block in migration.css, duplicating
    # tokens that already existed.
    #
    # Colour belongs in tokens.css, so the consuming stylesheets are scanned.
    # Inline style= and JS cssText are NOT scanned yet: the theme-color metas
    # and the inline NGINX logo carry hexes that cannot be tokens, so that
    # extension needs an exemption list first.
    #
    # The exemption is per-VALUE, not per-line. An earlier version skipped any
    # line mentioning mask or gradient, which meant
    # `linear-gradient(#FF0000, #00FF00)` passed -- and a gradient is exactly
    # where an off-token colour hides. So: a literal with no hue (#000, #fff,
    # rgba(0,0,0,.5)) is allowed where it is doing structural work -- a mask
    # stop, a gradient stop, a scrim -- because there it means "opaque" or
    # "transparent" rather than a colour anyone perceives. Anything carrying
    # hue fails wherever it appears.
    # (?<!&) keeps an HTML numeric entity from reading as a colour. `&#9654;`
    # is the ▶ used in the reference tables; its four digits are a valid #RGBA
    # literal, so length alone cannot tell them apart — only the leading &.
    COLOURLESS = re.compile(r'(?<!&)#[0-9A-Fa-f]{3,8}\b|\brgba?\(')
    HEX = re.compile(r'(?<!&)#([0-9A-Fa-f]{3,8})\b')
    RGB = re.compile(r'\brgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)')

    def hues(line):
        """Colour literals on this line that are not pure greys."""
        found = []
        for m in HEX.finditer(line):
            h = m.group(1)
            if len(h) in (3, 4):
                h = ''.join(ch * 2 for ch in h)
            r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
            if not (r == g == b):
                found.append(m.group(0))
        for m in RGB.finditer(line):
            r, g, b = (float(x) for x in m.groups())
            if not (r == g == b):
                found.append(m.group(0))
        return found

    STRUCTURAL = re.compile(r'\b(mask|gradient|scrim)\b')

    # Two places a hex legitimately appears outside tokens.css, because neither
    # can hold a var(): the theme-color metas, and the inline NGINX logo's SVG
    # fills. The metas are not waved through — they are asserted against the
    # tokens further down, which is stricter than exempting them.
    EXEMPT_COLOUR = re.compile(r'theme-color|(?:fill|stroke)="#|updateThemeColorMeta')

    for path in css + js + html:
        with open(path, encoding='utf-8') as fh:
            text = fh.read()
        if path.endswith('tokens.css'):       # colour is defined here by design
            continue
        if path.endswith('.html'):
            text = re.sub(r'<!--.*?-->', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), text, flags=re.S)
        text = strip_css_comments(text)
        if path.endswith('.js'):
            text = re.sub(r'//[^\n]*', '', text)
        for lineno, line in enumerate(text.split('\n'), 1):
            if 'data:image/svg' in line:      # percent-encoded fill inside a URL
                continue
            if EXEMPT_COLOUR.search(line):
                continue
            if is_exempt(line):
                c.note(path, lineno, line)
                continue
            bad = hues(line)
            if bad:
                c.fail(path, lineno,
                       f'raw colour at a call site ({bad[0]}) — define it in tokens.css', line)
            elif COLOURLESS.search(line) and not STRUCTURAL.search(line):
                c.fail(path, lineno,
                       'raw grey at a call site — use a neutral token', line)


    # ── Retired colours ───────────────────────────────────────────────────
    # The previous marketing palette, plus Kubernetes blue. F5 Brand Red is on
    # this list because F5DS restricts it to the logo, illustrations and
    # pictograms and forbids it as a CTA, link, accent or error colour.
    retired = {
        '#326CE5': 'Kubernetes blue — use --blue (Dodger Blue)',
        '#1A4CB5': 'Kubernetes blue shade — use --blue-text',
        '#E4002B': 'F5 Brand Red — logo/illustration only, never an accent',
        '#B30013': 'F5 Red 5 — use --pomegranate-text',
        '#009C93': 'Surf — use --java',
        '#007A76': 'Surf 5 — use --java-text',
        '#F29A36': 'Tangerine — use --amber',
        '#C96718': 'Tangerine 5 — use --amber',
        '#933DCC': 'Eggplant — use --purple',
        '#6E23A1': 'Eggplant 5 — use --purple-text',
        '#0072B0': 'Bay — use --blue',
        '#045B91': 'Bay 5 — use --blue-text',
        '#9C1174': 'Raspberry — inline code is now neutral on a tint',
        '#FAF9F7': 'marketing snow — use --bg (N100)',
        '#222222': 'marketing carbon — use --text (N600) or --code-bg',
        '#666666': 'marketing grey — use --text-secondary',
        '#E6E6E6': 'marketing border — use --border (N200)',
        '#D5D6D6': 'marketing code foreground — use --code-fg',
        '#CCCCCC': 'marketing control border — use --border-control',
        '#F5F5F5': 'marketing row hover — use --surface-sunken',
    }
    # Comments are stripped first: a file is allowed to *name* a retired colour
    # in prose explaining why it is retired, which is not the same as using it.
    for path in css + js + html:
        with open(path, encoding='utf-8') as fh:
            text = fh.read()
        if path.endswith('.html'):
            text = re.sub(r'<!--.*?-->',
                          lambda m: re.sub(r'[^\n]', ' ', m.group(0)), text, flags=re.S)
        text = strip_css_comments(text)          # also covers /* */ in JS
        if path.endswith('.js'):
            text = re.sub(r'//[^\n]*', '', text)
        for lineno, line in enumerate(text.split('\n'), 1):
            upper = line.upper()
            for hexval, why in retired.items():
                if hexval in upper:
                    c.fail(path, lineno, f'retired colour {hexval}: {why}', line)

    # ── theme-color must track --surface ──────────────────────────────────
    # The browser paints its own UI with these, so they should match the top
    # bar. They live in a <meta content> and in a setAttribute call, neither of
    # which can hold a var(), so the only way to keep them honest is to assert
    # them: four copies of two values, and nothing else would notice a drift.
    with open(os.path.join(CSS_DIR, 'tokens.css'), encoding='utf-8') as fh:
        tokens_src = strip_css_comments(fh.read())

    def resolve(name, block, fallback=''):
        # A dark-theme token often points at a base neutral that is only
        # declared in :root, so each hop falls back to the base block.
        seen = 0
        while name.startswith('--') and seen < 8:
            m = (re.search(re.escape(name) + r'\s*:\s*([^;]+);', block)
                 or re.search(re.escape(name) + r'\s*:\s*([^;]+);', fallback))
            if not m:
                return None
            value = m.group(1).strip()
            m2 = re.fullmatch(r'var\((--[\w-]+)\)', value)
            if not m2:
                return value.upper()
            name = m2.group(1)
            seen += 1
        return None

    root = re.search(r':root\s*\{(.*?)\n\}', tokens_src, re.S)
    darkm = re.search(r'\)\.dark-mode\s*\{(.*?)\n    \}', tokens_src, re.S)
    if root and darkm:
        want_light = resolve('--surface', root.group(1))
        want_dark = (resolve('--surface', darkm.group(1), root.group(1))
                     or want_light)
        for path in html + js:
            with open(path, encoding='utf-8') as fh:
                for lineno, line in enumerate(fh, 1):
                    if 'theme-color' not in line and 'isDark ?' not in line:
                        continue
                    found = [h.upper() for h in re.findall(r'#[0-9A-Fa-f]{6}', line)]
                    if not found:
                        continue
                    for hexv in found:
                        if hexv not in (want_light, want_dark):
                            c.fail(path, lineno,
                                   f'theme-color {hexv} matches neither --surface '
                                   f'({want_light} light, {want_dark} dark)', line)

        # The manifest's two colours are copies of the same light-theme tokens.
        check_manifest(c, {
            'theme_color': ('--surface', want_light),
            'background_color': ('--bg', resolve('--bg', root.group(1))),
        })

    # ── Undefined custom properties ───────────────────────────────────────
    # An unresolvable var() does not error, it silently yields nothing — the
    # declaration is dropped and the element falls back to an inherited or
    # initial value. That is invisible in review and often invisible in the
    # browser too, so it is worth asserting.
    defined = set()
    used = {}
    for path in css:
        with open(path, encoding='utf-8') as fh:
            text = strip_css_comments(fh.read())
        defined.update(re.findall(r'(--[\w-]+)\s*:', text))
        for lineno, line in enumerate(text.split('\n'), 1):
            for name in re.findall(r'var\(\s*(--[\w-]+)', line):
                used.setdefault(name, (path, lineno, line))

    # JS and HTML too: migration-core.js sets inline styles that resolve tokens
    # (`calc(100% + var(--space-base))`), and a token referenced only from there
    # would otherwise read as unreferenced below.
    for path in js + html:
        with open(path, encoding='utf-8') as fh:
            for lineno, line in enumerate(fh, 1):
                for name in re.findall(r'var\(\s*(--[\w-]+)', line):
                    used.setdefault(name, (path, lineno, line))

    for name, (path, lineno, line) in sorted(used.items()):
        if name not in defined:
            c.fail(path, lineno, f'undefined custom property {name}', line)

    # Unused tokens are reported, not failed — some exist for pages not yet
    # rebuilt, and a design system carries a little slack by design.
    #
    # The count alone used to be printed, which is why four of these sat here
    # unnoticed through two reviews: a bare "5 unreferenced" is not actionable.
    # The names are listed now, minus the ones that are unreferenced ON PURPOSE
    # because they complete a published scale. Deleting a rung from a ramp makes
    # tokens.css a worse reference than leaving it, and this file IS the
    # reference — AGENTS.md calls it "THE design surface".
    SCALE_COMPLETE = {
        '--n500':        'a rung of the F5DS N0–N700 neutral ramp',
        '--icon-subtle': 'completes the icon pair with --icon',
        '--purple-text': 'completes the accessible-text set with --pomegranate-text / --java-text; '
                         'also named by this script as the remedy for retired Eggplant 5',
        '--dur-travel':  'D5 of the F5DS motion scale, alongside D2/D3/D4',
        '--space-4hx':   'the 36px half-step; 2hx/3hx are both in use, so the '
                         'gap would be the odd one out',
    }
    unused = sorted(n for n in defined if n not in used)
    unexplained = [n for n in unused if n not in SCALE_COMPLETE]

    # ── Report ────────────────────────────────────────────────────────────
    scanned = len(css) + len(js) + len(html)
    print(f'Scanned {scanned} files '
          f'({len(css)} css, {len(js)} js, {len(html)} html)')
    print(f'{len(defined)} custom properties defined, {len(used)} referenced, '
          f'{len(unused)} unreferenced\n')

    if unused:
        kept = [n for n in unused if n in SCALE_COMPLETE]
        if kept:
            print(f'{len(kept)} unreferenced by design (scale completeness — do not delete):')
            for n in kept:
                print(f'  {n} — {SCALE_COMPLETE[n]}')
            print()
        if unexplained:
            print(f'{len(unexplained)} unreferenced and unexplained '
                  f'(reported, not failed):')
            for n in unexplained:
                print(f'  {n}')
            print('  Either use it, delete it, or add it to SCALE_COMPLETE '
                  'in this script with the reason.\n')

    if c.exemptions:
        print(f'{len(c.exemptions)} sanctioned deviation(s):')
        for e in c.exemptions:
            print(f'  {e}')
        for needle, why in EXEMPT:
            print(f'    "{needle}" — {why}')
        print()

    if c.legacy:
        missing = sorted(p for p in LEGACY
                         if not os.path.exists(os.path.join(ROOT, p)))
        print(f'{len(c.legacy)} violation(s) in {len(LEGACY) - len(missing)} '
              f'pre-rebuild file(s) still serving live pages — not failing the run.')
        print('  Remove each from LEGACY in this script as its phase lands.\n')

    if c.failures:
        print(f'{len(c.failures)} violation(s):')
        for f in c.failures:
            print(f'  {f}')
        return 1

    if LEGACY:
        print('All design-token invariants hold in rebuilt files.')
        print(f'{len(LEGACY)} pre-rebuild file(s) still pending replacement.')
    else:
        print('All design-token invariants hold.')
    return 0


if __name__ == '__main__':
    sys.exit(run())
