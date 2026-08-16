#!/usr/bin/env python3
"""Structural validation of the two hand-edited HTML pages.

ingress-nginx-migration.html is 4,952 lines of hand-authored markup with
hundreds of near-identical table rows, and nothing looked at its structure.
Deleting a single `</td>` passes every other check: browsers do not error, they
silently reflow, so every cell from that row onward renders in the wrong column
and the page still "works". On a page with 130 reference rows nobody reads to
the end, that can ship.

What it asserts:
  - tag balance, with an explicit void-element set
  - no duplicate element ids
  - every <img> has an alt attribute
  - every <a href="#..."> resolves to an id on the same page
  - every <script type="application/ld+json"> parses
  - <html lang> is present

A note on the parser, because it changes what this means: html.parser does no
implicit end-tag inference. A real browser closes <p> when it sees a block
element; this does not. That is deliberate here — it codifies the house style
of closing everything explicitly, which both pages already follow, rather than
imposing a new rule. If that style ever changes, this check has to change with
it.

Usage:  python3 .github/scripts/check-markup.py
Exit:   0 clean, 1 otherwise.
"""
import json
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Elements with no closing tag. `html.parser` reports these through
# handle_startendtag only when they are written self-closing, so both spellings
# have to be tolerated.
VOID = {
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
    'meta', 'param', 'source', 'track', 'wbr',
}

# Raw-text elements whose contents are not markup.
RAW = {'script', 'style'}


class Structure(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.stack = []
        self.problems = []
        self.ids = {}
        self.imgs_without_alt = []
        self.anchors = []
        self.jsonld = []
        self._collect_jsonld = False
        self._buf = ''
        self.lang = None

    def handle_starttag(self, tag, attrs):
        attrd = dict(attrs)
        if tag == 'html':
            self.lang = attrd.get('lang')
        if 'id' in attrd:
            if attrd['id'] in self.ids:
                self.problems.append(
                    f'line {self.getpos()[0]}: duplicate id="{attrd["id"]}" '
                    f'(first at line {self.ids[attrd["id"]]})')
            else:
                self.ids[attrd['id']] = self.getpos()[0]
        if tag == 'img' and 'alt' not in attrd:
            self.imgs_without_alt.append(self.getpos()[0])
        if tag == 'a' and attrd.get('href', '').startswith('#'):
            self.anchors.append((attrd['href'][1:], self.getpos()[0]))
        if tag == 'script' and attrd.get('type') == 'application/ld+json':
            self._collect_jsonld = True
            self._buf = ''
        if tag in VOID:
            return
        self.stack.append((tag, self.getpos()[0]))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_data(self, data):
        if self._collect_jsonld:
            self._buf += data

    def handle_endtag(self, tag):
        if tag == 'script' and self._collect_jsonld:
            self.jsonld.append((self._buf, self.getpos()[0]))
            self._collect_jsonld = False
        if tag in VOID:
            return
        if not self.stack:
            self.problems.append(f'line {self.getpos()[0]}: </{tag}> with nothing open')
            return
        if self.stack[-1][0] != tag:
            open_tag, open_line = self.stack[-1]
            self.problems.append(
                f'line {self.getpos()[0]}: </{tag}> closes <{open_tag}> '
                f'opened at line {open_line}')
            # Recover by unwinding to the matching tag if there is one, so one
            # mistake does not cascade into a hundred.
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i][0] == tag:
                    del self.stack[i:]
                    return
            return
        self.stack.pop()


def check(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as fh:
        raw = fh.read()
    parser = Structure()
    parser.feed(raw)
    problems = list(parser.problems)

    for tag, line in parser.stack:
        if tag not in RAW:
            problems.append(f'line {line}: <{tag}> is never closed')

    for line in parser.imgs_without_alt:
        problems.append(f'line {line}: <img> with no alt attribute')

    # Both pages are hash-routed SPAs: `#ingress2gateway` is a view name that
    # index.js resolves to the pane `id="page-ingress2gateway"`, not an element
    # id. Treating those as broken anchors produces nine false positives on the
    # landing page alone, which is how a check gets switched off — so resolve
    # the routed form too, and require that the pane actually exists.
    for target, line in parser.anchors:
        if not target:
            continue
        if target in parser.ids or f'page-{target}' in parser.ids:
            continue
        problems.append(f'line {line}: href="#{target}" resolves to neither an id '
                        f'nor a pane (id="page-{target}") on this page')

    for body, line in parser.jsonld:
        try:
            json.loads(body)
        except json.JSONDecodeError as err:
            problems.append(f'line {line}: JSON-LD block does not parse: {err}')

    if not parser.lang:
        problems.append('<html> has no lang attribute')

    return problems, len(parser.ids), len(parser.jsonld)


def main():
    total = 0
    for path in sorted(f for f in os.listdir(ROOT) if f.endswith('.html')):
        problems, n_ids, n_jsonld = check(path)
        status = 'FAIL' if problems else 'ok  '
        print(f'  {status}  {path}  ({n_ids} ids, {n_jsonld} JSON-LD block(s))')
        for p in problems:
            print(f'          {p}')
        total += len(problems)

    print()
    if total:
        print(f'{total} markup problem(s).')
        return 1
    print('Both pages are structurally sound: tags balance, ids are unique,')
    print('every in-page anchor resolves, and every JSON-LD block parses.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
