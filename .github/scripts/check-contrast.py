#!/usr/bin/env python3
"""Assert every meaningful colour pairing in tokens.css clears WCAG 2.1 AA.

F5DS publishes no accessibility guidance at all, so this file *is* the site's
contrast contract. It parses assets/css/tokens.css, resolves var() indirection
and alpha compositing, and fails loudly on any regression.

Usage:  python3 .github/scripts/check-contrast.py
Exit:   0 all pass, 1 one or more failures.
"""
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
TOKENS = os.path.join(ROOT, 'assets', 'css', 'tokens.css')

TEXT_AA = 4.5       # normal-size text
LARGE_AA = 3.0      # >=24px, or >=19px bold
NONTEXT_AA = 3.0    # meaningful icons, focus rings, control boundaries


# ── parsing ────────────────────────────────────────────────────────────────

def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def parse_blocks(css):
    """Return {theme: {token: raw-value}} for the :root and .dark blocks."""
    css = strip_comments(css)
    blocks = {}
    for selector, theme in ((r':root', 'light'), (r'\)\.dark-mode', 'dark')):
        m = re.search(selector + r'\s*\{(.*?)\n\}', css, flags=re.S)
        if not m:
            sys.exit(f'could not find the {theme} block in tokens.css')
        decls = {}
        for name, value in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', m.group(1)):
            decls[name] = value.strip()
        blocks[theme] = decls
    return blocks


def resolve(token, theme, blocks, depth=0):
    """Resolve a token to a literal, following var() and theme inheritance."""
    if depth > 12:
        sys.exit(f'circular var() reference at {token}')
    table = blocks[theme]
    raw = table.get(token)
    if raw is None and theme == 'dark':
        raw = blocks['light'].get(token)
    if raw is None:
        sys.exit(f'unknown token {token} in {theme}')
    m = re.fullmatch(r'var\((--[\w-]+)\)', raw)
    if m:
        return resolve(m.group(1), theme, blocks, depth + 1)
    return raw


def to_rgba(value):
    """'#RRGGBB' or 'rgba(r, g, b, a)' -> (r, g, b, a) with 0-255 channels."""
    value = value.strip()
    if value.startswith('#'):
        h = value[1:]
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
    m = re.fullmatch(r'rgba?\(([^)]+)\)', value)
    if not m:
        sys.exit(f'cannot parse colour {value!r}')
    parts = [p.strip() for p in m.group(1).split(',')]
    r, g, b = (int(float(p)) for p in parts[:3])
    a = float(parts[3]) if len(parts) > 3 else 1.0
    return (r, g, b, a)


def composite(fg, bg):
    """Flatten a translucent colour over an opaque one."""
    fr, fg_, fb, fa = fg
    br, bg_, bb, _ = bg
    return (round(fr * fa + br * (1 - fa)),
            round(fg_ * fa + bg_ * (1 - fa)),
            round(fb * fa + bb * (1 - fa)),
            1.0)


# ── contrast ───────────────────────────────────────────────────────────────

def _lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgba):
    r, g, b, _ = rgba
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast(fg, bg):
    la, lb = luminance(fg), luminance(bg)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# ── the contract ───────────────────────────────────────────────────────────
# (foreground token, background token, minimum, human description)

PAIRS = [
    ('--text', '--surface', TEXT_AA, 'body text on a card'),
    ('--text', '--bg', TEXT_AA, 'body text on the page'),
    ('--text-secondary', '--surface', TEXT_AA, 'secondary text on a card'),
    ('--text-secondary', '--bg', TEXT_AA, 'secondary text on the page'),
    ('--icon', '--surface', NONTEXT_AA, 'meaningful icon on a card'),
    ('--icon', '--bg', NONTEXT_AA, 'meaningful icon on the page'),
    ('--green-text', '--surface', TEXT_AA, 'green link/label on a card'),
    ('--green-text', '--bg', TEXT_AA, 'green link/label on the page'),
    ('--blue-text', '--surface', TEXT_AA, 'blue link/label on a card'),
    ('--blue-text', '--bg', TEXT_AA, 'blue link/label on the page'),
    ('--text', '--emerald-tint', TEXT_AA, 'notification text, positive'),
    ('--text', '--amber-tint', TEXT_AA, 'notification text, attention'),
    ('--text', '--pomegranate-tint', TEXT_AA, 'notification text, negative'),
    ('--text', '--purple-tint', TEXT_AA, 'notification text, informative'),
    ('--code-fg', '--code-bg', TEXT_AA, 'code on the code surface'),
    ('--text', '--code-chip-bg', TEXT_AA, 'inline code on its chip wash'),
    ('--on-blue-tint', '--blue-tint', TEXT_AA, 'inline code on the blue wash'),
    ('--border-control', '--surface', NONTEXT_AA, 'control boundary on a card'),
    ('--border-control', '--bg', NONTEXT_AA, 'control boundary on the page'),
]

# Deliberately NOT in the contract, with the reason.
#
# --border / --border-strong are decorative dividers. WCAG 1.4.11 covers
# "visual information required to identify user interface components", and a
# card edge or table rule identifies nothing. Control boundaries are checked
# above, via --border-control.
#
# The status hues are not checked as marks either, and this one deserves
# spelling out because it looks like an exemption and is not. Emerald and
# Amber cannot reach 3:1 on white at any usable saturation -- measured on N0
# they are 2.02:1 and 1.60:1, and even F5DS's own published hover values only
# reach 2.95:1 and 2.23:1. No token at those hues can pass. F5DS resolves this
# by never letting colour carry meaning alone: each sentiment gets a distinct
# ICON SHAPE, every status dot ships with its text label, and body text stays
# N600 in all four sentiments. So the hue is always redundant reinforcement.
# That rule is enforced in the component layer, not here: a status dot must
# never be rendered without its text label, and a notification must never be
# rendered without its sentiment icon.
#
# The corollary is a hard prohibition -- a status hue is NEVER used as text.
# The console does exactly this: in its services table the word "Enabled" is
# N600 and only the dot beside it is green. Setting a label in Emerald or
# Amber would be unreadable and is off-system in both directions.
#
# Their measured values are reported below as information, so a future change
# to these tokens is visible, but they are not assertions.
STATUS = ['--emerald', '--amber', '--pomegranate', '--purple', '--java']

# CRD badges. One entry per graph-colour family; the token names are identical
# in both themes and resolve to that theme's values, so this list is shared
# rather than split. These were previously unchecked — the badge palette was
# the largest set of colour pairings on the site with no assertion behind it.
BADGES = [
    ('--badge-vs-fg',     '--badge-vs-bg',     'VirtualServer badge'),
    ('--badge-vsr-fg',    '--badge-vsr-bg',    'VirtualServerRoute badge'),
    ('--badge-policy-fg', '--badge-policy-bg', 'Policy badge'),
    ('--badge-ts-fg',     '--badge-ts-bg',     'TransportServer badge'),
    ('--badge-cm-fg',     '--badge-cm-bg',     'ConfigMap badge'),
    ('--badge-plus-fg',   '--badge-plus-bg',   'NGINX Plus badge'),
    ('--badge-new-fg',    '--badge-new-bg',    'New badge'),
    ('--badge-gc-fg',     '--badge-gc-bg',     'GlobalConfiguration badge (neutral)'),
]

# Filled buttons: the label colour differs per theme, so these are declared
# per theme rather than as shared pairs.
BUTTONS = {
    'light': [('--n0', '--green-text', 'white on the green primary button'),
              ('--n0', '--blue-text', 'white on the blue primary button')],
    'dark':  [('--n700', '--green', 'dark label on the green primary button'),
              ('--n700', '--blue', 'dark label on the blue primary button')],
}


# ── derived pairings ───────────────────────────────────────────────────────
# The hand-written list above is the contract, but it only asserts what someone
# remembered to add — AGENTS.md concedes as much ("a new coloured surface is
# unchecked until someone adds it; that is how the badge palette drifted").
# This finds every rule that sets both a colour and a background through tokens
# and measures it, which turns up pairings nobody listed. It found the
# ingress2gateway version pill at 4.25:1 in dark.
#
# Two rules keep it honest rather than noisy:
#
#   Theme scoping. A rule whose selector mentions .dark-mode applies only in
#   dark; every other rule is measured in light. Measuring an unscoped rule in
#   BOTH themes is wrong, because a dark override may replace either half of
#   the pair, and doing so produces 8 false positives out of 18 — the primary
#   CTAs, whose dark rules swap both background and label.
#
#   An exemption list, per foreground token, with the reason.
DERIVED_EXEMPT = {
    '--text-disabled':
        'WCAG 1.4.3 exempts disabled controls; the whole point of the token is '
        'to read as unavailable',
    '--n300':
        'only ever used on --on-code surfaces, which are dark in both themes',
    '--n0':
        'white label on a filled control — the fill is the pairing that '
        'matters and is asserted by BUTTONS above',
}
# Backgrounds that are dark in BOTH themes, so a "light theme" reading of them
# is meaningless: the VS Code code palette is a documented deviation.
DERIVED_EXEMPT_BG = {
    '--on-code': 'the code surface is dark in both themes',
    '--on-code-strong': 'the code surface is dark in both themes',
    '--code-bg': 'the code surface is dark in both themes',
}


DARK_PREFIX = re.compile(r'^:is\(html,\s*body\)\.dark-mode\s+')


def split_selectors(selector):
    """Split a selector list on top-level commas only.

    A naive split breaks `:is(html, body).dark-mode` into `:is(html` and
    `body).dark-mode`, which silently turns every dark override in the codebase
    into two nonsense selectors — and then reports the light theme's own
    primary buttons as failures.
    """
    parts, depth, current = [], 0, ''
    for ch in selector:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(current.strip())
            current = ''
        else:
            current += ch
    parts.append(current.strip())
    return [p for p in parts if p]


def _rules():
    """(file, selector-list, body) for every rule in the stylesheets."""
    css_dir = os.path.join(ROOT, 'assets', 'css')
    for name in sorted(os.listdir(css_dir)):
        if not name.endswith('.css'):
            continue
        with open(os.path.join(css_dir, name), encoding='utf-8') as fh:
            css = strip_comments(fh.read())
        for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', css):
            selector = ' '.join(m.group(1).split())
            if selector.startswith('@'):
                continue
            yield name, split_selectors(selector), m.group(2)


def derived_pairs():
    """Every (fg, bg, theme) a stylesheet declares through tokens.

    Handles the case that produced the live defect this check was written for:
    a dark-mode rule that overrides ONLY the colour and inherits its background
    from the base rule. Measuring the base rule in light and ignoring the
    override leaves that pairing unmeasured in the theme where it fails — which
    is how .version-pill.i2g sat at 4.25:1 in dark.
    """
    backgrounds = {}
    for _, selectors, body in _rules():
        bg = re.search(r'background(?:-color)?:\s*var\((--[\w-]+)\)', body)
        if bg:
            for sel in selectors:
                backgrounds[sel] = bg.group(1)

    found = {}
    for name, selectors, body in _rules():
        fg = re.search(r'(?<!-)color:\s*var\((--[\w-]+)\)', body)
        if not fg:
            continue
        own_bg = re.search(r'background(?:-color)?:\s*var\((--[\w-]+)\)', body)
        for sel in selectors:
            dark = 'dark-mode' in sel
            if own_bg:
                bg_token = own_bg.group(1)
            elif dark:
                # Inherited from the rule this one overrides.
                bg_token = backgrounds.get(DARK_PREFIX.sub('', sel))
            else:
                bg_token = None
            if not bg_token:
                continue
            key = (fg.group(1), bg_token, 'dark' if dark else 'light')
            found.setdefault(key, f'{name}  {sel[:60]}')
    return found


def check_derived(blocks):
    failures = []
    checked = 0
    for (fg_t, bg_t, theme), where in sorted(derived_pairs().items()):
        if fg_t in DERIVED_EXEMPT or bg_t in DERIVED_EXEMPT_BG:
            continue
        bg = to_rgba(resolve(bg_t, theme, blocks))
        if bg[3] < 1.0:
            bg = composite(bg, to_rgba(resolve('--surface', theme, blocks)))
        fg = to_rgba(resolve(fg_t, theme, blocks))
        if fg[3] < 1.0:
            fg = composite(fg, bg)
        checked += 1
        r = contrast(fg, bg)
        if r < TEXT_AA:
            failures.append(f'{theme}: {fg_t} on {bg_t} — {r:.2f}:1, needs {TEXT_AA}  ({where})')
    return failures, checked


# ── the measured-ratio comments ────────────────────────────────────────────
# tokens.css is the reference AGENTS.md points at for every measured ratio, and
# six of the twelve parseable comments were wrong. They all erred safe, which is
# exactly why nobody noticed. Note that parse_blocks strips comments before
# reading declarations, so this reads the raw file.
RATIO_COMMENT = re.compile(
    r'(--[\w-]+):\s*(#[0-9A-Fa-f]{3,8});\s*/\*\s*([0-9.]+):1 on (N\d+)')


def check_ratio_comments(blocks):
    with open(TOKENS, encoding='utf-8') as fh:
        raw = fh.read()
    failures = []
    checked = 0
    for lineno, line in enumerate(raw.split('\n'), 1):
        m = RATIO_COMMENT.search(line)
        if not m:
            continue
        token, hexv, claimed, neutral = m.groups()
        # Which theme the line belongs to: the dark block redeclares the same
        # token names, and N600/N700 backgrounds only exist there.
        theme = 'dark' if neutral in ('N600', 'N700') else 'light'
        bg = to_rgba(resolve('--' + neutral.lower(), theme, blocks))
        actual = contrast(to_rgba(hexv), bg)
        checked += 1
        if abs(actual - float(claimed)) > 0.02:
            failures.append(f'tokens.css:{lineno}  {token} comment says {claimed}:1 on '
                            f'{neutral}, measures {actual:.2f}:1')
    return failures, checked


def main():
    # Quiet by default. Sixty PASS lines are ~1,200 tokens of "nothing is
    # wrong", reprinted every time anyone verifies anything; the measurements
    # matter when you are choosing a colour, not when you are confirming you
    # broke nothing. FAIL lines always print, at any verbosity.
    verbose = '-v' in sys.argv or '--verbose' in sys.argv

    def say(text, always=False):
        if verbose or always:
            print(text)

    with open(TOKENS, encoding='utf-8') as fh:
        blocks = parse_blocks(fh.read())

    failures = []
    n_pairs = 0
    for theme in ('light', 'dark'):
        say(f'\n{theme.upper()} THEME')
        say('-' * 62)
        checks = [(f, b, m, d) for f, b, m, d in PAIRS]
        checks += [(f, b, TEXT_AA, d) for f, b, d in BUTTONS[theme]]
        checks += [(f, b, TEXT_AA, d) for f, b, d in BADGES]

        for fg_t, bg_t, minimum, desc in checks:
            bg = to_rgba(resolve(bg_t, theme, blocks))
            if bg[3] < 1.0:                       # tints composite over the page
                bg = composite(bg, to_rgba(resolve('--surface', theme, blocks)))
            fg = to_rgba(resolve(fg_t, theme, blocks))
            if fg[3] < 1.0:
                fg = composite(fg, bg)
            r = contrast(fg, bg)
            ok = r >= minimum
            n_pairs += 1
            if not ok:
                failures.append(f'{theme}: {desc} — {r:.2f}:1, needs {minimum}')
            say(f'  {"PASS" if ok else "FAIL"}  {r:5.2f}:1  (min {minimum})  {desc}',
                always=not ok)

        say('  --  status hues, reported not asserted; never used as text  --')
        surf = to_rgba(resolve('--surface', theme, blocks))
        for s in STATUS:
            r = contrast(to_rgba(resolve(s, theme, blocks)), surf)
            say(f'        {r:5.2f}:1            {s[2:]} mark on a card')

    say('\nDERIVED FROM THE STYLESHEETS')
    say('-' * 62)
    derived, n_derived = check_derived(blocks)
    say(f'  {len(derived)} failure(s) across {n_derived} token pairing(s) declared in CSS')
    for d in derived:
        print(f'    FAIL  {d}')
    failures += derived

    say('\nMEASURED-RATIO COMMENTS IN tokens.css')
    say('-' * 62)
    comments, n_comments = check_ratio_comments(blocks)
    say(f'  {len(comments)} wrong of {n_comments} parseable')
    for c in comments:
        print(f'    FAIL  {c}')
    failures += comments

    if failures:
        print(f'\n{len(failures)} contrast failure(s):')
        for f in failures:
            print(f'  - {f}')
        return 1
    # The counts are the assertion: "all clear" means nothing if the reason is
    # that nothing was measured.
    print(f'contrast OK — {n_pairs} asserted pairings, {n_derived} derived from '
          f'CSS, {n_comments} ratio comments, both themes.  -v for every measurement.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
