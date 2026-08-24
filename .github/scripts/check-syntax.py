#!/usr/bin/env python3
"""Parse every first-party script, one file per `node --check` invocation.

`node --check` parses only its first positional argument and silently discards
the rest — verified: `node --check good.js broken.js` exits 0. So
`node --check assets/js/*.js` only ever checked assets/js/index.js, which is
how assets/js/shared.js went unparsed by anything for two months while CI
reported a green step named "Syntax-check all first-party scripts".

The loop lives here rather than in a shell line so the glob is expanded by
Python and each path is passed as a single argv element. That removes the whole
class of failure AGENTS.md's incident list is about.

Usage:  python3 .github/scripts/check-syntax.py
Exit:   0 every file parses, 1 otherwise.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Every tree holding first-party JavaScript. `tools/` is walked recursively
# because the CLI there has a lib/ subdirectory; assets/js is flat by design.
# Keeping tools/ out of this list would recreate exactly the gap described
# above — a directory of shipped scripts that nothing parses — one directory
# over from where it happened the first time.
JS_TREES = [('assets/js', False), ('tools', True)]


def collect():
    """Repo-relative paths of every .js file under the trees above."""
    found = []
    for rel, recurse in JS_TREES:
        base = os.path.join(ROOT, rel)
        if not os.path.isdir(base):
            continue
        if recurse:
            for dirpath, _dirnames, filenames in os.walk(base):
                for name in filenames:
                    if name.endswith('.js'):
                        full = os.path.join(dirpath, name)
                        found.append(os.path.relpath(full, ROOT))
        else:
            found.extend(os.path.join(rel, f) for f in os.listdir(base) if f.endswith('.js'))
    return sorted(found)


def main():
    files = collect()
    if not files:
        print('no scripts found in assets/js — is this being run from the repo root?')
        return 1

    failures = 0
    for rel in files:
        try:
            proc = subprocess.run(['node', '--check', rel], cwd=ROOT,
                                  capture_output=True, text=True)
        except FileNotFoundError:
            print('node is not on PATH — the syntax check did not run')
            return 127
        if proc.returncode == 0:
            print(f'  ok    {rel}')
        else:
            failures += 1
            print(f'  FAIL  {rel}')
            print('        ' + proc.stderr.strip().replace('\n', '\n        '))

    print()
    if failures:
        print(f'{failures} of {len(files)} script(s) failed to parse.')
        return 1
    print(f'All {len(files)} first-party scripts parse.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
