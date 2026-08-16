# Contributing Guidelines

The following is a set of guidelines for contributing to this project. We really appreciate that you are considering contributing!

#### Table of Contents

- [Getting Started](#getting-started)
- [Contributing](#contributing)
- [Code Guidelines](#code-guidelines)
- [Code of Conduct](/CODE_OF_CONDUCT.md)

## Getting Started

This is a documentation-only project with no build step. Clone the repo and open `index.html` directly in a browser to preview your changes; paths are relative, so this works from the filesystem, and `python3 -m http.server` gets you closer to production.

The two pages (`index.html` and `ingress-nginx-migration.html`) hold markup only — their styles and behaviour live in `assets/css/` and `assets/js/`, shared between both pages, so a change there affects more than the file you are editing. Run the checks listed in the [README](/README.md#checks) before opening a pull request; CI runs the same ones.

<!-- ### Project Overview & Structure (OPTIONAL) -->

## Contributing

### Report a Bug

To report a bug, open an issue on GitHub with the label `bug` using the available [bug report issue form](/.github/ISSUE_TEMPLATE/bug_report.yml). Please ensure the bug has not already been reported. **If the bug is a potential security vulnerability, please report it using our [security policy](/SECURITY.md).**

### Suggest a Feature or Enhancement

To suggest a feature or enhancement, please create an issue on GitHub with the label `enhancement` using the available [feature request issue form](/.github/ISSUE_TEMPLATE/feature_request.yml). Please ensure the feature or enhancement has not already been suggested.

### Open a Pull Request (PR)

- Fork the repo, create a branch, implement your changes, add any relevant tests, and submit a PR when your changes are **tested** and ready for review.
- Fill in the [PR template](/.github/pull_request_template.md).

> [!NOTE]
> If you'd like to implement a new feature, please consider creating a [feature request issue](/.github/ISSUE_TEMPLATE/feature_request.yml) first to start a discussion about the feature.

#### F5 Contributor License Agreement (CLA)

F5 requires all contributors to agree to the terms of the F5 CLA (available [here](https://github.com/f5/f5-cla/blob/main/docs/f5_cla.md)) before any of their changes can be incorporated into an F5 Open Source repository (even contributions to the F5 CLA itself!).

If you have not yet agreed to the F5 CLA terms and submit a PR to this repository, a bot will prompt you to view and agree to the F5 CLA. You will have to agree to the F5 CLA terms through a comment in the PR before any of your changes can be merged. Your agreement signature will be safely stored by F5 and no longer be required in future PRs.

## Code Guidelines

<!-- ### Go/Python/Bash/etc... Guidelines (OPTIONAL) -->

### Git Guidelines

- Keep a clean, concise and meaningful git commit history on your branch (within reason), rebasing locally and squashing before submitting a PR.
- Use the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) prefix in the subject line (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`, `chore:`), in the imperative mood: "Add feature", not "Added feature".
- **Write a body, and make it a record of the reasoning.** The commit bodies in this repository are its largest body of decision-making — roughly 4,000 words of what was tried, what was rejected, and how it was verified. That is knowledge which exists in no other file, and it is why `git log --grep='Considered and rejected'` and `git log -S<name>` are the first things to run before re-proposing an idea or deleting something that looks dead.

  A good body here answers four things:

  - **What changed**, in enough detail that a reader need not open the diff to follow the argument.
  - **Why** — the failure it fixes, ideally with the numbers or the file and line.
  - **What was considered and rejected**, so the next person does not spend an afternoon rediscovering it.
  - **How it was verified.** For a check, that means the fault you planted and what it reported. "Fixed the check" is worth much less later than "planted a misspelled transform; the run reported it and exited 1".

- Reference issues and pull requests liberally after the subject line.
