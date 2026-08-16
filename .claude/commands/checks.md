---
description: Run every repository check and report which ones ran
allowed-tools: Bash(python3 .github/scripts/check-all.py)
---

Run the checks:

!`python3 .github/scripts/check-all.py`

Report the result honestly:

- If every check passed, say so — and say plainly that the checks are static
  readers and cannot see the rendered page. If this turn changed anything a
  reader sees, render it (`verify-visually` skill) before calling it verified.
- If anything failed, fix it. Do not report a turn as done on a failing suite.
- If the summary line says fewer checks ran than were declared, treat that as a
  failure of the runner itself and investigate — a check that silently does not
  run is the failure mode this repository has recorded six times.
