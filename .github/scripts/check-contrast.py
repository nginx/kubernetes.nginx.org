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
# serves this branch verbatim (.nojekyll), and a plain scripts/ directory
# was being published — verified: /scripts/check-tokens.py returned 200,
# while dot-directories 404.
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


def main():
    with open(TOKENS, encoding='utf-8') as fh:
        blocks = parse_blocks(fh.read())

    failures = []
    for theme in ('light', 'dark'):
        print(f'\n{theme.upper()} THEME')
        print('-' * 62)
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
            if not ok:
                failures.append(f'{theme}: {desc} — {r:.2f}:1, needs {minimum}')
            print(f'  {"PASS" if ok else "FAIL"}  {r:5.2f}:1  (min {minimum})  {desc}')

        print('  --  status hues, reported not asserted; never used as text  --')
        surf = to_rgba(resolve('--surface', theme, blocks))
        for s in STATUS:
            r = contrast(to_rgba(resolve(s, theme, blocks)), surf)
            print(f'        {r:5.2f}:1            {s[2:]} mark on a card')

    print()
    if failures:
        print(f'{len(failures)} contrast failure(s):')
        for f in failures:
            print(f'  - {f}')
        return 1
    print('All colour pairings clear WCAG 2.1 AA.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
