#!/usr/bin/env python3
"""Run every check and report which ones actually ran.

AGENTS.md forbids chaining the checks on one shell line, and lists six
occasions where a mistyped construct reported "clean" for a check that never
ran — a `$F` that expanded to one filename, broken `grep -c` arithmetic, a zsh
glob swallowing `--include`, a `for c in "python3 …"` loop that printed exit=0
four times having run nothing, a `$var:` history modifier, and `node --check`
with a glob, which sat in CI for two months.

So the danger in a wrapper is obvious: it is one more construct that can report
success having run nothing. Three things make this one safe to trust:

  - it is Python, not shell, so no globbing, word-splitting or history
    expansion happens between here and the process;
  - each check is a literal (label, argv) tuple, never a string to be parsed;
  - it asserts it ran every check it declared, and prints the count, so
    "7 of 7 checks ran" is part of the output rather than something you infer
    from the absence of errors.

A missing interpreter or script is a FAILURE, never a skip. A check that
silently disappears is the exact thing this file exists to prevent.

Usage:  python3 .github/scripts/check-all.py
Exit:   the highest exit code of any check.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CHECKS = [
    ('js syntax', [sys.executable, '.github/scripts/check-syntax.py']),
    ('design tokens', [sys.executable, '.github/scripts/check-tokens.py']),
    ('colour contrast', [sys.executable, '.github/scripts/check-contrast.py']),
    ('classes & load order', [sys.executable, '.github/scripts/check-classes.py']),
    ('version strings', [sys.executable, '.github/scripts/check-versions.py']),
    ('markup structure', [sys.executable, '.github/scripts/check-markup.py']),
    ('migration analyzer', ['node', '.github/scripts/test-analyzer.js']),
    # Listed by name rather than globbed: CI runs `node --test
    # .github/test/*.test.js`, and a file that only the glob knows about would
    # be absent here without anything reporting a smaller suite. Add new test
    # files to BOTH.
    ('wiring suite', ['node', '--test', '.github/test/index.test.js',
                      '.github/test/wiring.test.js',
                      '.github/test/nic-migrate.test.js']),
    ('locator', [sys.executable, '.github/scripts/where.py', '--self-test']),
]


def main():
    verbose = '-v' in sys.argv or '--verbose' in sys.argv
    results = []

    for label, argv in CHECKS:
        try:
            proc = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)
            code, out = proc.returncode, proc.stdout + proc.stderr
        except FileNotFoundError as err:
            # Not a skip. An absent interpreter means this check did not run,
            # and a run that did not happen must never read as a pass.
            code, out = 127, f'could not execute {argv[0]}: {err}'
        results.append((label, code, out))
        if verbose or code != 0:
            print(f'{"=" * 68}\n{label}  ({" ".join(argv)})\n{"=" * 68}')
            print(out.rstrip() + '\n')

    assert len(results) == len(CHECKS), 'a check went missing between declaration and report'

    width = max(len(label) for label, _, _ in results)
    print('\nSUMMARY')
    print('-' * (width + 12))
    for label, code, _ in results:
        print(f'  {"PASS" if code == 0 else "FAIL"}  {label.ljust(width)}  exit {code}')
    passed = sum(1 for _, code, _ in results if code == 0)
    print('-' * (width + 12))
    print(f'  {len(results)} of {len(CHECKS)} checks ran, {passed} passed, '
          f'{len(results) - passed} failed')
    if passed != len(results):
        print('\nRe-run a failing check on its own for its full output, or pass -v.')
    return max(code for _, code, _ in results)


if __name__ == '__main__':
    sys.exit(main())
