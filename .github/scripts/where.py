#!/usr/bin/env python3
"""Locate things in this repo without reading the big files whole.

The migration page and its source module are each far too large to read whole
(`--stats` prints their current size). An agent that greps, guesses a range,
reads 400 lines, misses, and reads 400 more spends tens of thousands of tokens
to edit one 30-line table row. This prints the exact range instead.

    where.py rewrite-target      # an annotation: mapping, generator, reference rows
    where.py use-gzip            # any reference row, by a code name in either cell
    where.py '#mappings'         # any element id; a heading with no id by its text
    where.py .version-pill       # a CSS class, every rule
    where.py --lh-body           # a token: value, dark override, exact uses
    where.py --list green        # matching tokens, light and dark, one line each
    where.py filterTable         # a JS function, or a const/let/var binding
    where.py rewrite-target -s   # ...and print the lines
    where.py --outline [page]    # pane/section/h2/h3 tree with line ranges
    where.py --diff proxy-body-size   # run a row's Ingress through the analyzer, diff the panel
    where.py --tests switchApproach   # which tests and checks mention a name
    where.py --stats             # sizes and counts, computed now rather than quoted
    where.py --self-test         # every resolver, and every number/path/SHA the docs cite

It **exits 1 when it finds nothing**, and says so. A locator that silently
returns empty is the same failure mode as a check that silently passes: you
conclude the thing is absent when in fact your query was wrong.

Lives under .github/ because GitHub Pages publishes this branch.
"""
import difflib
import glob
import html
import json
import os
import re
import shutil
import subprocess
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PAGES = ['index.html', 'ingress-nginx-migration.html']
CSS = ['assets/css/tokens.css', 'assets/css/shared.css',
       'assets/css/index.css', 'assets/css/migration.css']
JS = ['assets/js/shared.js', 'assets/js/index.js', 'assets/js/migration-core.js',
      'assets/js/migration-ingress-nginx.js']

# Source modules define ANNOTATION_MAPPINGS; the core deliberately does not.
SOURCES = [p for p in JS if p.startswith('assets/js/migration-')
           and not p.endswith('migration-core.js')]


_CACHE = {}


def read(rel):
    """Lines of a repo file, or [] if it is not present on this branch."""
    if rel not in _CACHE:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            return []
        with open(path, encoding='utf-8') as fh:
            _CACHE[rel] = fh.read().split('\n')
    return _CACHE[rel]


def text_of(rel):
    return '\n'.join(read(rel))


def blank_comments(text, opener='/*', closer='*/'):
    """Replace comments with spaces, keeping every newline, so offsets and line
    numbers computed on the result still point into the original file."""
    pattern = re.escape(opener) + r'.*?' + re.escape(closer)
    return re.sub(pattern, lambda m: re.sub(r'[^\n]', ' ', m.group(0)), text, flags=re.S)


def line_at(text, offset):
    return text.count('\n', 0, offset)          # 0-indexed, as Hit expects


def strip_tags(fragment):
    return html.unescape(re.sub(r'<[^>]+>', '', fragment)).strip()


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


def brace_extent(lines, start, strip=True, limit=400, opener='{', closer='}'):
    """Index of the line closing the block that opens on `start`.

    `opener`/`closer` default to braces; a `const X = [` binding passes square
    brackets, because counting braces there closes on the first element and
    reported a 147-line array as 4 lines long.
    """
    depth, seen = 0, False
    for i in range(start, min(len(lines), start + limit)):
        text = strip_js(lines[i]) if strip else lines[i]
        for ch in text:
            if ch == opener:
                depth += 1
                seen = True
            elif ch == closer:
                depth -= 1
                if seen and depth <= 0:
                    return i
        # A one-line binding — `const X = 'v1.15.1';` — opens nothing at all.
        if not seen and i == start and text.rstrip().endswith(';'):
            return i
    return min(start + 40, len(lines) - 1)


class Hit:
    def __init__(self, kind, rel, start, end, note=''):
        self.kind, self.rel, self.note = kind, rel, note
        self.start, self.end = start + 1, end + 1     # 1-indexed, as Read reports

    @property
    def span(self):
        return self.end - self.start + 1


# ── Page structure ────────────────────────────────────────────────────────────
# One parse per page, shared by every resolver: each element's tag, attributes,
# first and last line. Scanning lines for `<section id=` instead bounded the
# last section at end-of-file, saw ids only on four tags, and could not see an
# index.html <h2> at all — none of them has an id.

class Node:
    __slots__ = ('tag', 'attrs', 'start', 'end', 'parent', 'children', 'chunks')

    def __init__(self, tag, attrs, start, parent):
        self.tag, self.attrs, self.start, self.parent = tag, attrs, start, parent
        self.end, self.children, self.chunks = start, [], []

    @property
    def id(self):
        return self.attrs.get('id') or ''

    @property
    def classes(self):
        return (self.attrs.get('class') or '').split()

    @property
    def text(self):
        return ' '.join(''.join(self.chunks).split())


VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'source', 'track', 'wbr'}


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node('#root', {}, 0, None)
        self.stack, self.nodes = [self.root], []

    def _open(self, tag, attrs, void):
        node = Node(tag, {k: (v or '') for k, v in attrs}, self.getpos()[0] - 1,
                    self.stack[-1])
        self.stack[-1].children.append(node)
        self.nodes.append(node)
        if not void:
            self.stack.append(node)

    def handle_starttag(self, tag, attrs):
        self._open(tag, attrs, tag in VOID)

    def handle_startendtag(self, tag, attrs):
        self._open(tag, attrs, True)

    def handle_endtag(self, tag):
        # Close back to the matching open tag; a stray close tag is ignored.
        for k in range(len(self.stack) - 1, 0, -1):
            if self.stack[k].tag == tag:
                line = self.getpos()[0] - 1
                for n in self.stack[k:]:
                    n.end = line
                del self.stack[k:]
                return

    def handle_data(self, data):
        if self.stack[-1].tag not in ('script', 'style'):
            for n in self.stack[1:]:
                n.chunks.append(data)


_PAGES = {}


def page(rel):
    """Every element of a page, in document order."""
    if rel not in _PAGES:
        parser = PageParser()
        parser.feed(text_of(rel))
        parser.close()
        _PAGES[rel] = parser.nodes
    return _PAGES[rel]


def ancestors(node):
    node = node.parent
    while node is not None and node.tag != '#root':
        yield node
        node = node.parent


def heading_end(node, nodes):
    """Last line a heading governs: up to the next heading of the same or
    higher rank, but never past the element that contains it."""
    rank = int(node.tag[1])
    limit = node.parent.end
    for other in nodes:
        if other.start <= node.start:
            continue
        if other.start > limit:
            break
        if re.fullmatch(r'h[1-6]', other.tag) and int(other.tag[1]) <= rank:
            return other.start - 1
    return limit


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def is_pane(node):
    """A hash-routed SPA view: `.product-page` on the landing page, `.tool-page`
    on the migration tool. Not every `page-*` id is one (`#page-announce` is
    the live region)."""
    return node.tag == 'div' and bool({'product-page', 'tool-page'} & set(node.classes))


def pane_of(node):
    """The SPA pane a node sits in. Both pages are hash-routed, so it decides
    which deep link renders the thing (see the verify-visually skill)."""
    for a in ancestors(node):
        if is_pane(a):
            return a.id
    return ''


# ── Sections and heading anchors ──────────────────────────────────────────────

def find_anchor(name):
    """Any element id on either page; failing that, a heading by its text.

    An index.html <h2> has no id, so `where.py 'Key details'` or the slug
    `#key-details` falls back to the heading's text and says that it did.
    """
    want = name.lstrip('#')
    hits = []
    for rel in PAGES:
        nodes = page(rel)
        for n in nodes:
            if n.id == want:
                end = heading_end(n, nodes) if re.fullmatch(r'h[1-6]', n.tag) else n.end
                pane = pane_of(n)
                hits.append(Hit(n.tag, rel, n.start, end, ('in #' + pane) if pane else ''))
    if hits:
        return hits
    for rel in PAGES:
        nodes = page(rel)
        for n in nodes:
            if n.tag in ('h2', 'h3') and want.lower() in (n.text.lower(), slug(n.text)):
                pane = pane_of(n)
                hits.append(Hit(n.tag + ', no id', rel, n.start, heading_end(n, nodes),
                                '"%s"%s' % (n.text[:40], ('  in #' + pane) if pane else '')))
    return hits


# ── Reference rows and annotations ────────────────────────────────────────────
# The one rule that cannot wait (AGENTS.md) is that the mapping, the reference
# row and the example YAML in its panel must agree. So resolve all three at
# once — the whole point is that you edit them together.

def code_names(cell):
    """The names a collapsed cell shows: each <code> with any prefix and any
    `: value` removed, so `auth-type: "basic"` is `auth-type`."""
    out = []
    for c in re.findall(r'<code>(.*?)</code>', cell, re.S):
        name = strip_tags(c).split(':')[0].strip()
        out.append(name.split('/')[-1])
    return out


_ROWS = {}


def reference_rows(rel='ingress-nginx-migration.html'):
    """Every `tr.expandable` with the `tr.example-row` after it."""
    if rel in _ROWS:
        return _ROWS[rel]
    nodes, lines = page(rel), read(rel)
    rows, heading, section = [], None, None
    for n in nodes:
        if n.tag == 'section' and n.id:
            section, heading = n, None
        elif n.tag == 'h3' and n.id:
            heading = n
        if n.tag != 'tr' or 'expandable' not in n.classes:
            continue
        sib = n.parent.children
        k = sib.index(n)
        example = sib[k + 1] if k + 1 < len(sib) and 'example-row' in sib[k + 1].classes else None
        tds = re.findall(r'<td[^>]*>(.*?)</td>', '\n'.join(lines[n.start:n.end + 1]), re.S)
        rows.append({
            'start': n.start, 'end': example.end if example else n.end,
            'example': example,
            'left': code_names(tds[0]) if tds else [],
            'right': code_names(tds[1]) if len(tds) > 1 else [],
            'left_text': strip_tags(tds[0]) if tds else '',
            'section': section.id if section and section.start <= n.start <= section.end else '',
            'heading': heading.id if heading and section and heading.start > section.start else '',
        })
    _ROWS[rel] = rows
    return rows


def find_rows(name, rel='ingress-nginx-migration.html'):
    """Reference rows whose collapsed cells name `name` in a <code> span.

    Whole-name equality after stripping prefix and value, so `auth-secret`
    never matches `auth-secret-type`, and a ConfigMap key or a NIC-only
    construct on a "No direct equivalent" row is found the same way as an
    annotation.
    """
    bare = name.split('/')[-1].strip()
    hits = []

    def names(cell):
        # `apiKey.suppliedIn` is also findable as `apiKey`, and
        # `upstreams[].buffering` as `upstreams[]` — the field's parent.
        return set(cell) | {c.split('.')[0] for c in cell}
    for row in reference_rows(rel):
        if bare in names(row['left']):
            side = ''
        elif bare in names(row['right']):
            side = '  NIC side' + ('' if row['left'] else ' of "%s"' % row['left_text'][:22])
        else:
            continue
        hits.append(Hit('reference row', rel, row['start'], row['end'],
                        '#' + (row['heading'] or row['section']) + side))
    return hits


def find_annotation(name):
    bare = name.split('/')[-1].strip()
    hits, generators = [], set()

    for rel in SOURCES:
        lines = read(rel)
        for i, line in enumerate(lines):
            m = re.search(r'community:\s*\[([^\]]*)\]', line)
            if not m or bare not in re.findall(r'"([^"]+)"', m.group(1)):
                continue
            end = brace_extent(lines, i)
            block = '\n'.join(lines[i:end + 1])
            cat = re.search(r'category:\s*"([^"]+)"', block)
            hits.append(Hit('mapping', rel, i, end, cat.group(1) if cat else ''))
            generators.update(re.findall(r'templateFn:\s*"([^"]+)"', block))

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

    return hits + find_rows(bare)


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


def declarations(rel):
    """Every custom-property declaration in a stylesheet, as
    (name, value, line, scope, trailing comment).

    Parsed from the file with comments blanked rather than line by line,
    because tokens.css packs two declarations onto one line
    (`--fs-body: …;  --lh-body: …;`, `--badge-vs-fg: …;  --badge-vs-bg: …;`)
    and a line-anchored match saw only the first — every `--lh-*`, every
    `--badge-*-bg` and every `--space-*hx` went missing, 19 tokens in all.
    """
    raw = text_of(rel)
    clean = blank_comments(raw)
    out = []
    # Selector blocks as (open, close, selector): `:root`, the dark theme's
    # `:is(html, body).dark-mode`, and so on. A declaration's scope is the
    # innermost block containing it.
    blocks, open_ = [], []
    for m in re.finditer(r'[{}]', clean):
        off = m.start()
        if m.group() == '{':
            sel = clean[max(clean.rfind(c, 0, off) for c in ';{}') + 1:off]
            open_.append((off, ' '.join(sel.split())))
        elif open_:
            start, sel = open_.pop()
            blocks.append((start, off, sel))
    for m in re.finditer(r'(?<![\w-])(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]*);', clean):
        off = m.start()
        inner = [b for b in blocks if b[0] < off < b[1]]
        scope = min(inner, key=lambda b: b[1] - b[0])[2] if inner else ''
        line = line_at(clean, off)
        tail = raw[m.end():raw.find('\n', m.end()) if '\n' in raw[m.end():] else len(raw)]
        comment = re.sub(r'^\s*/\*\s*|\s*\*/.*$', '', tail) if tail.strip().startswith('/*') else ''
        out.append((m.group(1), ' '.join(m.group(2).split()), line, scope, comment.strip()))
    return out


def is_dark(scope):
    return 'dark' in scope


def token_uses(var):
    """Exact uses of `var(--x)`, never prefix matches: `var(--green` also
    counted every `var(--green-text)`, which turned 2 uses into 15."""
    pattern = re.compile(r'var\(\s*%s\s*[,)]' % re.escape(var))
    uses = []
    for rel in CSS + PAGES + JS:
        n = len(pattern.findall(text_of(rel)))
        if n:
            uses.append('%s x%d' % (rel, n))
    return uses


def find_token(name):
    var = name if name.startswith('--') else '--' + name
    hits = []
    for rel in CSS:
        for tok, value, line, scope, _ in declarations(rel):
            if tok == var:
                hits.append(Hit('value', rel, line, line, '%s   [%s]' % (value, scope[:48])))
    return hits, token_uses(var)


def token_table():
    """{name: (light, dark, comment)} for tokens.css, in declaration order."""
    table = {}
    for tok, value, _, scope, comment in declarations('assets/css/tokens.css'):
        light, dark, note = table.get(tok, (None, None, ''))
        if is_dark(scope):
            dark = value
        else:
            light = value
        table[tok] = (light, dark, note or comment)
    return table


def list_tokens(needle='', verbose=False):
    """Every token with its light and dark value, on one line each.

    tokens.css is 34KB, and reading it whole to answer "which green do I use
    for text" is the single most wasteful habit here. This is the same
    information at roughly a fifth the size, and a needle narrows it to almost
    nothing.
    """
    table = token_table()
    hits = [n for n in table if needle in n]
    if not hits:
        return None

    def short(v):
        v = v or '—'
        return v if len(v) <= 46 else v[:43] + '...'      # the font stack, mostly
    width = max(len(n) for n in hits)
    vwidth = max(len(short(table[n][0])) for n in hits)   # rgba() values are long
    out = []
    for n in hits:
        light, dark, comment = table[n]
        row = '  %-*s  %-*s  ' % (width, n, vwidth, short(light))
        row += ('dark %s' % short(dark)) if dark else ''
        if verbose and comment:
            row = row.rstrip() + '   /* %s' % comment[:70]
        out.append(row.rstrip())
    n_dark = sum(1 for n in table if table[n][1])
    return out, len(hits), n_dark


# ── JS functions and bindings ─────────────────────────────────────────────────

def find_function(name):
    """A function, an object-literal method, or a const/let/var binding.

    A binding's extent follows whatever it opens — `[` for ANNOTATION_MAPPINGS,
    `{` for TRANSLATORS — or ends on its own line for a scalar.
    """
    hits = []
    esc = re.escape(name)
    for rel in JS:
        lines = read(rel)
        for i, line in enumerate(lines):
            if re.search(r'function\s+%s\s*\(|\b%s\s*:\s*function\s*\(' % (esc, esc), line):
                hits.append(Hit('function', rel, i, brace_extent(lines, i, limit=800)))
                continue
            m = re.search(r'\b(?:const|let|var)\s+%s\s*=\s*(.)?' % esc, line)
            if not m:
                continue
            opener = m.group(1) or ''
            if opener == '[':
                end = brace_extent(lines, i, limit=3000, opener='[', closer=']')
            elif opener == '{' or 'function' in line[m.end() - 1:]:
                end = brace_extent(lines, i, limit=3000)
            else:
                end = brace_extent(lines, i, limit=40)
            hits.append(Hit('binding', rel, i, end))
    return hits



# ── Stats ─────────────────────────────────────────────────────────────────────
# Every number the docs used to quote — page lines, rows, elements, weight —
# went stale within weeks, while the page and the analyzer kept changing under
# them. So the docs no longer quote them; this computes them on demand.

MIGRATION = 'ingress-nginx-migration.html'
SOURCE = 'assets/js/migration-ingress-nginx.js'
FONT = 'assets/fonts/InterVariable-subset.woff2'


def size(rel):
    path = os.path.join(ROOT, rel)
    return os.path.getsize(path) if os.path.exists(path) else 0


def line_count(rel):
    """As `wc -l` and an editor's last line number report it."""
    return text_of(rel).count('\n')


def stats():
    """{name: value}, every one computed from the files as they stand."""
    mig = text_of(MIGRATION)
    src = text_of(SOURCE)
    rows = reference_rows()
    mapped = set()
    body = src[src.find('ANNOTATION_MAPPINGS'):src.find('ANNOTATION_LOOKUP')]
    for m in re.finditer(r'community:\s*\[(.*?)\]', body, re.S):
        mapped.update(re.findall(r'"([^"]+)"', m.group(1)))
    mig_css = ['assets/css/tokens.css', 'assets/css/shared.css', 'assets/css/migration.css']
    mig_js = ['assets/js/shared.js', SOURCE, 'assets/js/migration-core.js']
    words = 0
    try:
        log = subprocess.run(['git', 'log', '--format=%B'], cwd=ROOT,
                             capture_output=True, text=True, timeout=20).stdout
        words = len(log.split())
    except (OSError, subprocess.SubprocessError):
        pass
    by_section = {}
    for r in rows:
        by_section[r['section']] = by_section.get(r['section'], 0) + 1
    return {
        'migration page lines': line_count(MIGRATION),
        'migration page tokens (approx, bytes/3.7)': int(len(mig.encode()) / 3.7),
        'source module lines': line_count(SOURCE),
        'source module tokens (approx)': int(len(src.encode()) / 3.7),
        'index page lines': line_count('index.html'),
        'migration sections (<section id>)': len(re.findall(r'<section id=', mig)),
        'migration category headings (<h3 id>)': len(re.findall(r'<h3 id=', mig)),
        'reference rows': len(rows),
        'reference rows by section': ', '.join('%s %d' % kv for kv in by_section.items()),
        'mapping objects': len(re.findall(r'\{\s*community:', body)),
        'mapped annotations': len(mapped),
        'tokens in tokens.css': len(token_table()),
        'migration page elements (static HTML)': len(page(MIGRATION)),
        'migration page weight KiB (html+css+js+font)': round(
            (size(MIGRATION) + sum(map(size, mig_css)) + sum(map(size, mig_js)) + size(FONT)) / 1024),
        'commit-body words in history': words,
    }


def print_stats():
    data = stats()
    width = max(len(k) for k in data)
    print()
    for k, v in data.items():
        print('  %-*s  %s' % (width, k, v))
    print('\n  Computed now. Quote a number from here, never from memory or old prose.')
    return 0


# ── Output ────────────────────────────────────────────────────────────────────

# ── Outline ───────────────────────────────────────────────────────────────────

def outline(rel):
    """Pane / section / h2 / h3 tree with line ranges, for either page.

    A heading with no id (every index.html <h2>) is shown by its text, so the
    tree is complete rather than only the parts that happen to be linkable.
    """
    nodes = page(rel)
    out = []
    for n in nodes:
        pane = is_pane(n)
        if not (pane or (n.tag == 'section' and n.id) or n.tag in ('h2', 'h3')):
            continue
        if n.tag == 'section' and 'sidebar-section' in n.classes:
            continue
        if any(a.tag in ('nav', 'aside', 'header', 'footer') for a in ancestors(n)):
            continue
        depth = sum(1 for a in ancestors(n) if is_pane(a) or (a.tag == 'section' and a.id))
        if n.tag == 'h3':
            depth += 1
        end = heading_end(n, nodes) if n.tag in ('h2', 'h3') else n.end
        label = ('#' + n.id) if n.id else ''
        if n.tag in ('h2', 'h3'):
            label = ('%s  "%s"' % (label, n.text[:48])).strip()
        out.append('  %s%-4s %-46s %5d-%-5d (%d lines)' % (
            '  ' * depth, n.tag if not pane else 'pane', label[:46],
            n.start + 1, end + 1, end - n.start + 1))
    return out


# ── Tests ─────────────────────────────────────────────────────────────────────

TEST_FILES = sorted(set(
    [os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, '.github/test/*.test.js'))] +
    [os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, '.github/scripts/check-*.py'))] +
    ['.github/scripts/test-analyzer.js']))


def find_tests(name):
    """Which tests and checks mention `name`, and in which test or function.

    Answers "what will go red if I change this?" before the change rather than
    after a full run.
    """
    hits = []
    pattern = re.compile(r'(?<![\w-])%s(?![\w-])' % re.escape(name))
    for rel in TEST_FILES:
        lines = read(rel)
        for i, line in enumerate(lines):
            if not pattern.search(line):
                continue
            # The enclosing test(...) or def/function, searching upwards.
            owner = ''
            for j in range(i, -1, -1):
                m = re.search(r"^\s*(?:test|it)\(\s*[`'\"](.+?)[`'\"]", lines[j]) or \
                    re.search(r'^\s*def (\w+)', lines[j]) or \
                    re.search(r'^\s*function (\w+)', lines[j])
                if m:
                    owner = m.group(1).replace('${p.name}: ', '')[:60]
                    break
            hits.append(Hit('test', rel, i, i, owner))
    return hits


# ── Diff: a reference row's examples against the analyzer ─────────────────────
# The accuracy step no check covers: test-analyzer.js proves each mapping has a
# documented row, and nothing proves the YAML in that row's panel is what the
# generator emits. This runs the panel's own Ingress through the analyzer under
# the strategy each tab demonstrates, and diffs the result against that tab.

ANALYZE_JS = r"""
const { loadAnalyzer, analyze } = require(process.argv[1]);
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const { source, warnings } = loadAnalyzer(input.module);
const out = input.cases.map((c) => {
    const before = warnings.length;
    let text = '', error = null;
    try { text = analyze(source, c.yaml, c.strategy).text; }
    catch (e) { error = String(e && e.message || e); }
    return { text, error, warnings: warnings.slice(before) };
});
process.stdout.write(JSON.stringify(out));
"""

# The NIC names each mapping declares: an annotation key, a ConfigMap key and
# a VirtualServer field per community annotation, read from the module itself.
MAPPING_KEYS_JS = r"""
const { loadAnalyzer } = require(process.argv[1]);
const { source } = loadAnalyzer(JSON.parse(require('fs').readFileSync(0, 'utf8')).module);
const out = [];
for (const m of source.analyzer.mappings) {
    const nm = m.nicMapping || {};
    for (const [community, s] of Object.entries(Object.assign({}, nm.annotations, nm.configMap))) {
        // A VirtualServer field is written as its path on the page: upstreams[].type.
        out.push({ community, keys: [s.key, s.vsField && 'upstreams[].' + s.vsField].filter(Boolean) });
    }
}
process.stdout.write(JSON.stringify(out));
"""

# Which analyzer strategy a tab demonstrates. CRD-first replaces the Ingress
# with a VirtualServer; annotation-first keeps the Ingress, so a Policy that
# attaches through nginx.org/policies (`ingress-policy`) is annotation-first.
TAB_STRATEGY = {'crd': 'crd', 'annotation': 'annotation', 'policy': 'annotation',
                'ingress-policy': 'annotation', 'vs-policy': 'crd', 'crd-headers': 'crd'}


def panels(row, rel='ingress-nginx-migration.html'):
    """[(tab, old_yaml, new_yaml)] for a reference row's expanded panel."""
    if not row['example']:
        return []
    block = '\n'.join(read(rel)[row['example'].start:row['example'].end + 1])
    tabs = re.split(r'<div class="approach-content[^"]*" data-approach="([\w-]+)">', block)
    chunks = [('', tabs[0])] if len(tabs) == 1 else list(zip(tabs[1::2], tabs[2::2]))
    out = []
    for tab, chunk in chunks:
        old = re.search(r'comparison-block old">.*?<pre><code>(.*?)</code></pre>', chunk, re.S)
        new = re.search(r'comparison-block new">.*?<pre><code>(.*?)</code></pre>', chunk, re.S)
        if old and new:
            out.append((tab, html.unescape(re.sub(r'<[^>]+>', '', old.group(1))),
                        html.unescape(re.sub(r'<[^>]+>', '', new.group(1)))))
    return out


SCAFFOLD = re.compile(r'^(\s*(?:-\s+)?(?:host|service|name|port|path|pass|upstream)):\s*(.*)$')

# Reference rows show the annotations of an Ingress and leave its spec out. The
# analyzer builds resources from the spec (one VirtualServer per host), so a
# spec-less row would yield none: give it the one rule the rows imply.
ROW_SPEC = '''spec:
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
'''


# A VirtualServer with nothing but host, one upstream and one passing route,
# as normalise() renders it.
SCAFFOLD_VS = {'apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: <name>',
               'spec:', '  host: <host>', '  upstreams:', '    - name: <name>', '      service: <service>',
               '      port: <port>', '  routes:', '    - path: <path>', '      action:', '        pass: <pass>',
               '  tls:', '    secret: <secret>', '    redirect:', '      enable: true', '      code: 308'}


def with_spec(ingress_yaml):
    if re.search(r'^spec:', ingress_yaml, re.M):
        return ingress_yaml
    return ingress_yaml.rstrip('\n') + '\n' + ROW_SPEC


def normalise(text, ingress_name='my-app'):
    """The comparable content of a manifest: no comments, no blank lines, no
    step headers, and scaffold values (host, service, names) made generic so a
    TODO placeholder and the panel's `app.example.com` compare equal. A bare
    `annotations:` swap block becomes the Ingress the panel shows."""
    lines = []
    for raw in text.split('\n'):
        # A TODO placeholder is the generator's "you fill this in", which the
        # page fills with an example value: compare them as equal.
        raw = re.sub(r'(:\s*)"?#\s*TODO[^"\n]*"?\s*$', r'\1<todo>', raw)
        line = re.sub(r'\s+#.*$', '', raw).rstrip() if not raw.lstrip().startswith('#') else ''
        if not line.strip() or line.strip() == '---':
            if line.strip() == '---':
                lines.append('---')
            continue
        m = SCAFFOLD.match(line)
        if m:
            line = '%s: <%s>' % (m.group(1), m.group(1).strip(' -'))
        # `"/$2"` and `/$2` are the same scalar.
        line = re.sub(r'''^(\s*(?:-\s+)?[\w./-]+:\s+)(["'])(.*)\2$''', r'\1\3', line)
        lines.append(line)
    if lines and lines[0] == 'annotations:':
        lines = ['apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:',
                 '  name: <name>'] + ['  ' + l for l in lines]
    while lines and lines[-1] == '---':
        lines.pop()
    return sort_siblings(lines)


def sort_siblings(lines):
    """Order each mapping's keys, so key order — not meaningful in YAML — is not
    reported as drift. Each key carries its indented children along with it;
    sequence items and block-scalar bodies keep their order."""
    def indent(line):
        return len(line) - len(line.lstrip(' '))

    def block(start, depth):
        """Sort the run of lines at `depth` starting at `start`; return (lines, next)."""
        groups, i = [], start
        while i < len(lines) and lines[i] != '---' and indent(lines[i]) >= depth:
            if indent(lines[i]) > depth:          # stray deeper line: keep in place
                groups[-1][1].append(lines[i]) if groups else groups.append(('', [lines[i]]))
                i += 1
                continue
            head, j = lines[i], i + 1
            body = []
            if head.rstrip().endswith('|') or head.rstrip().endswith('|-'):
                while j < len(lines) and lines[j] != '---' and indent(lines[j]) > depth:
                    body.append(lines[j])
                    j += 1
            elif j < len(lines) and lines[j] != '---' and indent(lines[j]) > depth:
                body, j = block(j, indent(lines[j]))
            groups.append((head, [head] + body))
            i = j
        if all(not g[0].lstrip().startswith('- ') for g in groups):
            groups.sort(key=lambda g: g[0].strip())
        return [l for g in groups for l in g[1]], i

    out, i = [], 0
    while i < len(lines):
        if lines[i] == '---':
            out.append('---')
            i += 1
            continue
        part, i = block(i, indent(lines[i]))
        out += part
    return out


def run_analyzer(cases):
    """Run [(yaml, strategy)] through .github/test/lib/load.js in one node."""
    node = shutil.which('node')
    if not node:
        return None, 'node is not on PATH — --diff did not run'
    payload = json.dumps({'module': SOURCE,
                          'cases': [{'yaml': y, 'strategy': s} for y, s in cases]})
    loader = os.path.join(ROOT, '.github/test/lib/load.js')
    try:
        proc = subprocess.run([node, '-e', ANALYZE_JS, loader], input=payload,
                              capture_output=True, text=True, cwd=ROOT, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, 'node failed: %s' % exc
    if proc.returncode != 0:
        return None, 'node exited %d: %s' % (proc.returncode, proc.stderr.strip()[-400:])
    return json.loads(proc.stdout), ''


def diff_annotation(name):
    """[(row, tab, strategy, diff_lines, warnings)] and an error string."""
    bare = name.split('/')[-1]
    results, err = diff_rows([r for r in reference_rows() if bare in r['left']])
    if not results and not err:
        return [], 'no reference row shows an Ingress for %r to analyze' % bare
    return results, err


def diff_rows(rows):
    """Every tab of `rows` against the analyzer, in one node process."""
    plan, cases = [], []
    for row in rows:
        for tab, old, new in panels(row):
            if 'kind: Ingress' not in old:
                continue                          # a ConfigMap row: not analyzer input
            strategy = TAB_STRATEGY.get(tab, 'crd')
            plan.append((row, tab or '(single)', strategy, new))
            cases.append((with_spec(old), strategy))
    if not cases:
        return [], ''
    results, err = run_analyzer(cases)
    if results is None:
        return [], err
    out = []
    for (row, tab, strategy, new), res in zip(plan, results):
        if res['error']:
            out.append((row, tab, strategy, ['+ERROR: ' + res['error']], [], res['warnings']))
            continue
        delta, extra = compare_documents(normalise(new), normalise(res['text']), tab, strategy)
        out.append((row, tab, strategy, delta, extra, res['warnings']))
    return out, ''


def documents(lines):
    """Split normalised lines into {kind: lines} documents, in order."""
    docs, cur = [], []
    for line in lines + ['---']:
        if line == '---':
            if cur:
                kind = next((l.split(':', 1)[1].strip() for l in cur if l.startswith('kind:')), '?')
                docs.append((kind, cur))
            cur = []
        else:
            cur.append(line)
    return docs


def compare_documents(want, got, tab, strategy):
    """Diff the page's documents against the analyzer's, pairing them by kind
    in order. A document the page shows and the analyzer never emits — the
    Ingress or VirtualServer a Policy tab adds to show where it attaches — is
    reported separately as context, not as drift."""
    # Where the generator emits a placeholder, any example value the page
    # fills in is correct; adopt the generator's line so it compares equal.
    todo = {l.split(':', 1)[0] for l in got if l.endswith(': <todo>')}
    want = [(l.split(':', 1)[0] + ': <todo>') if ':' in l and l.split(':', 1)[0] in todo
            else l for l in want]
    page_docs, gen_docs = documents(want), documents(got)
    delta, extra, used = [], [], set()
    for kind, body in page_docs:
        match = next((k for k, (gk, _) in enumerate(gen_docs)
                      if gk == kind and k not in used), None)
        if match is None:
            extra.append(kind)
            continue
        used.add(match)
        # The page's Ingress shows only its annotations; the spec the analyzer
        # was given (ROW_SPEC) comes back on the migrated Ingress. Compare what
        # the page shows.
        if kind == 'Ingress' and 'spec:' not in body:
            gen_body = gen_docs[match][1]
            if 'spec:' in gen_body:
                gen_docs[match] = (kind, gen_body[:gen_body.index('spec:')])
        delta += list(difflib.unified_diff(body, gen_docs[match][1],
                                           'page %s (%s tab)' % (kind, tab),
                                           'analyzer %s (--strategy %s)' % (kind, strategy),
                                           lineterm='', n=1))[2:]
    for k, (kind, body) in enumerate(gen_docs):
        if k not in used:
            # The VirtualServer that replaces the row's Ingress, carrying
            # nothing but its scaffold, is not the row's subject: a row about a
            # ConfigMap key or an unsupported annotation need not show it.
            if kind == 'VirtualServer' and set(body) <= SCAFFOLD_VS:
                continue
            delta += ['+ analyzer emits a %s the %s tab does not show:' % (kind, tab)] + \
                     ['+' + l for l in body]
    return delta, extra


def print_diff(name):
    results, err = diff_annotation(name)
    if err:
        print('\n  %s' % err)
        return 1
    drift = 0
    print()
    for row, tab, strategy, delta, extra, warnings in results:
        state = 'matches' if not delta else 'DIFFERS'
        drift += bool(delta) or bool(warnings)
        print('  %-7s  %s:%d  #%s  tab %-15s strategy %s%s' % (
            state, MIGRATION, row['start'] + 1, row['heading'] or row['section'], tab, strategy,
            ('   (page also shows: %s)' % ', '.join(extra)) if extra else ''))
        for w in warnings:
            print('           WARNING from the analyzer: %s' % w[:160])
        for line in delta:
            print('           ' + line)
    print('\n  Compared per document after dropping comments and making scaffold values\n'
          '  generic (host, service, names, ports). "page also shows" lists documents\n'
          '  the analyzer does not emit — usually where a Policy attaches — and is not\n'
          '  drift. The generator is the source of truth: a DIFFERS means fix the\n'
          '  example, unless the generator is wrong.')
    return 1 if drift else 0


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
    # and were the two annotations whose row the first regex missed.
    ('auth-type',             {'mapping', 'reference row'}),
    ('affinity',              {'mapping', 'reference row'}),
    ('#mappings',             {'section'}),
    ('.version-pill',         {'rule'}),
    ('--green-text',          {'value'}),
    # Second declaration on its line — invisible to a line-anchored parser.
    ('--lh-body',             {'value'}),
    ('--badge-vs-bg',         {'value'}),
    ('filterTable',           {'function'}),
    ('ANNOTATION_MAPPINGS',   {'binding'}),
]


def query_kinds(query):
    if query.startswith('--'):
        return find_token(query)[0]
    if query.startswith('#'):
        return find_anchor(query)
    if query.startswith('.'):
        return find_class(query)
    return find_annotation(query) or find_function(query)


def ground_truth_tokens():
    """tokens.css's custom properties, counted a different way from the
    parser: from a tokenizer that knows nothing of lines, blocks or scopes."""
    names = re.findall(r'(?<![\w-])(--[a-zA-Z0-9-]+)\s*:',
                       blank_comments(text_of('assets/css/tokens.css')))
    return set(names)


def resolver_failures():
    failures = []
    for query, expected in SELF_TEST:
        kinds = {h.kind for h in query_kinds(query)}
        missing = expected - kinds
        if missing:
            failures.append('%-24s found %-30s missing %s'
                            % (query, sorted(kinds) or '[]', sorted(missing)))

    if find_annotation('definitely-not-an-annotation-xyz'):
        failures.append('a nonsense query matched something')

    # Every token, exactly — not a count calibrated by the same regex shape as
    # the parser, which is how 19 tokens went missing with this test green.
    truth, table = ground_truth_tokens(), token_table()
    if set(table) != truth:
        failures.append('--list parsed %d tokens, tokens.css declares %d; missing %s'
                        % (len(table), len(truth), sorted(truth - set(table))[:6]))
    for tok in truth:
        light, dark, _ = table.get(tok, (None, None, ''))
        if light is None:
            failures.append('%s has no light (:root) value — "—" in --list' % tok)
            break
        if not find_token(tok)[0]:
            failures.append('%s is listed but `where.py %s` finds nothing' % (tok, tok))
            break
    # And light and dark are not crossed: the dark theme is the only block
    # that redeclares, so the count of tokens carrying a dark value must equal
    # the number of distinct names declared inside it.
    css = blank_comments(text_of('assets/css/tokens.css'))
    dark_block = css[css.find('dark-mode'):]
    dark_truth = set(re.findall(r'(?<![\w-])(--[a-zA-Z0-9-]+)\s*:', dark_block))
    dark_seen = {t for t, v in table.items() if v[1]}
    if dark_seen != dark_truth:
        failures.append('%d tokens carry a dark value, the dark theme declares %d'
                        % (len(dark_seen), len(dark_truth)))

    # Exact uses, not prefix matches: `--green` must not count `--green-text`.
    plain = re.compile(r'var\(\s*--green\s*[,)]')
    want = sum(len(plain.findall(text_of(r))) for r in CSS + PAGES + JS)
    got = sum(int(u.rsplit('x', 1)[1]) for u in token_uses('--green'))
    if got != want:
        failures.append('--green: %d uses reported, %d exact var(--green) in the files'
                        % (got, want))

    # Every reference row resolves by every name in its collapsed cells, and
    # the row the resolver returns is that row.
    unfound = []
    for row in reference_rows():
        for name in (row['left'] or row['right'])[:1]:
            if not any(h.start == row['start'] + 1 for h in find_rows(name)):
                unfound.append('%s@%d' % (name, row['start'] + 1))
    if unfound:
        failures.append('%d reference row(s) unfindable by their own code name: %s'
                        % (len(unfound), ', '.join(unfound[:5])))

    # Every element id on both pages resolves to an extent inside its parent,
    # and every <section> ends where its own </section> is.
    for rel in PAGES:
        lines = read(rel)
        for n in page(rel):
            if n.tag == 'section' and n.id and '</section>' not in lines[n.end]:
                failures.append('%s #%s ends on line %d, which is not its </section>'
                                % (rel, n.id, n.end + 1))
            if n.id and not find_anchor('#' + n.id):
                failures.append('%s #%s does not resolve' % (rel, n.id))

    # Constants are sized by what they open, not by the first brace inside.
    for name, opener, closer in (('ANNOTATION_MAPPINGS', '[', ']'), ('TRANSLATORS', '{', '}')):
        hits = [h for h in find_function(name) if h.kind == 'binding']
        if not hits:
            failures.append('%s: no binding found' % name)
            continue
        h, lines = hits[0], read(hits[0].rel)
        if not lines[h.end - 1].strip().startswith(closer):
            failures.append('%s ends on line %d, which does not close its %s'
                            % (name, h.end, opener))
    return failures


# ── Documented facts ──────────────────────────────────────────────────────────
# The agent-facing docs cited ~20 facts that had stopped being true: a page
# size off by 600 lines, a commit that does not exist, a function on another
# branch, a file named in a directory list that was not there. Nothing read
# them, so nothing noticed. These do.

DOCS = ['AGENTS.md', 'CONTRIBUTING.md', 'README.md'] + sorted(
    os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, '.claude/skills/*/SKILL.md')))

# Path-shaped backticked spans that are deliberately not files in this tree.
NOT_PATHS = {
    'migration-<source>.js', 'docs/user-guide/nginx-configuration/annotations.md',
    'content/nic/configuration/ingress-resources/advanced-configuration-with-annotations.md',
    'pkg/apis/configuration/v1/types.go', 'internal/configs/annotations.go',
    'configmaps.go', 'pkg/apis/configuration/validation/', 'deploy/crds.yaml',
    'build/Dockerfile', 'apis/v1alpha1', 'apis/v1alpha2', 'conformance-profile.yaml',
    'tls-passthrough/', 'tlsroute/', 'installation/', 'install/',
    '/scripts/check-tokens.py', 'scripts/', '.nojekyll',
}

# Numbers the docs still state, each next to the value it must match. Exact for
# counts; sizes in KB/KiB within 5%, so a prose edit does not have to chase
# every commit, but a doubling cannot hide.
def doc_numbers():
    s = stats()
    return [
        # (file, regex whose group 1 is the number, actual, tolerance)
        ('.claude/skills/f5ds-design/SKILL.md', r'`tokens\.css` is (\d+)KB', size('assets/css/tokens.css') / 1000, 0.05),
        ('AGENTS.md', r'It is (\d+)KB, so prefer', size('assets/css/tokens.css') / 1000, 0.05),
        ('.claude/skills/f5ds-design/SKILL.md', r'`→` appears (\d+) times', text_of(MIGRATION).count('→'), 0),
        ('.claude/skills/f5ds-design/SKILL.md', r'deviates from F5DS deliberately in (\d+) places', deviation_rows(), 0),
        ('AGENTS.md', r'deviates from F5DS deliberately in (\d+) places', deviation_rows(), 0),
        ('.claude/skills/repo-checks/SKILL.md', r'It runs all (\w+) and prints', len_checks(), 0),
        ('AGENTS.md', r'^(\w+) checks, one command', len_checks(), 0),
        ('.claude/skills/repo-checks/SKILL.md', r'has\s+now happened \*\*(\w+)\*\* times', len_incidents(), 0),
        ('.claude/skills/migration-tool/SKILL.md', r'Only (\d+) of the mappings have a generator', generator_mappings(), 0),
        ('.claude/skills/migration-tool/SKILL.md', r'all (\d+) `snippetWrap` occurrences', text_of(SOURCE).count('snippetWrap'), 0),
    ]


WORDS = {w: i for i, w in enumerate(
    'zero one two three four five six seven eight nine ten eleven twelve'.split())}


def as_number(token):
    token = token.replace(',', '').lower()
    return WORDS[token] if token in WORDS else float(token)


def deviation_rows():
    skill = text_of('.claude/skills/f5ds-design/SKILL.md')
    table = skill[skill.find('## Documented deviations'):skill.find('## The top bar')]
    return len(re.findall(r'^\| \*\*', table, re.M))


def len_checks():
    src = text_of('.github/scripts/check-all.py')
    body = src[src.find('CHECKS = ['):src.find('\n]', src.find('CHECKS = ['))]
    return len(re.findall(r"^\s*\('", body, re.M))


def len_incidents():
    skill = text_of('.claude/skills/repo-checks/SKILL.md')
    block = skill[skill.find('## Why a runner'):skill.find('If you must capture')]
    return len(re.findall(r'^\d+\. ', block, re.M))


def generator_mappings():
    body = text_of(SOURCE)
    body = body[body.find('ANNOTATION_MAPPINGS'):body.find('ANNOTATION_LOOKUP')]
    return len(re.findall(r'templateFn:\s*"', body))


TOP_LEVEL = None
FILE_EXT = r'\.(md|py|js|sh|css|html|json|ya?ml|svg|png|woff2|txt)$'


def looks_like_repo_path(span):
    """A backticked span that claims a file in THIS repo.

    Either it starts at a top-level entry of the tree (`assets/…`, `.github/…`,
    `tools/…`), or it is a bare filename with a file extension. `owner/repo`
    slugs, API field paths, URL fragments and other repos' paths have neither
    shape, so they are not claims about this tree.
    """
    global TOP_LEVEL
    if TOP_LEVEL is None:
        TOP_LEVEL = set(os.listdir(ROOT)) - {'.git'}
    if not re.fullmatch(r'/?\.?[\w.-]+(/[\w.-]+)*/?', span):
        return False
    first = span.lstrip('/').split('/')[0]
    if '/' in span.strip('/'):
        return first in TOP_LEVEL
    # Dotted names that are not files: annotation and API prefixes, and a JS
    # property path on a capitalised global (`MigrationTool.yaml`).
    return (bool(re.search(FILE_EXT, span)) and not span.startswith(('nginx.', 'k8s.'))
            and not re.match(r'[A-Z][A-Za-z]*\.', span))


_FILES = None


def repo_path_exists(span):
    global _FILES
    rel = span.lstrip('/')
    if os.path.exists(os.path.join(ROOT, rel)):
        return True
    if '/' in rel.rstrip('/'):
        return False
    # A bare filename: fine if a file of that name exists anywhere in the tree,
    # dot-directories included (`check-all.py` lives under .github/scripts/).
    if _FILES is None:
        _FILES = set()
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules')]
            _FILES.update(filenames)
    return rel in _FILES


def git_ok(args):
    try:
        return subprocess.run(['git'] + args, cwd=ROOT, capture_output=True,
                              timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return None


_HISTORY = None
SKIPPED = set()      # assertions that could not be judged here, reported not failed


def full_history():
    """True when this is a git checkout with its whole history. A SHA cannot be
    judged in a tarball or a shallow CI clone, and saying "does not resolve"
    there would be the false failure that teaches people to ignore this."""
    global _HISTORY
    if _HISTORY is None:
        try:
            out = subprocess.run(['git', 'rev-parse', '--is-shallow-repository'], cwd=ROOT,
                                 capture_output=True, text=True, timeout=20)
            _HISTORY = out.returncode == 0 and out.stdout.strip() == 'false'
        except (OSError, subprocess.SubprocessError):
            _HISTORY = False
    return _HISTORY


def doc_failures():
    failures = []
    for rel in DOCS:
        text = text_of(rel)
        if not text:
            failures.append('%s: listed as a doc but missing' % rel)
            continue
        # Fenced blocks are commands and examples, not claims.
        prose = re.sub(r'```.*?```', '', text, flags=re.S)
        for span in sorted(set(re.findall(r'`([^`\n]+)`', prose))):
            span = span.strip()
            if span in NOT_PATHS or not looks_like_repo_path(span):
                continue
            if not repo_path_exists(span):
                failures.append('%s: `%s` does not exist' % (rel, span))
        # Every cited commit resolves. A SHA is 7-40 hex, backticked or not;
        # an all-letter run must be backticked, so English words pass.
        cited = set(re.findall(r'(?<![\w/#-])([0-9a-f]{7,40})(?![\w-])', prose))
        cited = {s for s in cited if re.search(r'\d', s) and re.search(r'[a-f]', s)}
        cited |= set(re.findall(r'`([0-9a-f]{7,40})`', prose))
        for sha in sorted(cited):
            if not full_history():
                SKIPPED.add('commit SHAs (not a full-history git checkout)')
                break
            if not git_ok(['cat-file', '-e', sha + '^{commit}']):
                failures.append('%s: commit %s does not resolve' % (rel, sha))
    for rel, pattern, actual, tolerance in doc_numbers():
        m = re.search(pattern, text_of(rel), re.M)
        if not m:
            continue                   # the claim was removed: nothing to hold
        stated = as_number(m.group(1))
        if tolerance == 0 and stated != actual or \
                tolerance and abs(stated - actual) > tolerance * actual:
            failures.append('%s says %s; the source says %s' % (
                rel, m.group(1), round(actual, 1) if isinstance(actual, float) else actual))
    return failures


# ── The commands: --outline, --tests, --diff, --stats ─────────────────────────

def command_failures():
    failures = []

    # --outline lists every <section id>, <h2> and <h3> in a pane — counted
    # independently, by regex on the raw page.
    for rel in PAGES:
        listed = '\n'.join(outline(rel))
        raw = text_of(rel)
        for sid in re.findall(r'<section id="([^"]+)"', raw):
            if '#' + sid not in listed:
                failures.append('--outline %s omits section #%s' % (rel, sid))
        main = raw[raw.find('<main'):raw.find('</main>')]
        want = len(re.findall(r'<h[23][\s>]', main))
        got = len(re.findall(r'^\s+h[23] ', listed, re.M))
        if want != got:
            failures.append('--outline %s lists %d h2/h3, <main> has %d' % (rel, got, want))
        if rel == 'index.html' and '"Key details"' not in listed:
            failures.append('--outline index.html cannot see an id-less <h2>')

    # --tests finds a name the wiring suite is known to use, in its own test.
    hits = find_tests('switchApproach')
    if not any(h.rel.endswith('wiring.test.js') and h.note for h in hits):
        failures.append('--tests switchApproach found no named test in wiring.test.js')
    if find_tests('definitely-not-a-name-xyz'):
        failures.append('--tests matched a nonsense name')

    # --stats agrees with independent counts of the same files.
    s = stats()
    mig = text_of(MIGRATION)
    checks = [
        ('reference rows', len(re.findall(r'<tr class="expandable"', mig))),
        ('migration sections (<section id>)', len(re.findall(r'<section id=', mig))),
        ('migration page lines', mig.count('\n')),
        ('tokens in tokens.css', len(ground_truth_tokens())),
    ]
    for key, truth in checks:
        if s[key] != truth:
            failures.append('--stats %s = %s, independent count %s' % (key, s[key], truth))

    # --diff: a row known to match its generator matches, and the same row with
    # its example altered does not. Planted in memory, never on disk.
    if not shutil.which('node'):
        SKIPPED.add('--diff (node is not on PATH)')
        return failures
    results, err = diff_annotation('proxy-body-size')
    if err or not results:
        failures.append('--diff proxy-body-size did not run: %s' % (err or 'no tabs'))
    elif any(r[3] for r in results):
        failures.append('--diff proxy-body-size reports drift on a row that matches')
    row = [r for r in reference_rows() if 'proxy-body-size' in r['left']][0]
    tab, old, new = [p for p in panels(row) if p[0] == 'crd'][0]
    planted = new.replace('client-max-body-size: "10m"', 'client-max-body-size: "11m"')
    if planted == new:
        failures.append('--diff self-test could not plant its fault: the example changed shape')
    else:
        got, err = run_analyzer([(with_spec(old), 'crd')])
        delta, _ = compare_documents(normalise(planted), normalise(got[0]['text']), 'crd', 'crd') \
            if got else ([], [])
        if not delta:
            failures.append('--diff did not report a planted "11m" against the generator\'s "10m"')
    return failures


# ── Every reference row against the analyzer ─────────────────────────────────
# AGENTS.md's "one rule that cannot wait": a row's example and its generator
# agree. --diff answers it for one annotation when someone thinks to ask; this
# asks it of every row on every run. A tab listed here shows, on purpose, an
# answer the analyzer never emits. Keyed by row anchor and tab, not by
# annotation, because #oidc-authentication lists the external-auth annotations
# whose own row must still match. An entry that stops differing fails too, so
# the list cannot outlive its reason.
ALTERNATIVE_TABS = {
    ('cors', 'annotation'): 'CORS as server snippets: the hand-written alternative to the Policy the analyzer emits',
    ('cors', 'crd-headers'): 'CORS as VirtualServer responseHeaders: the declarative alternative to the Policy',
    ('oidc-authentication', 'ingress-policy'): 'NGINX Plus oidcNative: needs an issuer and client credentials no annotation carries',
    ('oidc-authentication', 'vs-policy'): 'NGINX Plus oidc on a VirtualServer: same reason',
    ('headers', '(single)'): 'nginx.org/add-header, a NIC-only annotation, written by hand in place of a '
                             'configuration-snippet; the analyzer carries the snippet over unchanged',
    ('configuration-snippets', 'transportserver'): 'stream-snippet as a GlobalConfiguration listener and '
                             'TransportServer: the long-term form, read from the snippet by hand; the analyzer '
                             'moves the snippet to the stream-snippets key',
}


def mapping_keys():
    node = shutil.which('node')
    loader = os.path.join(ROOT, '.github/test/lib/load.js')
    proc = subprocess.run([node, '-e', MAPPING_KEYS_JS, loader], input=json.dumps({'module': SOURCE}),
                          capture_output=True, text=True, cwd=ROOT, timeout=60)
    if proc.returncode != 0:
        return None
    return json.loads(proc.stdout)


def reference_row_failures():
    if not shutil.which('node'):
        SKIPPED.add('reference rows (node is not on PATH)')
        return []
    failures = []
    # The collapsed NIC cell names what each mapping writes: a misspelled or
    # stale key there is the half of the rule the example diff cannot see.
    keys = mapping_keys()
    if keys is None:
        failures.append('the mapping keys could not be read from %s' % SOURCE)
    # Annotation rows only: the ConfigMap tables share bare names
    # (proxy-connect-timeout is both), and a ConfigMap row must not stand in
    # for the annotation row's NIC cell.
    annotation_rows = [r for r in reference_rows() if r['section'] in ('mappings', 'plus-mappings')]
    for k in keys or []:
        rows = [r for r in annotation_rows if k['community'] in r['left']]
        if not rows:
            failures.append('%s is mapped but no reference row lists it' % k['community'])
            continue
        shown = set(n for r in rows for n in r['right'])
        for key in k['keys']:
            bare = key.split('/')[-1]
            if bare not in shown:
                failures.append('%s maps to %s, which no row for it names in its NIC cell (%s:%d)'
                                % (k['community'], key, MIGRATION, rows[0]['start'] + 1))
    results, err = diff_rows(reference_rows())
    if err:
        return failures + ['the reference rows did not run through the analyzer: %s' % err]
    differing = set()
    for row, tab, strategy, delta, extra, warnings in results:
        key = (row['heading'] or row['section'], tab)
        where = '%s:%d #%s tab %s' % (MIGRATION, row['start'] + 1, key[0], tab)
        for w in warnings:
            failures.append('%s: the analyzer warned: %s' % (where, w[:160]))
        if not delta:
            continue
        differing.add(key)
        if key not in ALTERNATIVE_TABS:
            failures.append('%s differs from the analyzer (%s); first line: %s'
                            % (where, 'where.py --diff ' + row['left'][0] if row['left']
                               else 'its left cell names no annotation: see the row', delta[0].strip()))
    for key, why in sorted(ALTERNATIVE_TABS.items()):
        if key not in differing:
            failures.append('ALTERNATIVE_TABS lists #%s tab %s, which now matches the '
                            'analyzer: remove the entry (%s)' % (key[0], key[1], why))
    return failures


SELF_TEST_GROUPS = [
    ('resolvers', resolver_failures),
    ('documented facts', doc_failures),
    ('commands', command_failures),
    ('reference rows', reference_row_failures),
]


def self_test():
    failed = 0
    for label, fn in SELF_TEST_GROUPS:
        failures = fn()
        failed += len(failures)
        print('  %-5s %s%s' % ('FAIL' if failures else 'ok', label,
                               (' — %d problem(s)' % len(failures)) if failures else ''))
        for line in failures:
            print('          ' + line)
    for what in sorted(SKIPPED):
        print('  skip  %s' % what)
    print('where.py self-test: %d groups, %d queries' % (len(SELF_TEST_GROUPS), len(SELF_TEST)))
    if failed:
        print('FAILED — a resolver or a documented fact has drifted. '
              'Fix the pattern or the prose, not the test.')
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

    # Commands before the token branch, or `--list` reads as a token named --list.
    if args[0] == '--stats':
        return print_stats()
    if args[0] == '--outline':
        targets = [args[1]] if len(args) > 1 else PAGES
        for rel in targets:
            if rel not in PAGES:
                print('--outline takes one of: %s' % ', '.join(PAGES))
                return 2
            print('\n%s\n' % rel)
            print('\n'.join(outline(rel)))
        return 0
    if args[0] == '--diff':
        if len(args) < 2:
            print('usage: where.py --diff <annotation>')
            return 2
        return print_diff(args[1])
    if args[0] == '--tests':
        if len(args) < 2:
            print('usage: where.py --tests <name>')
            return 2
        hits = find_tests(args[1])
        print('\n%s  (tests and checks)\n' % args[1])
        if not hits:
            print('  NOT FOUND in %d test and check files. Nothing would go red on '
                  'this name alone.' % len(TEST_FILES))
            return 1
        emit(hits, show)
        return 0
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
        # Bare word: try each resolver, cheapest interpretation first, and
        # label the result by the resolver that matched — a miss used to be
        # labelled "(class)" because that happened to be the last one tried.
        # Reference rows are tried even when no mapping matches: a ConfigMap
        # key or a NIC-only construct has a row and no mapping.
        hits, kind = find_annotation(query), 'annotation'
        if hits and not any(h.kind == 'mapping' for h in hits):
            kind = 'reference row'
        for resolver, label in ((find_function, 'function'), (find_anchor, 'anchor'),
                                (find_class, 'class')):
            if hits:
                break
            hits, kind = resolver(query), label
        if kind == 'function' and hits and all(h.kind == 'binding' for h in hits):
            kind = 'binding'
        if not hits:
            kind = 'tried annotation, reference row, function, anchor, class'

    print('\n%s  (%s)\n' % (query, kind))
    if not hits:
        print('  NOT FOUND. Nothing in this repo matches that.\n'
              '  Annotations and reference rows are the bare name ("rewrite-target",\n'
              '  "use-gzip"; a prefix is accepted). Anchors take a leading # , CSS\n'
              '  classes a leading . , tokens a leading -- .  --outline lists headings.')
        return 1
    emit(hits, show, uses)
    return 0


if __name__ == '__main__':
    sys.exit(main())
