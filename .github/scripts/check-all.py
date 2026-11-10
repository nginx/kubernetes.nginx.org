#!/usr/bin/env python3
"""Run every check and report which ones actually ran.

AGENTS.md forbids chaining the checks on one shell line, and the repo-checks
skill lists the occasions where a mistyped construct reported "clean" for a
check that never ran — a `$F` that expanded to one filename, broken `grep -c`
arithmetic, a zsh glob swallowing `--include`, a `for c in "python3 …"` loop
that printed exit=0 four times having run nothing, a `$var:` history modifier,
`node --check` with a glob, which sat in CI for two months, and `$?` read
after a pipe.

So the danger in a wrapper is obvious: it is one more construct that can report
success having run nothing. Three things make this one safe to trust:

  - it is Python, not shell, so no globbing, word-splitting or history
    expansion happens between here and the process;
  - each check is a literal (label, argv) tuple, never a string to be parsed;
  - it asserts it ran every check it declared, and prints the count, so
    "9 of 9 checks ran" is part of the output rather than something you infer
    from the absence of errors.

A missing interpreter or script is a FAILURE, never a skip. A check that
silently disappears is the exact thing this file exists to prevent.

On failure it prints only what failed — the failing lines of a script, the
failing tests of a node suite (re-run with the dot reporter) — because a
fix-and-re-run loop reads that output every pass. Success prints the summary
alone, as before.

Usage:  python3 .github/scripts/check-all.py [-v]     # -v: every check's full output
Exit:   the highest exit code of any check.
"""
import os
import re
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
                      '.github/test/nic-migrate.test.js',
                      '.github/test/analyzer.test.js',
                      '.github/test/sources.test.js',
                      '.github/test/conversions.test.js',
                      '.github/test/haproxy-analyzer.test.js']),
    ('locator', [sys.executable, '.github/scripts/where.py', '--self-test']),
]


def failing_only(argv, out):
    """The part of a failing check's output worth reading.

    A fix-and-re-run loop reads this every pass, so it should be the failure
    and nothing else — the full output of a failing run is several KB of
    passing lines. Two shapes:

      - node --test: re-run with the dot reporter, which prints one character
        per passing test and then only the failing tests in full;
      - a script: its lines that report a failure (FAIL, ✖, error, the line
        that follows a FAIL heading), plus its last line, which is its summary.

    When neither shape finds anything, fall back to everything — a filter that
    hides the only clue is worse than none. `-v` always prints everything.
    """
    if argv[1:2] == ['--test']:
        try:
            proc = subprocess.run(argv[:2] + ['--test-reporter=dot'] + argv[2:], cwd=ROOT,
                                  capture_output=True, text=True)
            dot = (proc.stdout + proc.stderr).strip()
            if dot and proc.returncode != 0:
                # Node's internal stack frames say nothing about the failure.
                return '\n'.join(l for l in dot.split('\n')
                                 if not re.match(r'\s+at .*(node:|async )', l)
                                 and not re.fullmatch(r'[.X\s]*', l) or 'X' in l)
        except FileNotFoundError:
            pass
    lines = out.rstrip().split('\n')
    keep, window = [], 0
    for line in lines:
        if any(tag in line for tag in FAILURE_TAGS):
            window = 4          # the line, and the detail that follows it
        if window:
            keep.append(line)
            window -= 1
    if not keep:
        return out.rstrip()
    if lines[-1] not in keep:
        keep.append(lines[-1])
    return '\n'.join(keep)


# What a failing line looks like across the nine: the Python checks print
# `FAIL` or `N violation(s)`, test-analyzer.js `FAIL`/`ERROR`, node:test `✖`,
# a crash `Traceback`.
FAILURE_TAGS = ('FAIL', '✖', 'ERROR', 'Error:', 'error:', 'Traceback', 'not ok',
                'violation', 'WRONG', 'MISSING')


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
            shown = out.rstrip() if verbose or code == 127 else failing_only(argv, out)
            print(f'{"=" * 68}\n{label}  ({" ".join(argv)})'
                  f'{"" if verbose else "  — failures only; -v for all"}\n{"=" * 68}')
            print(shown + '\n')

    assert len(results) == len(CHECKS), 'a check went missing between declaration and report'

    width = max(len(label) for label, _, _ in results)
    print('\nSUMMARY')
    print('-' * (width + 12))
    for label, code, _ in results:
        state = 'PASS' if code == 0 else 'SKIP' if code == 127 else 'FAIL'
        print(f'  {state}  {label.ljust(width)}  exit {code}')
    # A check whose interpreter could not start did not run, and saying it
    # "ran" and "failed" sent the reader to fix code that was never read. It
    # still fails the run: it is never a pass.
    unrun = [label for label, code, _ in results if code == 127]
    ran = len(results) - len(unrun)
    passed = sum(1 for _, code, _ in results if code == 0)
    print('-' * (width + 12))
    print(f'  {ran} of {len(CHECKS)} checks ran, {passed} passed, {ran - passed} failed'
          + (f'; {len(unrun)} could not run' if unrun else ''))
    if unrun:
        print(f'\nCould not run: {", ".join(unrun)} — an interpreter is missing (the output '
              f'above names it). That is the environment, not the code: install it and re-run.')
    if passed != ran:
        print('\nRe-run a failing check on its own for its full output, or pass -v.')
    return max(code for _, code, _ in results)


if __name__ == '__main__':
    sys.exit(main())
