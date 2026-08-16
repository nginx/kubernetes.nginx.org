#!/usr/bin/env python3
"""Assert every version string on the site agrees with its source of truth.

Version numbers live in nine kinds of place and nothing tied them together.
The failure is asymmetric, which is what makes it invisible: `index.js` fetches
live releases at runtime, so the landing page self-heals in any browser and
looks current no matter what the file says. `migration-core.js` has no fetch
path at all and serves whatever was last typed. So a half-finished bump leaves
the landing page right and the migration tool a release behind, and the only
person who sees the difference is a reader following the tool's install command.

Sources of truth, in order of authority:
  assets/js/index.js          VERSION_CONFIG — the fallbacks the landing page
                              ships and the shape every data-version binding
                              in index.html resolves against
  assets/js/migration-core.js NIC.VERSION / NIC.HELM_VERSION — the migration
                              TARGET, used to build the install commands
  assets/js/migration-*.js    INGRESS_NGINX_VERSION — the migration SOURCE

Everything else is a copy, and this asserts every copy.

What this deliberately does NOT check:
  - `badge badge-new` labels ("New v5.4.0"). They are claims about which
    release introduced a construct, not statements about the pinned version,
    and bumping them would be a factual error. See the release-update skill.
  - the community controller's v1.15.1. `kubernetes/ingress-nginx` is archived
    and that is its final release, so it is a constant, not a pin.
  - the NGINX and Kubernetes rows in the compatibility tables. Those cannot be
    derived from anything in this repo; they are marked with `data-compat` so
    they are at least greppable per product, and the release skill owns them.

Usage:  python3 .github/scripts/check-versions.py
Exit:   0 every copy agrees, 1 otherwise.
"""
import os
import re
import sys

# This file lives at <root>/.github/scripts/, so three levels up.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as fh:
        return fh.read()


def html_files():
    return [f for f in sorted(os.listdir(ROOT)) if f.endswith('.html')]


def parse_version_config(js):
    """VERSION_CONFIG out of index.js, as {product: {field: value}}.

    Regex rather than a JS parser because there is no build step and no
    dependencies; the shape is stable and a miss fails loudly below rather
    than silently returning an empty dict.
    """
    block = re.search(r'let VERSION_CONFIG = \{(.*?)\n {8}\};', js, re.S)
    if not block:
        sys.exit('check-versions: could not find VERSION_CONFIG in assets/js/index.js')
    config = {}
    for product, body in re.findall(r'(\w+):\s*\{(.*?)\}\s*\}', block.group(1)):
        fields = dict(re.findall(r"(\w+):\s*'([^']+)'", body))
        config[product] = fields
    if not config:
        sys.exit('check-versions: VERSION_CONFIG parsed to nothing — has its shape changed?')
    return config


def render(value, fmt):
    """How a bound value is written at a call site.

    Three formats, and this is the reason a `v`-prefixed grep misses sites:
      default  v5.5.4   the release tag as GitHub writes it
      bare     2.6.4    Helm's --version flag, which rejects a leading v
      atv      @v1.2.0  go install's module suffix
    """
    if fmt == 'bare':
        return value.lstrip('v')
    if fmt == 'atv':
        return '@' + value
    return value


def check_bindings(config):
    """Every data-version element's static text against VERSION_CONFIG.

    The text is what a reader sees before the fetch resolves — and all a reader
    ever sees if the fetch fails, is blocked, or is served from a stale cache.
    """
    failures = []
    for page in html_files():
        text = read(page)
        for tag in re.findall(r'<[^>]*\sdata-version="[^"]*"[^>]*>[^<]*', text):
            m = re.search(r'data-version="(\w+)\.(\w+)"', tag)
            product, field = m.group(1), m.group(2)
            fmt = re.search(r'data-version-format="(\w+)"', tag)
            shown = tag.split('>', 1)[1].strip()
            if product not in config:
                failures.append(f'{page}: data-version="{product}.{field}" names no product '
                                f'in VERSION_CONFIG')
                continue
            expected = config[product].get(field)
            if expected is None:
                failures.append(f'{page}: data-version="{product}.{field}" — VERSION_CONFIG.'
                                f'{product} has no {field}')
                continue
            want = render(expected, fmt.group(1) if fmt else None)
            if shown and shown != want:
                failures.append(f'{page}: data-version="{product}.{field}" shows "{shown}", '
                                f'VERSION_CONFIG says "{want}"')
    return failures


def check_release_hrefs(config):
    """`releases/tag/<v>` hrefs against the release each repo is pinned to.

    Note the trap this has to avoid: the Helm pill's href legitimately points
    at `tree/<RELEASE tag>/charts/...`, because the chart is read out of the
    release tag rather than out of a chart-versioned ref. So a `nic.helm`
    binding can correctly sit on an element whose href carries nic.release.
    """
    by_repo = {c['repo']: p for p, c in config.items() if 'repo' in c}
    failures = []
    for page in html_files():
        for repo, tag in re.findall(
                r'https://github\.com/([\w-]+/[\w-]+)/(?:releases/tag|tree)/([\w.@-]+)', read(page)):
            product = by_repo.get(repo)
            if not product:
                continue
            release = config[product]['release']
            # The community controller prefixes its tags; it is archived and
            # pinned deliberately, and is not in VERSION_CONFIG at all.
            if tag != release:
                failures.append(f'{page}: {repo} link points at {tag}, but VERSION_CONFIG '
                                f'pins {product} to {release}')
    return failures


def check_migration_target(config):
    """migration-core.js against VERSION_CONFIG, and its install commands.

    The migration tool has no fetch path, so this is the only thing standing
    between it and a silent drift away from the landing page.
    """
    failures = []
    core = read('assets/js/migration-core.js')
    version = re.search(r"VERSION:\s*'([^']+)'", core)
    helm = re.search(r"HELM_VERSION:\s*'([^']+)'", core)
    if not version or not helm:
        return ['assets/js/migration-core.js: could not find NIC.VERSION / NIC.HELM_VERSION']

    want_release = config['nic']['release']
    want_helm = config['nic']['helm'].lstrip('v')
    if version.group(1) != want_release:
        failures.append(f'assets/js/migration-core.js: NIC.VERSION is {version.group(1)}, '
                        f'VERSION_CONFIG.nic.release is {want_release}')
    if helm.group(1) != want_helm:
        failures.append(f'assets/js/migration-core.js: NIC.HELM_VERSION is {helm.group(1)}, '
                        f'VERSION_CONFIG.nic.helm is {want_helm}')

    # The static copies of the two install commands, which the JS overwrites at
    # runtime but which are what a reader copies if the script has not run.
    for page in html_files():
        text = read(page)
        for attr, pattern, want in (
                ('data-nic-helm-install', r'--version (\S+)', helm.group(1)),
                ('data-nic-crd-install', r'kubernetes-ingress/(\S+?)/deploy', version.group(1))):
            for tag in re.findall(r'<code ' + attr + r'[^>]*>([^<]*)</code>', text):
                found = re.search(pattern, tag)
                if found and found.group(1) != want:
                    failures.append(f'{page}: {attr} says {found.group(1)}, expected {want}')
    return failures


def check_version_reference_boxes():
    """The migration page repeats its Version-reference banner once per view.

    They are byte-identical today, which is the only reason a bump that edits
    one of them is survivable. Assert the identity rather than parsing each,
    so "I updated the banner" cannot mean "I updated one of the three".
    """
    failures = []
    for page in html_files():
        boxes = re.findall(r'<div class="info-box note"[^>]*><strong>Version reference:.*?</div>',
                           read(page), re.S)
        if len(set(boxes)) > 1:
            failures.append(f'{page}: {len(boxes)} Version-reference boxes and '
                            f'{len(set(boxes))} distinct variants — they must be identical')
    return failures


def check_source_version():
    """The migration SOURCE version, against the page spans it binds.

    Driven by the module's own `versionBindings` list rather than by guessing
    at attribute names: the page carries both a source and a target version
    span, and matching `data-*-version` loosely conflates them.
    """
    failures = []
    for js in sorted(os.listdir(os.path.join(ROOT, 'assets/js'))):
        if not re.match(r'migration-(?!core)[\w-]+\.js$', js):
            continue
        src = read(f'assets/js/{js}')
        pin = re.search(r"const \w*VERSION\w* = '([^']+)'", src)
        if not pin:
            continue
        version = pin.group(1)
        # attr -> the constant it renders; only the `text:` bindings carry a
        # bare version, `href:` bindings are covered by check_release_hrefs.
        attrs = re.findall(r"\{\s*attr:\s*'([\w-]+)',\s*text:", src)
        for page in html_files():
            text = read(page)
            if f'assets/js/{js}' not in text:
                continue
            for attr in attrs:
                for shown in re.findall(r'<span ' + attr + r'[^>]*>([^<]*)</span>', text):
                    if shown != version:
                        failures.append(f'{page}: <span {attr}> shows "{shown}", '
                                        f'{js} pins "{version}"')
            # The source's own release link, which is built from the same pin.
            for tag in re.findall(r'/ingress-nginx/releases/tag/controller-([\w.-]+)', text):
                if tag != version:
                    failures.append(f'{page}: community release link points at {tag}, '
                                    f'{js} pins {version}')
    return failures


def main():
    config = parse_version_config(read('assets/js/index.js'))

    print('VERSION_CONFIG (assets/js/index.js):')
    for product in sorted(config):
        fields = {k: v for k, v in config[product].items() if k in ('release', 'helm')}
        print(f'  {product:5} {fields}')
    core = re.search(r"VERSION:\s*'([^']+)'", read('assets/js/migration-core.js'))
    print(f'  migration target NIC.VERSION {core.group(1) if core else "?"}\n')

    failures = []
    for label, fn in (
            ('data-version bindings', lambda: check_bindings(config)),
            ('release/tree hrefs', lambda: check_release_hrefs(config)),
            ('migration target', lambda: check_migration_target(config)),
            ('version-reference boxes', check_version_reference_boxes),
            ('migration source version', check_source_version)):
        found = fn()
        print(f'  {"FAIL" if found else "ok  "}  {label}')
        failures += found

    print()
    if failures:
        print(f'{len(failures)} version inconsistenc(ies):')
        for f in failures:
            print(f'  - {f}')
        return 1
    print('Every version string agrees with its source of truth.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
