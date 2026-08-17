#!/usr/bin/env python3
"""End-to-end migration test: deploy a real ingress-nginx Ingress, convert it
with nic-migrate, and prove the F5 NGINX Ingress Controller serves it the same.

=============================================================================
The assertion is EQUIVALENCE, not a hardcoded expectation. Each case is sent to
both controllers and the two answers are compared. A test that asserted "NIC
returns /things/42" would encode today's belief about how rewritePath handles a
capture group; a test that asserts "NIC returns whatever ingress-nginx returned"
encodes the thing a migration actually promises. When they differ, the
difference is the finding — that is the pipeline working, not failing.

Both controllers run at once on distinct IngressClasses (nginx, nginx-nic), so
the comparison is simultaneous rather than before-and-after. Requests are made
from a pod inside the cluster straight at each controller's ClusterIP Service,
which avoids hostPort and NodePort collisions between the two entirely.

Written in Python for the same reason .github/scripts/check-all.py is: this is a
long sequence of commands whose individual exit codes all matter, and a shell
pipeline reports the status of the last command in the pipe. See the incident
list in AGENTS.md.

Usage:
    python3 tools/nic-migrate/e2e/run-e2e.py                 # full run, cluster deleted after
    python3 tools/nic-migrate/e2e/run-e2e.py --keep          # leave the cluster up
    python3 tools/nic-migrate/e2e/run-e2e.py --skip-cluster  # use the current kube context
    python3 tools/nic-migrate/e2e/run-e2e.py --target ingress

Exit: 0 every case agreed and every absolute expectation held, 1 otherwise,
      2 a prerequisite is missing.
=============================================================================
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
E2E = os.path.dirname(os.path.abspath(__file__))
MANIFESTS = os.path.join(E2E, 'manifests')
NS = 'e2e-shop'
CLUSTER = 'nic-migrate-e2e'

COMMUNITY_NS = 'ingress-nginx'
COMMUNITY_CLASS = 'nginx'
NIC_NS = 'nginx-ingress'
NIC_CLASS = 'nginx-nic'
# --target ingress reuses the source Ingress's name, so applying the output
# unsuffixed would overwrite the very resource this run is comparing against.
NAME_SUFFIX = '-nic'

# Pinned so a run is reproducible. The NIC chart matches what the site
# documents; see .github/scripts/check-versions.py for the three formats.
NIC_CHART = 'oci://ghcr.io/nginx/charts/nginx-ingress'
NIC_CHART_VERSION = '2.6.4'
COMMUNITY_REPO = 'https://kubernetes.github.io/ingress-nginx'


# --------------------------------------------------------------- plumbing

class Fail(Exception):
    pass


# Whether this run created the cluster, and so owns deleting it.
CREATED = {'cluster': False}

# The four checkpoints, in order. Each isolates a different failure mode, so a
# red run says which layer broke instead of only that something did:
#   baseline       the fixture and ingress-nginx work at all
#   nic-installed  NIC is deployed and answering, before any converted resource
#   converted      both controllers serve, and NIC matches the baseline
#   cutover        ingress-nginx is gone and NIC alone still matches
# --until stops after any of them and leaves the cluster up to poke at.
STAGES = ['baseline', 'nic-installed', 'converted', 'cutover']


def run(argv, *, input_=None, check=True, quiet=False, timeout=600):
    """One command, one exit code, never chained through a pipe."""
    try:
        proc = subprocess.run(argv, input=input_, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        # A missing binary is a Fail like any other, not a traceback. Reaching
        # here past preflight means a tool went away mid-run, or a code path
        # ran a tool preflight does not know about.
        raise Fail('%s is not on PATH' % argv[0])
    except subprocess.TimeoutExpired:
        raise Fail('%s timed out after %ds' % (' '.join(argv[:3]), timeout))
    if check and proc.returncode != 0:
        raise Fail('%s exited %d\n%s%s' % (' '.join(argv[:4]), proc.returncode,
                                           proc.stdout.strip(), proc.stderr.strip()))
    if not quiet and proc.returncode != 0:
        sys.stderr.write(proc.stderr)
    return proc


def kubectl(*args, **kw):
    return run(['kubectl', *args], **kw)


def helm(*args, **kw):
    return run(['helm', *args], **kw)


def say(msg):
    print(msg, flush=True)


def phase(title):
    say('\n\033[1m== %s\033[0m' % title if sys.stdout.isatty() else '\n== %s' % title)


def wait_for(what, fn, timeout=300, interval=3):
    """Poll until fn() is truthy. Reports what it was waiting for on timeout —
    a bare 'timed out' is useless at 3am in CI."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Fail as err:
            last = str(err)
        time.sleep(interval)
    raise Fail('timed out after %ds waiting for %s (last: %s)' % (timeout, what, last))


# ----------------------------------------------------------------- phases

def reachable_context():
    """The current context, if there is one and it answers. Used to point at
    --skip-cluster rather than demanding kind from someone who already has a
    cluster running."""
    try:
        ctx = run(['kubectl', 'config', 'current-context'], check=False, quiet=True, timeout=15)
        if ctx.returncode != 0 or not ctx.stdout.strip():
            return None
        ping = run(['kubectl', 'version', '-o', 'json'], check=False, quiet=True, timeout=20)
        return ctx.stdout.strip() if ping.returncode == 0 else None
    except Fail:
        return None


def preflight(args):
    phase('Preflight')
    needed = ['kubectl', 'helm', 'node', 'openssl']
    if not args.skip_cluster:
        needed += ['kind', 'docker']
    missing = [t for t in needed if shutil.which(t) is None]
    if missing:
        hint = ''
        if 'kind' in missing or 'docker' in missing:
            ctx = reachable_context()
            if ctx:
                hint = ('\n\n  You already have a working cluster: context "%s".\n'
                        '  Re-run against it and skip kind entirely:\n'
                        '      python3 tools/nic-migrate/e2e/run-e2e.py --skip-cluster' % ctx)
            else:
                hint = ('\n  kind:   brew install kind   (or: go install sigs.k8s.io/kind@v0.25.0)\n'
                        '  Or start any cluster (minikube start, k3d, Docker Desktop Kubernetes)\n'
                        '  and re-run with --skip-cluster.')
        raise Fail('not on PATH: %s%s' % (', '.join(missing), hint))

    if not args.skip_cluster:
        proc = run(['docker', 'info'], check=False, quiet=True, timeout=60)
        if proc.returncode != 0:
            ctx = reachable_context()
            extra = ('\n  Or use the cluster you already have: --skip-cluster (context "%s")' % ctx) if ctx else ''
            raise Fail('the Docker daemon is not running — start Docker Desktop and retry.' + extra)
    else:
        ctx = reachable_context()
        if not ctx:
            raise Fail('--skip-cluster needs a reachable cluster, and the current kube context '
                       'does not answer. Start one (minikube start / k3d cluster create) or drop '
                       '--skip-cluster to have kind build one.')
    say('  tools present: %s' % ', '.join(needed))


# ------------------------------------------------------------- self-test

def self_test():
    """Exercise the pure logic with no cluster, so the parts a cluster run is
    worst at diagnosing are covered everywhere the runner can be run at all.
    Mirrors where.py --self-test."""
    checks = []

    def check(name, got, want):
        checks.append((name, got == want, got, want))

    r = parse_response('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
                       'Set-Cookie: E2ESESSION=abc; Path=/\r\n\r\n'
                       '{"app":"api","uri":"/things/42"}')
    check('status', r['status'], 200)
    check('app', r['app'], 'api')
    check('uri', r['uri'], '/things/42')
    check('header lowercased', 'set-cookie' in r['headers'], True)

    # A redirect chain must report its final hop, not its first.
    r = parse_response('HTTP/1.1 308 Permanent Redirect\r\nLocation: https://x/\r\n\r\n'
                       'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"app":"web","uri":"/"}')
    check('final hop status', r['status'], 200)
    check('final hop app', r['app'], 'web')

    r = parse_response('HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\n\r\n<html>404</html>')
    check('non-JSON body', (r['status'], r['app']), (404, None))
    check('empty response', parse_response('')['status'], 0)

    # A case with no explicit compare falls back to the strict triple.
    names = [c['name'] for c in CASES]
    check('case names unique', len(set(names)), len(names))
    check('every case has a host', all(c.get('host') for c in CASES), True)
    check('every case has a path', all(c.get('path') for c in CASES), True)

    cmd = curl_argv('svc.ns.svc', dict(host='h', path='/x', scheme='https', headers={'Origin': 'o'}))
    check('https adds -k', '-k' in cmd, True)
    check('extra header sent', 'Origin: o' in cmd, True)
    # The URL must carry the real host so SNI matches; the Service name belongs
    # only in --connect-to. Getting this backwards is what broke tls-terminates.
    check('url uses the request host', cmd[-1], 'https://h:443/x')
    check('connect-to redirects to the service', 'h:443:svc.ns.svc:443' in cmd, True)
    check('no Host header override', not any(a.startswith('Host:') for a in cmd), True)

    plain = curl_argv('svc.ns.svc', dict(host='h', path='/'))
    check('http uses port 80', plain[-1], 'http://h:80/')
    check('http omits -k', '-k' not in plain, True)

    failed = [c for c in checks if not c[1]]
    for name, ok, got, want in checks:
        say('  %s  %s' % ('ok  ' if ok else 'FAIL', name))
        if not ok:
            say('        got %r, want %r' % (got, want))
    say('\n%d of %d self-tests passed.' % (len(checks) - len(failed), len(checks)))
    return 1 if failed else 0


def create_cluster(args):
    if args.skip_cluster:
        ctx = kubectl('config', 'current-context').stdout.strip()
        phase('Cluster (reusing context %s)' % ctx)
        return
    phase('Cluster')
    existing = run(['kind', 'get', 'clusters'], check=False, quiet=True).stdout.split()
    if CLUSTER in existing:
        say('  reusing existing kind cluster %s' % CLUSTER)
    else:
        say('  creating kind cluster %s (this takes a minute)' % CLUSTER)
        run(['kind', 'create', 'cluster', '--name', CLUSTER,
             '--config', os.path.join(MANIFESTS, 'kind-cluster.yaml'), '--wait', '120s'],
            timeout=900)
    CREATED['cluster'] = True
    kubectl('config', 'use-context', 'kind-' + CLUSTER)


COMMUNITY_SELECTOR = 'app.kubernetes.io/name=ingress-nginx'
NIC_SELECTOR = 'app.kubernetes.io/instance=nic'


def running_image(ns, selector):
    out = kubectl('get', 'pods', '-n', ns, '-l', selector,
                  '-o', 'jsonpath={.items[0].spec.containers[0].image}', check=False).stdout.strip()
    return out or '(unknown)'


def install_community(args):
    say('  installing community ingress-nginx (class %s)' % COMMUNITY_CLASS)
    helm('repo', 'add', 'ingress-nginx', COMMUNITY_REPO, check=False, quiet=True)
    helm('repo', 'update', 'ingress-nginx', quiet=True)
    cmd = ['upgrade', '--install', 'ingress-nginx', 'ingress-nginx/ingress-nginx',
           '-n', COMMUNITY_NS, '--create-namespace', '--wait', '--timeout', '10m',
           '--set', 'controller.service.type=ClusterIP',
           '--set', 'controller.ingressClassResource.name=' + COMMUNITY_CLASS,
           '--set', 'controller.ingressClassResource.controllerValue=k8s.io/ingress-nginx',
           # The admission webhook needs a cert and a reachable endpoint, and
           # adds a failure mode that has nothing to do with what is under test.
           '--set', 'controller.admissionWebhooks.enabled=false']
    if args.community_chart:
        cmd += ['--version', args.community_chart]
    helm(*cmd, timeout=900)
    return running_image(COMMUNITY_NS, COMMUNITY_SELECTOR)


def install_nic(args):
    # NGINX OSS. The chart's default image is the OSS build, which is the scope
    # of this pipeline: everything asserted has to be satisfiable without a
    # subscription. Nothing currently asserted needs Plus — session affinity in
    # particular works on OSS. A Plus run would set controller.nginxplus=true
    # and an image pull secret, and could add cases for JWT, OIDC and WAF, which
    # genuinely have no community equivalent.
    say('  installing F5 NGINX Ingress Controller, OSS (class %s)' % NIC_CLASS)
    helm('upgrade', '--install', 'nic', NIC_CHART, '--version', NIC_CHART_VERSION,
         '-n', NIC_NS, '--create-namespace', '--wait', '--timeout', '10m',
         '--set', 'controller.service.type=ClusterIP',
         '--set', 'controller.enableCustomResources=true',
         '--set', 'controller.ingressClass.name=' + NIC_CLASS,
         '--set', 'controller.ingressClass.create=true',
         # NIC ships with snippets off and REJECTS an Ingress that uses them,
         # rather than ignoring the annotation. --target ingress converts CORS
         # into nginx.org/server-snippets, so without this the converted
         # Ingress is never programmed and every case 404s. Found by running
         # this pipeline; nic-migrate now emits a note saying so.
         '--set', 'controller.enableSnippets=true',
         timeout=900)
    return running_image(NIC_NS, NIC_SELECTOR)


def uninstall_community():
    """The cutover. Order matters and mirrors a real one: stop serving the old
    resource first, then remove the controller. Uninstalling first would delete
    IngressClass nginx out from under a live Ingress."""
    kubectl('delete', 'ingress', 'shop', '-n', NS, '--ignore-not-found', check=False)
    helm('uninstall', 'ingress-nginx', '-n', COMMUNITY_NS, '--wait', '--timeout', '5m',
         check=False, timeout=600)
    # Helm returns as soon as the release is gone; the pods can outlive it
    # briefly, and a controller still answering would make "NIC serves this"
    # unprovable.
    wait_for('the community controller pods to disappear',
             lambda: kubectl('get', 'pods', '-n', COMMUNITY_NS, '-l', COMMUNITY_SELECTOR,
                             '-o', 'name', check=False).stdout.strip() == '' or None,
             timeout=180)


def controller_service(ns, selector):
    """ClusterIP Service DNS name for a controller, discovered rather than
    hardcoded — the name depends on the Helm release name."""
    out = kubectl('get', 'svc', '-n', ns, '-l', selector,
                  '-o', 'jsonpath={.items[*].metadata.name}').stdout.split()
    names = [n for n in out if 'admission' not in n and 'metrics' not in n]
    if not names:
        raise Fail('no Service found in namespace %s for selector %s' % (ns, selector))
    return '%s.%s.svc.cluster.local' % (names[0], ns)


def deploy_workload(args):
    phase('Workload')
    kubectl('apply', '-f', os.path.join(MANIFESTS, 'workload.yaml'))
    make_tls_secret()
    for dep in ('api', 'web', 'web2'):
        kubectl('rollout', 'status', 'deploy/' + dep, '-n', NS, '--timeout=180s')
    kubectl('wait', '--for=condition=Ready', 'pod/probe', '-n', NS, '--timeout=180s')
    say('  three backends and the probe pod are ready')


def make_tls_secret():
    """A self-signed cert so spec.tls has something real to point at. Created
    imperatively because generating an X.509 cert needs a tool, and openssl is
    the one every runner already has."""
    have = kubectl('get', 'secret', 'shop-tls', '-n', NS, check=False, quiet=True).returncode == 0
    if have:
        return
    if shutil.which('openssl') is None:
        raise Fail('openssl is not on PATH and is needed to create the TLS secret')
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        key = os.path.join(tmp, 'tls.key')
        crt = os.path.join(tmp, 'tls.crt')
        run(['openssl', 'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
             '-keyout', key, '-out', crt, '-days', '2',
             '-subj', '/CN=shop.example.com',
             '-addext', 'subjectAltName=DNS:shop.example.com'])
        kubectl('create', 'secret', 'tls', 'shop-tls', '-n', NS,
                '--cert=' + crt, '--key=' + key)
    say('  created the shop-tls secret')


def apply_source(args):
    phase('Source Ingress (community)')
    kubectl('apply', '-f', os.path.join(MANIFESTS, 'source-ingress.yaml'))
    wait_for('the community controller to program the Ingress',
             lambda: kubectl('get', 'ingress', 'shop', '-n', NS,
                             '-o', 'jsonpath={.status.loadBalancer}', check=False).stdout.strip() not in ('', '{}')
             or True, timeout=30, interval=2)
    # A ClusterIP controller never populates status.loadBalancer, so settle by
    # polling the controller itself in the baseline phase instead.
    say('  applied ingress/shop on class %s' % COMMUNITY_CLASS)


def convert(args):
    phase('Convert')
    cli = os.path.join(ROOT, 'tools', 'nic-migrate', 'nic-migrate.js')
    src = os.path.join(MANIFESTS, 'source-ingress.yaml')
    cmd = ['node', cli, 'convert', '-f', src, '--target', args.target,
           '--class', NIC_CLASS, '--name-suffix', NAME_SUFFIX, '--no-color']
    proc = run(cmd, check=False)
    if proc.returncode != 0 and not proc.stdout.strip():
        raise Fail('nic-migrate convert failed:\n' + proc.stderr)
    for line in proc.stderr.strip().splitlines():
        say('  ' + line)
    out_path = os.path.join(args.workdir, 'converted.yaml')
    os.makedirs(args.workdir, exist_ok=True)
    with open(out_path, 'w') as fh:
        fh.write(proc.stdout)
    kinds = [l.split(':', 1)[1].strip() for l in proc.stdout.splitlines() if l.startswith('kind:')]
    say('  wrote %s (%s)' % (os.path.relpath(out_path, ROOT), ', '.join(kinds) or 'nothing'))
    if not kinds:
        raise Fail('convert produced no resources')
    return out_path


def clear_previous():
    """Remove anything a previous run converted. Matters when reusing a cluster
    (--skip-cluster, or --keep then re-run): a VirtualServer left over from a
    --target virtualserver run would still be serving during a --target ingress
    run, and the comparison would silently be against the wrong resource."""
    kubectl('delete', 'virtualserver,policy,transportserver', '--all', '-n', NS,
            '--ignore-not-found', check=False, quiet=True)
    kubectl('delete', 'ingress', model_ingress_name(), '-n', NS,
            '--ignore-not-found', check=False, quiet=True)


def model_ingress_name():
    return 'shop' + NAME_SUFFIX


def apply_converted(args, path):
    phase('Apply converted manifests')
    with open(path) as fh:
        text = fh.read()
    clear_previous()
    kubectl('apply', '-f', path)

    if 'kind: VirtualServer' in text:
        def valid():
            # {end} is not optional: without it kubectl still exits 0 but emits
            # a trailing bare "=", which parses into an empty-named resource
            # whose state is "" — so `all(state == Valid)` is false forever and
            # the wait times out against two perfectly Valid VirtualServers.
            # Cost an entire e2e run to find. The empty-key filter below is the
            # belt to that braces.
            out = kubectl('get', 'virtualserver', '-n', NS,
                          '-o', 'jsonpath={range .items[*]}{.metadata.name}={.status.state} {end}',
                          check=False).stdout.strip()
            states = {k: v for k, v in
                      (p.split('=', 1) for p in out.split() if '=' in p) if k}
            if states and all(v == 'Valid' for v in states.values()):
                return ' '.join('%s=%s' % kv for kv in sorted(states.items()))
            return None
        say('  ' + wait_for('every VirtualServer to reach state Valid', valid, timeout=180))
    else:
        say('  applied the converted Ingress on class %s' % NIC_CLASS)
    # Give the controller a moment to reload after the resource is accepted.
    time.sleep(5)


# ------------------------------------------------------------------ probes

# Every case carries absolute expectations so stage 1 can validate itself: a
# baseline that asserted nothing would make "ingress-nginx works" vacuous, and
# every later stage compares against it. The later stages still compare against
# the RECORDED baseline rather than against these literals, so the equivalence
# property is kept — the absolutes only prove the fixture does what it claims.
CASES = [
    dict(name='root-routes-to-web', host='shop.example.com', path='/',
         expect_status=200, expect_app='web'),
    dict(name='api-path-routes-to-api', host='shop.example.com', path='/api/things/42',
         expect_status=200, expect_app='api'),
    # rewrite-target /$2 against /api(/|$)(.*) strips the prefix. Asserted here
    # because a fixture that stopped rewriting would otherwise still "match".
    dict(name='api-rewrite-strips-prefix', host='shop.example.com', path='/api/things/42',
         compare=('status', 'uri', 'app'),
         expect_status=200, expect_app='api', expect_uri='/things/42'),
    dict(name='api-bare-prefix', host='shop.example.com', path='/api',
         expect_status=200, expect_app='api'),
    dict(name='second-host-routes-to-web2', host='b.example.com', path='/',
         expect_status=200, expect_app='web2'),
    dict(name='unknown-host-is-refused', host='nope.example.com', path='/',
         compare=('status',), expect_status=404),
    dict(name='cors-header-present', host='shop.example.com', path='/',
         headers={'Origin': 'https://shop.example.com'},
         compare=('status',), expect_status=200, header_present='access-control-allow-origin'),
    # Session affinity maps to VirtualServer upstreams[].sessionCookie, which
    # works on NGINX OSS — this run asserts it and it passes. It is skipped on
    # the Ingress target for a different reason: the mapping is
    # VirtualServer-only and has no nginx.org annotation form, so there is
    # nothing for the annotation strategy to emit. Not a Plus limitation.
    dict(name='affinity-cookie-present', host='shop.example.com', path='/api/x',
         compare=('status',), expect_status=200, header_present='set-cookie',
         skip_targets=('ingress',),
         skip_reason='maps to VirtualServer sessionCookie, which has no Ingress annotation form'),
    dict(name='tls-terminates', host='shop.example.com', path='/', scheme='https',
         expect_status=200, expect_app='web'),
    dict(name='plain-http-not-redirected', host='shop.example.com', path='/',
         compare=('status',), expect_status=200),
]


def curl_argv(target, case):
    """The curl command for a case. Split out from http() so --self-test can
    check it without a cluster.

    --connect-to rather than a Host header: a Host header does not set SNI, so
    over TLS the handshake carries the controller's Service DNS name as the
    server name. ingress-nginx tolerates that and serves its default
    certificate; NIC answers `tlsv1 unrecognized name` and drops the
    connection. That is a difference between the two, but not one a real client
    would ever hit — real clients send the name they dialled. Keeping the URL
    as the real host and redirecting only the connection makes SNI and Host
    correct together, which is what is actually under test.
    """
    scheme = case.get('scheme', 'http')
    port = 443 if scheme == 'https' else 80
    host = case['host']
    cmd = ['curl', '-sS', '-i', '--max-time', '10']
    if scheme == 'https':
        cmd += ['-k']  # the fixture cert is self-signed
    cmd += ['--connect-to', '%s:%d:%s:%d' % (host, port, target, port)]
    for key, value in (case.get('headers') or {}).items():
        cmd += ['-H', '%s: %s' % (key, value)]
    cmd += ['%s://%s:%d%s' % (scheme, host, port, case['path'])]
    return cmd


def parse_response(raw):
    """Normalise a raw `curl -i` response. Pure, so --self-test can cover it —
    this is the most bug-prone part of the pipeline and the part a cluster run
    is worst at diagnosing."""
    if not raw or not raw.strip():
        return dict(status=0, headers={}, body='', app=None, uri=None, error='no response')

    # Take the last header block, so a redirect chain reports its final hop.
    blocks = raw.split('\r\n\r\n') if '\r\n\r\n' in raw else raw.split('\n\n')
    head, body = blocks[0], ''
    for i in range(len(blocks) - 1, 0, -1):
        if blocks[i].strip():
            head, body = blocks[i - 1], blocks[i]
            break

    status = 0
    headers = {}
    for line in [l.strip() for l in head.replace('\r', '').split('\n') if l.strip()]:
        if line.upper().startswith('HTTP/'):
            parts = line.split()
            if len(parts) > 1 and parts[1].isdigit():
                status = int(parts[1])
            continue
        if ':' in line:
            key, value = line.split(':', 1)
            # setdefault: keep the FIRST of a repeated header (Set-Cookie), so
            # presence checks are stable.
            headers.setdefault(key.strip().lower(), value.strip())

    parsed = None
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        pass
    if not isinstance(parsed, dict):
        parsed = {}
    return dict(status=status, headers=headers, body=body.strip(),
                app=parsed.get('app'), uri=parsed.get('uri'), error=None)


def http(target, case):
    """One request from inside the cluster."""
    # quiet: a failed probe is data, not an incident. Stage 4 deliberately
    # probes a controller that has just been uninstalled, and curl's "could not
    # resolve host" on stderr would read like an error in the run.
    proc = kubectl('exec', '-n', NS, 'probe', '--', *curl_argv(target, case),
                   check=False, quiet=True)
    result = parse_response(proc.stdout)
    if result['status'] == 0 and proc.stderr.strip():
        result['error'] = proc.stderr.strip().splitlines()[-1][:120]
    return result


WIDTH = max(len(c['name']) for c in CASES)


def applicable(args, case):
    return args.target not in (case.get('skip_targets') or ())


def absolute_problems(case, r):
    """Does this response match what the case says it should be, on its own
    terms? Used by the stages that have no other side to compare against."""
    problems = []
    if 'expect_status' in case and r['status'] != case['expect_status']:
        problems.append('status %s, expected %d' % (r['status'], case['expect_status']))
    if 'expect_app' in case and r['app'] != case['expect_app']:
        problems.append('served by %s, expected %s' % (r['app'], case['expect_app']))
    if 'expect_uri' in case and r['uri'] != case['expect_uri']:
        problems.append('backend saw %s, expected %s' % (r['uri'], case['expect_uri']))
    needed = case.get('header_present')
    if needed and needed not in r['headers']:
        problems.append('no %s header' % needed)
    return problems


def row(mark, name, problems, left=None, right=None, left_label='', right_label=''):
    if left is None:
        say('  %-5s %-*s' % (mark, WIDTH, name))
    elif right is None:
        say('  %-5s %-*s  %s=%s' % (mark, WIDTH, name, left_label, summarise(left)))
    else:
        say('  %-5s %-*s  %s=%s  %s=%s' % (mark, WIDTH, name, left_label, summarise(left),
                                           right_label, summarise(right)))
    for p in problems:
        say('        %s' % p)


def probe_absolute(args, target, label):
    """Run every applicable case against one controller and check it against the
    case's own expectations. Returns (results_by_name, failures)."""
    results = {}
    failures = []
    skipped = 0
    for case in CASES:
        if not applicable(args, case):
            skipped += 1
            row('skip', case['name'],
                ['not applicable to --target %s: %s'
                 % (args.target, case.get('skip_reason', 'no equivalent on this target'))])
            continue
        r = http(target, case)
        results[case['name']] = r
        problems = absolute_problems(case, r)
        row('ok  ' if not problems else 'FAIL', case['name'], problems, r, None, label)
        if problems:
            failures.append(case['name'])
    if skipped:
        say('  (%d case(s) not applicable to --target %s)' % (skipped, args.target))
    return results, failures


def probe_against(args, target, baseline, label):
    """Run every applicable case and compare to a previously recorded baseline.
    This is the equivalence assertion: not "NIC returns /things/42" but "NIC
    returns what ingress-nginx returned when it was serving this."""
    failures = []
    for case in CASES:
        if not applicable(args, case):
            continue
        before = baseline.get(case['name'])
        if before is None:
            continue
        after = http(target, case)
        fields = case.get('compare', ('status', 'app', 'uri'))
        problems = ['%s: %r -> %r' % (f, before.get(f), after.get(f))
                    for f in fields if before.get(f) != after.get(f)]
        needed = case.get('header_present')
        if needed and (needed in before['headers']) != (needed in after['headers']):
            problems.append('%s header %s' % (needed, 'lost' if needed in before['headers'] else 'appeared'))

        # A difference already investigated and written down is not a failure —
        # but a documented difference that has QUIETLY GONE AWAY is, because the
        # note explaining it is now wrong and someone will read it. Both
        # directions have to be checked or the declaration rots.
        #
        # Currently unused — no case declares one. Kept as the mechanism for
        # divergences that are real and understood, as opposed to cases that
        # simply do not apply to a target (skip_targets, above).
        known = (case.get('known_difference') or {}).get(args.target)
        if known and problems:
            mark, ok, problems = 'known', True, ['expected: %s' % known]
        elif known and not problems:
            mark, ok = 'STALE', False
            problems = ['declared as a known difference on --target %s, but they now agree. '
                        'Remove the known_difference entry.' % args.target]
        else:
            mark, ok = ('ok  ' if not problems else 'FAIL'), not problems

        row(mark, case['name'], problems, before, after, 'was', 'now')
        if not ok:
            failures.append(case['name'])
    return failures


def summarise(r):
    if r.get('error'):
        return '<%s>' % r['error'][:40]
    bits = [str(r['status'])]
    if r['app']:
        bits.append(r['app'])
    if r['uri']:
        bits.append(r['uri'])
    return '/'.join(bits)


# -------------------------------------------------------------------- main

def teardown(args):
    """Only ever removes a cluster this run is responsible for. Failing before
    the cluster exists must not try to delete one, and --skip-cluster means the
    cluster belongs to the caller."""
    if args.skip_cluster or not CREATED['cluster']:
        return
    if args.keep:
        say('\ncluster %s left running (--keep). Delete it with:\n  kind delete cluster --name %s'
            % (CLUSTER, CLUSTER))
        return
    phase('Teardown')
    try:
        run(['kind', 'delete', 'cluster', '--name', CLUSTER], check=False, timeout=300)
    except Fail as err:
        say('  could not delete the cluster: %s' % err)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--keep', action='store_true', help='leave the kind cluster running')
    ap.add_argument('--skip-cluster', action='store_true',
                    help='use the current kube context instead of creating a kind cluster')
    ap.add_argument('--target', default='virtualserver', choices=['virtualserver', 'ingress'])
    ap.add_argument('--community-chart', default='', help='pin the ingress-nginx chart version')
    ap.add_argument('--workdir', default=os.path.join(E2E, '.work'))
    ap.add_argument('--self-test', action='store_true',
                    help='check the runner\'s own logic; needs no cluster and no Docker')
    ap.add_argument('--until', default=STAGES[-1], choices=STAGES,
                    help='stop after this stage, for debugging (implies --keep)')
    args = ap.parse_args()

    if args.self_test:
        phase('Self-test')
        return self_test()
    if args.until != STAGES[-1]:
        args.keep = True

    started = time.time()
    stages_run = []
    versions = {}
    try:
        preflight(args)
        create_cluster(args)
        deploy_workload(args)

        # ---- Stage 1: ingress-nginx, alone, works -------------------------
        phase('Stage 1 — ingress-nginx serves the original')
        versions['ingress-nginx'] = install_community(args)
        apply_source(args)
        community_target = controller_service(COMMUNITY_NS, COMMUNITY_SELECTOR)
        wait_for('the community controller to serve the Ingress',
                 lambda: http(community_target, CASES[0])['status'] == 200, timeout=180)
        baseline, failures = probe_absolute(args, community_target, 'ingress-nginx')
        stages_run.append('baseline')
        if failures:
            raise Fail('the baseline itself does not work (%s). Nothing downstream is meaningful '
                       '— this is the fixture or ingress-nginx, not the migration.'
                       % ', '.join(failures))
        if args.until == 'baseline':
            return finish(args, started, stages_run, versions, [])

        # ---- Stage 2: NIC installs and answers ----------------------------
        phase('Stage 2 — NIC is installed and healthy')
        versions['NIC'] = install_nic(args)
        nic_target = controller_service(NIC_NS, NIC_SELECTOR)
        check_nic_ready(nic_target)
        stages_run.append('nic-installed')
        if args.until == 'nic-installed':
            return finish(args, started, stages_run, versions, [])

        # ---- Stage 3: converted, both serving side by side ----------------
        phase('Stage 3 — converted, both controllers serving')
        converted = convert(args)
        apply_converted(args, converted)
        wait_for('NIC to serve the converted resources',
                 lambda: http(nic_target, CASES[0])['status'] in (200, 301, 308), timeout=180)

        say('\n  ingress-nginx, still serving the original:')
        _, regressions = probe_absolute(args, community_target, 'ingress-nginx')
        if regressions:
            raise Fail('applying the converted resources disturbed the incumbent controller (%s). '
                       'A migration must not affect what is still live.' % ', '.join(regressions))

        say('\n  NIC, serving the converted resources (vs the stage 1 baseline):')
        failures = probe_against(args, nic_target, baseline, 'nic')
        stages_run.append('converted')
        if failures:
            return finish(args, started, stages_run, versions, failures)
        if args.until == 'converted':
            return finish(args, started, stages_run, versions, [])

        # ---- Stage 4: ingress-nginx gone, NIC alone -----------------------
        phase('Stage 4 — ingress-nginx removed, NIC alone')
        uninstall_community()
        # Prove the old side is really gone, or "NIC serves this" proves nothing.
        gone = http(community_target, CASES[0])
        if gone['status'] != 0:
            raise Fail('the community controller still answered with HTTP %s after uninstall, so '
                       'nothing below would prove NIC is serving.' % gone['status'])
        say('  ok    ingress-nginx no longer answers')
        say('\n  NIC alone (vs the stage 1 baseline):')
        failures = probe_against(args, nic_target, baseline, 'nic')
        stages_run.append('cutover')
    except Fail as err:
        say('\nFAILED: %s' % err)
        teardown(args)
        return 1
    except KeyboardInterrupt:
        say('\ninterrupted')
        teardown(args)
        return 1

    return finish(args, started, stages_run, versions, failures)


def check_nic_ready(nic_target):
    """NIC is up and answering, before any converted resource exists. Separating
    this from stage 3 is the point of the tiering: an install problem and a
    conversion problem look identical at the HTTP layer otherwise."""
    crds = kubectl('get', 'crd', '-o', 'name', check=False).stdout
    for kind in ('virtualservers.k8s.nginx.org', 'policies.k8s.nginx.org',
                 'transportservers.k8s.nginx.org'):
        if kind not in crds:
            raise Fail('CRD %s is not installed — NIC cannot serve VirtualServers' % kind)
    say('  ok    CRDs installed (VirtualServer, Policy, TransportServer)')

    # With no resource for this host yet, a healthy NIC answers 404 from its
    # default server. A connection error means the controller is not serving at
    # all, which is a different problem entirely.
    probe = wait_for('NIC to answer on its Service',
                     lambda: http(nic_target, CASES[0]) or None, timeout=120)
    if probe['status'] == 0:
        raise Fail('NIC did not answer on %s (%s)' % (nic_target, probe.get('error')))
    say('  ok    controller answers on its Service (HTTP %d, no resources yet)' % probe['status'])


def finish(args, started, stages_run, versions, failures):
    phase('Result')
    say('  target        %s' % args.target)
    for label, image in versions.items():
        say('  %-13s %s' % (label, image))
    say('  stages        %s' % ' -> '.join(stages_run))
    say('  elapsed       %ds' % (time.time() - started))
    if failures:
        say('\n  %d case(s) did not match the baseline: %s' % (len(failures), ', '.join(failures)))
        say('  A mismatch is a real behavioural difference — read the rows above.')
        teardown(args)
        return 1
    if 'cutover' in stages_run:
        say('\n  ingress-nginx removed; NIC alone serves every case exactly as ingress-nginx did.')
    else:
        say('\n  stopped after "%s" as requested; cluster left running.' % args.until)
    teardown(args)
    return 0


if __name__ == '__main__':
    sys.exit(main())
