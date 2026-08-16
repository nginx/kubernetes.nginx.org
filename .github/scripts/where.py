#!/usr/bin/env python3
"""Locate things in this repo without reading the big files whole.

The migration page is 5,317 lines; its `#mappings` section alone spans lines
457-3813, and the source module is another 2,000. An agent that greps, guesses a
range, reads 400 lines, misses, and reads 400 more spends tens of thousands of
tokens to edit one 30-line table row. This prints the exact range instead.

    .github/scripts/where.py rewrite-target      # an annotation, everywhere it lives
    .github/scripts/where.py '#mappings'         # a section or heading anchor
    .github/scripts/where.py .version-pill       # a CSS class, every rule
    .github/scripts/where.py --green-text        # a token: value, dark override, uses
    .github/scripts/where.py --list green        # every green token, light and dark
    .github/scripts/where.py --list             # all 103, a fifth the size of tokens.css
    .github/scripts/where.py filterTable         # a JS function
    .github/scripts/where.py rewrite-target -s   # ...and print the lines

It **exits 1 when it finds nothing**, and says so. A locator that silently
returns empty is the same failure mode as a check that silently passes: you
conclude the thing is absent when in fact your query was wrong.

Lives under .github/ because GitHub Pages publishes this branch.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PAGES = ['index.html', 'ingress-nginx-migration.html']
CSS = ['assets/css/tokens.css', 'assets/css/shared.css',
       'assets/css/index.css', 'assets/css/migration.css']
JS = ['assets/js/shared.js', 'assets/js/index.js', 'assets/js/migration-core.js',
      'assets/js/migration-ingress-nginx.js']

# Source modules define ANNOTATION_MAPPINGS; the core deliberately does not.
SOURCES = [p for p in JS if p.startswith('assets/js/migration-')
           and not p.endswith('migration-core.js')]


def read(rel):
    """Lines of a repo file, or [] if it is not present on this branch."""
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as fh:
        return fh.read().split('\n')


def strip_js(line):
    """Blank out string literals and line comments before counting braces.

    `template: "satisfy ${value};"` is balanced, but plenty of strings are not,
    and a regex literal certainly is not. Counting raw characters walks off the
    end of the file roughly one time in ten.
    """
    out, i, quote = [], 0, None
    while i < len(line):
        ch = line[i]
        if quote:
            if ch == '\\':
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in '"\'`':
            quote = ch
            i += 1
            continue
        if line.startswith('//', i):
            break
        out.append(ch)
        i += 1
    return ''.join(out)


def brace_extent(lines, start, strip=True, limit=400):
    """Index of the line closing the block that opens on `start`."""
    depth, seen = 0, False
    for i in range(start, min(len(lines), start + limit)):
        text = strip_js(lines[i]) if strip else lines[i]
        for ch in text:
            if ch == '{':
                depth += 1
                seen = True
            elif ch == '}':
                depth -= 1
                if seen and depth <= 0:
                    return i
    return min(start + 40, len(lines) - 1)


class Hit:
    def __init__(self, kind, rel, start, end, note=''):
        self.kind, self.rel, self.note = kind, rel, note
        self.start, self.end = start + 1, end + 1     # 1-indexed, as Read reports

    @property
    def span(self):
        return self.end - self.start + 1


# ── Annotations ───────────────────────────────────────────────────────────────
# The one rule that cannot wait (AGENTS.md) is that the mapping, the reference
# row and the example YAML in its panel must agree. So resolve all three at
# once — the whole point is that you edit them together.

def find_annotation(name):
    bare = name.split('/')[-1].strip()
    hits, generators = [], set()

    for rel in SOURCES:
        lines = read(rel)
        for i, line in enumerate(lines):
            m = re.search(r'community:\s*\[([^\]]*)\]', line)
            if not m or bare not in re.findall(r'"([^"]+)"', m.group(1)):
                continue
            open_at = line.index('{')
            end = brace_extent(lines, i)
            block = '\n'.join(lines[i:end + 1])
            cat = re.search(r'category:\s*"([^"]+)"', block)
            hits.append(Hit('mapping', rel, i, end,
                            cat.group(1) if cat else ''))
            generators.update(re.findall(r'templateFn:\s*"([^"]+)"', block))
            del open_at

        # Generators are object-literal members (`generateFoo: function(found) {`),
        # not declarations — matching only `function foo(` finds nothing at all,
        # which is how this was wrong the first time.
        for fn in sorted(generators):
            for i, line in enumerate(lines):
                if re.search(r'(?:function\s+%s\s*\(|\b%s\s*:\s*function\s*\()'
                             % (re.escape(fn), re.escape(fn)), line):
                    hits.append(Hit('generator', rel, i,
                                    brace_extent(lines, i, limit=800), fn))
                    break

    # The reference row: a `<tr class="expandable">` whose block names the
    # annotation, extended through the `example-row` that carries the YAML.
    for rel in PAGES:
        lines = read(rel)
        starts = [i for i, l in enumerate(lines) if 'class="expandable"' in l]
        for n, i in enumerate(starts):
            end = (starts[n + 1] - 1) if n + 1 < len(starts) else len(lines) - 1
            for j in range(i, min(end + 1, len(lines))):
                if '</tbody>' in lines[j]:
                    end = j - 1
                    break
            block = '\n'.join(lines[i:end + 1])
            # The code span may carry a value — `auth-type: "basic"` — so do not
            # require `</code>` to follow the name. The `(?![\w-])` boundary is
            # what stops `auth-secret` also matching `auth-secret-type`.
            if not re.search(r'<code>[a-z.]*/%s(?![\w-])[^<]*</code>' % re.escape(bare),
                             block):
                continue
            heading = ''
            for j in range(i, -1, -1):
                m = re.search(r'<h3 id="([^"]+)"', lines[j])
                if m:
                    heading = '#' + m.group(1)
                    break
            hits.append(Hit('reference row', rel, i, end, heading))
    return hits


# ── Sections and heading anchors ──────────────────────────────────────────────

def find_anchor(name):
    want = name.lstrip('#')
    hits = []
    for rel in PAGES:
        lines = read(rel)
        for i, line in enumerate(lines):
            m = re.search(r'<(section|h2|h3|div)[^>]*\bid="%s"' % re.escape(want), line)
            if not m:
                continue
            tag = m.group(1)
            # Bound the read at the next peer: another section, or the next
            # heading of the same or higher rank.
            stop = r'<section[^>]*\bid=' if tag == 'section' else \
                   (r'<(section|h2)[^>]*\bid=' if tag == 'h2' else
                    r'<(section|h2|h3)[^>]*\bid=')
            end = len(lines) - 1
            for j in range(i + 1, len(lines)):
                if re.search(stop, lines[j]):
                    end = j - 1
                    break
            hits.append(Hit(tag, rel, i, end))
    return hits


# ── CSS classes and tokens ────────────────────────────────────────────────────

def find_class(name):
    cls = name.lstrip('.')
    pattern = re.compile(r'\.%s(?![\w-])' % re.escape(cls))
    hits = []
    for rel in CSS:
        lines = read(rel)
        for i, line in enumerate(lines):
            if not pattern.search(line) or '{' not in line:
                continue
            hits.append(Hit('rule', rel, i, brace_extent(lines, i, strip=False, limit=120),
                            line.split('{')[0].strip()[:72]))
    return hits


def find_token(name):
    var = name if name.startswith('--') else '--' + name
    hits, uses = [], []
    for rel in CSS:
        lines = read(rel)
        for i, line in enumerate(lines):
            m = re.match(r'\s*%s\s*:\s*(.+?);' % re.escape(var), line)
            if m:
                # Which block is it in — :root, or the dark theme override?
                scope = ''
                for j in range(i, -1, -1):
                    if '{' in lines[j] and ':' not in lines[j].split('{')[0]:
                        pass
                    sel = lines[j].split('{')[0].strip()
                    if '{' in lines[j] and sel:
                        scope = sel[:48]
                        break
                hits.append(Hit('value', rel, i, i, '%s   [%s]' % (m.group(1), scope)))
        n = sum(l.count('var(%s' % var) for l in lines)
        if n:
            uses.append('%s x%d' % (rel, n))
    for rel in PAGES + JS:
        n = sum(l.count('var(%s' % var) for l in read(rel))
        if n:
            uses.append('%s x%d' % (rel, n))
    return hits, uses


def list_tokens(needle='', verbose=False):
    """Every token with its light and dark value, on one line each.

    tokens.css is 32KB — about 9,000 tokens — and reading it whole to answer
    "which green do I use for text" is the single most wasteful habit here. This
    is the same information at roughly a fifth the size, and a needle narrows it
    to almost nothing.
    """
    lines = read('assets/css/tokens.css')
    light, dark, comments, order = {}, {}, {}, []
    in_dark, pending = False, ''
    for line in lines:
        if 'dark-mode' in line or 'prefers-color-scheme: dark' in line:
            in_dark = True

        # A value may wrap: `--font` is a stack across two lines, so the first
        # carries no `;` at all. Hold it and try again with the next line.
        candidate = (pending + ' ' + line.strip()) if pending else line
        if re.match(r'\s*--[a-z0-9-]+\s*:', candidate) and ';' not in candidate:
            pending = candidate
            continue
        pending = ''

        # Do NOT anchor to end-of-line. Many declarations carry a comment that
        # opens here and closes on a later line; anchoring dropped 25 of the 103
        # tokens, and a short list looks exactly like a small design system.
        m = re.match(r'\s*(--[a-z0-9-]+)\s*:\s*([^;]+);(.*)$', candidate)
        if not m:
            continue
        name, value = m.group(1), ' '.join(m.group(2).split())
        if len(value) > 46:                  # the font stack, mostly
            value = value[:43] + '...'
        comment = m.group(3).strip().lstrip('/*').rstrip('*/').strip()
        (dark if in_dark else light)[name] = value
        if comment and name not in comments:
            comments[name] = comment
        if name not in order:
            order.append(name)

    hits = [n for n in order if needle in n]
    if not hits:
        return None
    width = max(len(n) for n in hits)
    vwidth = max(len(light.get(n, '—')) for n in hits)   # rgba() values are long
    out = []
    for n in hits:
        row = '  %-*s  %-*s  ' % (width, n, vwidth, light.get(n, '—'))
        row += ('dark %s' % dark[n]) if n in dark else ''
        if verbose and comments.get(n):
            row = row.rstrip() + '   /* %s' % comments[n][:70]
        out.append(row.rstrip())
    return out, len(hits), len(dark)


# ── JS functions ──────────────────────────────────────────────────────────────

def find_function(name):
    hits = []
    patterns = [r'function\s+%s\s*\(', r'\b%s\s*:\s*function\s*\(',
                r'\b(?:const|let|var)\s+%s\s*=']
    for rel in JS:
        lines = read(rel)
        for i, line in enumerate(lines):
            if any(re.search(p % re.escape(name), line) for p in patterns):
                hits.append(Hit('function', rel, i, brace_extent(lines, i, limit=800)))
    return hits


# ── Output ────────────────────────────────────────────────────────────────────

def emit(hits, show, extra_uses=None):
    width = max((len(h.kind) for h in hits), default=0)
    for h in hits:
        loc = '%s:%d-%d' % (h.rel, h.start, h.end) if h.span > 1 else \
              '%s:%d' % (h.rel, h.start)
        print('  %-*s  %-58s %s' % (width, h.kind, loc,
                                    h.note or ('%d lines' % h.span)))
    if extra_uses:
        print('\n  used in: ' + ', '.join(extra_uses))

    reads = [h for h in hits if h.span > 1]
    if reads:
        print('\n  Read:')
        for h in reads:
            print('    %s  offset=%d limit=%d' % (h.rel, h.start, h.span))

    if show:
        for h in hits:
            print('\n─── %s:%d-%d ───' % (h.rel, h.start, h.end))
            lines = read(h.rel)
            for n in range(h.start, min(h.end, len(lines)) + 1):
                print('%5d\t%s' % (n, lines[n - 1]))


# ── Self-test ─────────────────────────────────────────────────────────────────
# A locator that finds nothing looks identical to a thing that is not there.
# That is not hypothetical: the generator pattern here matched `function foo(`
# when every generator is really `foo: function(`, so it returned zero hits and
# read as "this annotation has no CRD generator". These assert that each
# resolver still finds a known-present thing — by KIND, never by line number,
# so ordinary edits to the page do not turn this red.

SELF_TEST = [
    ('denylist-source-range', {'mapping', 'generator', 'reference row'}),
    ('proxy-body-size',       {'mapping', 'reference row'}),
    # Both of these carry a value inside the code span — `auth-type: "basic"` —
    # and were the two annotations out of 130 whose row the first regex missed.
    ('auth-type',             {'mapping', 'reference row'}),
    ('affinity',              {'mapping', 'reference row'}),
    ('#mappings',             {'section'}),
    ('.version-pill',         {'rule'}),
    ('--green-text',          {'value'}),
    ('filterTable',           {'function'}),
]


def self_test():
    failures = []
    for query, expected in SELF_TEST:
        if query.startswith('--'):
            hits = find_token(query)[0]
        elif query.startswith('#'):
            hits = find_anchor(query)
        elif query.startswith('.'):
            hits = find_class(query)
        else:
            hits = find_annotation(query) or find_function(query)
        kinds = {h.kind for h in hits}
        missing = expected - kinds
        if missing:
            failures.append('  %-24s found %-34s missing %s'
                            % (query, sorted(kinds) or '[]', sorted(missing)))

    if find_annotation('definitely-not-an-annotation-xyz'):
        failures.append('  a nonsense query matched something')

    # The token listing is one regex away from silently dropping declarations,
    # and a short list looks exactly like a small design system. Calibrate
    # against a deliberately loose count of the same file rather than a magic
    # number, so adding tokens never turns this red on its own.
    expected = len(set(re.findall(r'^\s*(--[a-z0-9-]+)\s*:',
                                  '\n'.join(read('assets/css/tokens.css')), re.M)))
    listed = list_tokens('')
    if not listed or listed[1] != expected:
        failures.append('  --list parsed %s, but tokens.css declares %d unique'
                        % (('%d' % listed[1]) if listed else 'nothing', expected))

    print('where.py self-test: %d queries' % (len(SELF_TEST) + 2))
    for line in failures:
        print(line)
    if failures:
        print('FAILED — a resolver has stopped matching. Fix the pattern, not the test.')
        return 1
    print('OK')
    return 0


def main():
    args = [a for a in sys.argv[1:]]
    if '--self-test' in args:
        return self_test()
    show = False
    for flag in ('-s', '--show'):
        if flag in args:
            args.remove(flag)
            show = True
    if not args:
        print(__doc__.strip())
        return 2

    # `--list` before the token branch, or it reads as a token named --list.
    if args[0] in ('--list', '-l'):
        needle = args[1].lstrip('-') if len(args) > 1 else ''
        result = list_tokens(needle, verbose=show)
        if not result:
            print('no token matches %r' % needle)
            return 1
        rows, n, n_dark = result
        total = list_tokens('')[1]
        print('\ntokens matching %r  (%d of %d, %d with dark overrides)\n'
              % (needle or 'anything', n, total, n_dark))
        print('\n'.join(rows))
        print('\n  -s for the measured-ratio comments; '
              'assets/css/tokens.css is the full reference.')
        return 0

    query = args[0]
    uses = None

    if query.startswith('--'):
        hits, uses = find_token(query)
        kind = 'token'
    elif query.startswith('#'):
        hits, kind = find_anchor(query), 'anchor'
    elif query.startswith('.'):
        hits, kind = find_class(query), 'class'
    else:
        # Bare word: try each resolver, cheapest interpretation first. An
        # annotation and a heading anchor often share a name, and seeing both
        # is the useful answer rather than an ambiguity to resolve.
        hits = find_annotation(query)
        kind = 'annotation'
        if not hits:
            hits, kind = find_function(query), 'function'
        if not hits:
            hits, kind = find_anchor(query), 'anchor'
        if not hits:
            hits, kind = find_class(query), 'class'

    print('\n%s  (%s)\n' % (query, kind))
    if not hits:
        print('  NOT FOUND. Nothing in this repo matches that.\n'
              '  Annotations are the bare name ("rewrite-target", not the full\n'
              '  nginx.ingress.kubernetes.io/ prefix — though the prefix is accepted).\n'
              '  Anchors take a leading # , CSS classes a leading . , tokens a leading --')
        return 1
    emit(hits, show, uses)
    return 0


if __name__ == '__main__':
    sys.exit(main())
