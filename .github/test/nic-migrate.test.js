'use strict';
/* tools/nic-migrate — CLI behaviour that nothing else guards.
   =========================================================================
   The CLI reads the shipped analyzer rather than a copy of it, so the mapping
   database itself is already covered by test-analyzer.js and the wiring suite.
   What is only covered here is the layer the CLI adds: document splitting,
   the Ingress scanner, and the gap checks that tell a reader which parts of a
   real manifest the engine's single-context model did not carry over.

   These tests live under .github/test/ rather than beside the tool so CI picks
   them up from the existing `node --test .github/test/*.test.js` glob and
   GitHub Pages does not serve them. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ROOT } = require('./lib/load.js');
const TOOL = path.join(ROOT, 'tools', 'nic-migrate');

const { splitDocuments, isIngress, describe: describeIngress } = require(path.join(TOOL, 'lib', 'ingress.js'));
const { detect, sortGaps } = require(path.join(TOOL, 'lib', 'gaps.js'));
const { createEngine } = require(path.join(TOOL, 'lib', 'engine.js'));
const { splitKubectlList, loadChecklist } = require(path.join(TOOL, 'nic-migrate.js'));
const Y = require(path.join(TOOL, 'lib', 'yaml.js'));
const { toModel, convert } = require(path.join(TOOL, 'lib', 'convert.js'));

const engine = createEngine();
const analyze = (yaml) => {
    const result = engine.analyze(yaml, 'crd');
    const desc = describeIngress(yaml);
    return { desc, result, gaps: sortGaps(detect(desc, result)) };
};
const gapIds = (a) => a.gaps.map((g) => g.id);

const ing = (annotations, spec) => [
    'apiVersion: networking.k8s.io/v1',
    'kind: Ingress',
    'metadata:',
    '  name: app',
    '  namespace: prod',
    '  annotations:',
    ...annotations.map((a) => '    nginx.ingress.kubernetes.io/' + a),
    'spec:',
    ...spec
].join('\n');

const ONE_RULE = [
    '  rules:',
    '  - host: a.example.com',
    '    http:',
    '      paths:',
    '      - path: /',
    '        backend:',
    '          service:',
    '            name: a-svc',
    '            port:',
    '              number: 80'
];

test('splitDocuments separates a multi-document stream and ignores --- inside values', () => {
    const docs = splitDocuments('kind: Ingress\na: 1\n---\nkind: Service\nb: "---"\n');
    assert.equal(docs.length, 2);
    assert.equal(docs.filter(isIngress).length, 1);
});

test('splitKubectlList expands a List into one document per item', () => {
    /* Regression: the item check has to precede the "back to top level" test,
       because "- apiVersion:" starts at column 0 and is non-whitespace. With
       the tests in the other order the scan ended on the first item and the
       whole List was analyzed as a single Ingress. */
    const list = [
        'apiVersion: v1',
        'kind: List',
        'items:',
        '- apiVersion: networking.k8s.io/v1',
        '  kind: Ingress',
        '  metadata:',
        '    name: alpha',
        '    namespace: ns1',
        '- apiVersion: networking.k8s.io/v1',
        '  kind: Ingress',
        '  metadata:',
        '    name: beta',
        '    namespace: ns2',
        'metadata:',
        '  resourceVersion: ""'
    ].join('\n');
    const docs = splitKubectlList(list);
    assert.equal(docs.length, 2);
    assert.ok(docs.every(isIngress), 'every item should parse as an Ingress');
    assert.deepEqual(docs.map((d) => describeIngress(d).name), ['alpha', 'beta']);
    assert.deepEqual(docs.map((d) => describeIngress(d).namespace), ['ns1', 'ns2']);
});

test('describe extracts hosts, paths, services, TLS, namespace and class', () => {
    const d = describeIngress(ing(['proxy-body-size: 10m'], [
        '  ingressClassName: nginx',
        '  tls:',
        '  - hosts:',
        '    - a.example.com',
        '    secretName: a-tls',
        '  rules:',
        '  - host: a.example.com',
        '    http:',
        '      paths:',
        '      - path: /api',
        '        backend:',
        '          service:',
        '            name: api-svc',
        '            port:',
        '              number: 8080',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: web-svc',
        '            port:',
        '              number: 80',
        '  - host: b.example.com',
        '    http:',
        '      paths:',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: b-svc',
        '            port:',
        '              number: 80'
    ]));
    assert.deepEqual(d.hosts, ['a.example.com', 'b.example.com']);
    assert.equal(d.paths, 3);
    assert.deepEqual(d.services, ['api-svc', 'web-svc', 'b-svc']);
    assert.equal(d.hasTls, true);
    assert.deepEqual(d.tlsSecrets, ['a-tls']);
    assert.equal(d.namespace, 'prod');
    assert.equal(d.ingressClassName, 'nginx');
    assert.deepEqual(d.annotations, ['proxy-body-size']);
});

test('a block scalar body is not read as structure', () => {
    /* A snippet can contain anything, including lines that look like keys.
       Reading them would invent hosts and inflate the path count. */
    const d = describeIngress(ing([
        'configuration-snippet: |',
        '  host: not-a-real-host.example.com',
        '  path: /not-a-real-path'
    ], ONE_RULE));
    assert.deepEqual(d.hosts, ['a.example.com']);
    assert.equal(d.paths, 1);
});

test('tls hosts are not counted as rule hosts', () => {
    const d = describeIngress(ing(['proxy-body-size: 1m'], [
        '  tls:',
        '  - hosts:',
        '    - a.example.com',
        '    - alias.example.com',
        '    secretName: a-tls',
        ...ONE_RULE
    ]));
    assert.deepEqual(d.hosts, ['a.example.com'], 'tls[].hosts is a plural list, not a rule host');
});

test('two single-feature generators claiming one host are reported as a conflict', () => {
    /* rewrite-target and affinity each emit their own VirtualServer bound to
       the same host. Applied together NIC accepts one and rejects the other,
       so this has to surface as blocking rather than as two happy resources. */
    const a = analyze(ing(['rewrite-target: /$1', 'affinity: cookie'], ONE_RULE));
    const conflict = a.gaps.find((g) => g.id === 'host-conflict');
    assert.ok(conflict, 'expected a host-conflict gap, got: ' + gapIds(a).join(', '));
    assert.equal(conflict.severity, 'blocking');
    assert.match(conflict.message, /a\.example\.com/);
});

test('generated Policies that are never referenced are reported as unwired', () => {
    const a = analyze(ing(['enable-cors: "true"'], ONE_RULE));
    const unwired = a.gaps.find((g) => g.id === 'policy-unwired');
    assert.ok(unwired, 'expected policy-unwired, got: ' + gapIds(a).join(', '));
    assert.equal(unwired.severity, 'blocking');
});

test('hosts, paths and backends beyond the first are reported as dropped', () => {
    const a = analyze(ing(['rewrite-target: /$1'], [
        '  rules:',
        '  - host: a.example.com',
        '    http:',
        '      paths:',
        '      - path: /api',
        '        backend:',
        '          service:',
        '            name: api-svc',
        '            port:',
        '              number: 8080',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: web-svc',
        '            port:',
        '              number: 80',
        '  - host: b.example.com',
        '    http:',
        '      paths:',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: b-svc',
        '            port:',
        '              number: 80'
    ]));
    const ids = gapIds(a);
    for (const id of ['hosts-dropped', 'paths-dropped', 'backends-dropped']) {
        assert.ok(ids.includes(id), 'expected ' + id + ', got: ' + ids.join(', '));
    }
});

test('an annotation-only migration reports no blocking gaps', () => {
    /* The negative case matters as much as the positives: if every input came
       back blocking, the severity would carry no information. */
    const a = analyze(ing(['proxy-body-size: 10m', 'proxy-connect-timeout: "30"'], ONE_RULE));
    const blocking = a.gaps.filter((g) => g.severity === 'blocking');
    assert.deepEqual(blocking, [], 'unexpected blocking gaps: ' + JSON.stringify(blocking));
    assert.match(a.result.yaml, /nginx\.org\/client-max-body-size/);
});

test('an unmapped annotation is reported rather than silently dropped', () => {
    const a = analyze(ing(['not-a-real-annotation: "1"'], ONE_RULE));
    const note = a.gaps.find((g) => g.id === 'unrecognized');
    assert.ok(note, 'expected unrecognized, got: ' + gapIds(a).join(', '));
    assert.match(note.message, /not-a-real-annotation/);
});

test('the checklist is read from the published page, not duplicated here', () => {
    const items = loadChecklist();
    assert.ok(items.length >= 20, 'expected the full checklist, got ' + items.length + ' items');
    assert.ok(items.every((t) => t.length > 0 && !/[<>]/.test(t)), 'items should be plain text');
});

/* ------------------------------------------------------------------- YAML */

const roundTrip = (v) => Y.parse(Y.stringify({ k: v })).k;

test('scalars round-trip through the emitter and parser', () => {
    for (const v of ['a', '', 'a\n', 'a\n\n', 'a\nb\n', 'a\nb', '  indented\nlines\n',
        'has "quotes" and \\ back', "it's", 'x: y', 'a #b', '~ ^/api(/|$)(.*)',
        '0755', '1:30', '0x1f', '10m', '5r/s', '${binary_remote_addr}', 'true', 'null', '-3']) {
        assert.equal(roundTrip(v), v, 'round-trip failed for ' + JSON.stringify(v));
    }
});

test('a string that looks like a number survives as a string', () => {
    /* "0755" emitted unquoted is the integer 493 to a YAML 1.1 reader, and
       Kubernetes uses one. Port names, versions and modes all land here. */
    const out = Y.stringify({ mode: '0755', port: '80', time: '1:30' });
    assert.match(out, /mode: "0755"/);
    assert.match(out, /port: "80"/);
    assert.match(out, /time: "1:30"/);
    const back = Y.parse(out);
    assert.equal(back.mode, '0755');
    assert.equal(back.port, '80');
});

test('a nested sequence is not read as a key named "- x"', () => {
    // Regression: the key pattern matches "- k" out of "- - k: v".
    // One outer item, itself a sequence of two — cross-checked against PyYAML.
    const v = Y.parse('root:\n  - - k: 1\n    - - a\n');
    assert.deepEqual(v, { root: [[{ k: 1 }, ['a']]] });
});

test('a quoted sequence item containing a colon is a scalar, not a mapping', () => {
    // Regression: the key pattern backtracks into the quoted scalar.
    assert.deepEqual(Y.parse('root:\n  - "x: y"\n'), { root: ['x: y'] });
    assert.deepEqual(Y.parse('root:\n  "a: b": v\n'), { root: { 'a: b': 'v' } });
});

test('block scalar chomping is preserved in both directions', () => {
    const doc = Y.parse('a: |\n  one\nb: |-\n  two\nc: >-\n  three\n  four\n');
    assert.equal(doc.a, 'one\n');
    assert.equal(doc.b, 'two');
    assert.equal(doc.c, 'three four');
    assert.deepEqual(Y.parse(Y.stringify(doc)), doc);
});

test('flow collections and multi-document streams parse', () => {
    const docs = Y.parseAll('kind: A\nx: {a: 1, b: "c,d"}\ny: []\n---\nkind: B\nz: [1, 2]\n');
    assert.equal(docs.length, 2);
    assert.deepEqual(docs[0].x, { a: 1, b: 'c,d' });
    assert.deepEqual(docs[0].y, []);
    assert.deepEqual(docs[1].z, [1, 2]);
});

test('an anchor is refused rather than silently dropped', () => {
    assert.throws(() => Y.parse('a: &anchor 1\nb: *anchor\n'), /anchors and aliases/);
});

/* --------------------------------------------------------------- converter */

const INGRESS = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
        name: 'shop',
        namespace: 'prod',
        annotations: {
            'nginx.ingress.kubernetes.io/rewrite-target': '/$1',
            'nginx.ingress.kubernetes.io/affinity': 'cookie',
            'nginx.ingress.kubernetes.io/enable-cors': 'true'
        }
    },
    spec: {
        ingressClassName: 'nginx',
        tls: [{ hosts: ['a.example.com'], secretName: 'a-tls' }],
        rules: [
            {
                host: 'a.example.com',
                http: {
                    paths: [
                        { path: '/api(/|$)(.*)', pathType: 'Prefix', backend: { service: { name: 'api-svc', port: { number: 8080 } } } },
                        { path: '/', pathType: 'Prefix', backend: { service: { name: 'web-svc', port: { number: 80 } } } }
                    ]
                }
            },
            {
                host: 'b.example.com',
                http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'b-svc', port: { name: 'http' } } } }] }
            }
        ]
    }
};

const runConvert = (doc, opts) => {
    const model = toModel(doc);
    const result = engine.analyze(Y.stringify(doc), (opts && opts.strategy) || 'crd');
    return { model, out: convert(model, result, Object.assign({ target: 'virtualserver' }, opts)) };
};

test('every host becomes one VirtualServer carrying all of its routes', () => {
    /* This is the difference from the page's output, which emits one
       single-feature VirtualServer per annotation, all bound to the first
       host, and drops every other path. */
    const { out } = runConvert(INGRESS);
    const vs = out.docs.filter((d) => d.kind === 'VirtualServer');
    assert.equal(vs.length, 2);
    assert.deepEqual(vs.map((v) => v.spec.host).sort(), ['a.example.com', 'b.example.com']);

    const a = vs.find((v) => v.spec.host === 'a.example.com');
    assert.equal(a.spec.routes.length, 2, 'both paths must be present');
    assert.deepEqual(a.spec.upstreams.map((u) => u.service).sort(), ['api-svc', 'web-svc']);
    assert.equal(a.metadata.namespace, 'prod');
    assert.equal(a.spec.ingressClassName, 'nginx');
    assert.equal(a.spec.tls.secret, 'a-tls');

    const b = vs.find((v) => v.spec.host === 'b.example.com');
    assert.equal(b.spec.tls, undefined, 'only the host with a TLS entry gets a tls block');
    assert.equal(b.spec.upstreams[0].port, 'http', 'a named port stays a name');
});

test('generated Policies are wired into every VirtualServer and namespaced', () => {
    const { out } = runConvert(INGRESS);
    const policies = out.docs.filter((d) => d.kind === 'Policy');
    assert.ok(policies.length > 0, 'expected at least one Policy');
    assert.ok(policies.every((p) => p.metadata.namespace === 'prod'));
    for (const vs of out.docs.filter((d) => d.kind === 'VirtualServer')) {
        assert.deepEqual(vs.spec.policies.map((p) => p.name).sort(), policies.map((p) => p.metadata.name).sort());
    }
});

test('an Ingress-scoped upstream setting reaches every upstream', () => {
    const { out } = runConvert(INGRESS);
    const a = out.docs.find((d) => d.kind === 'VirtualServer' && d.spec.host === 'a.example.com');
    assert.ok(a.spec.upstreams.every((u) => u.sessionCookie && u.sessionCookie.enable === true),
        'affinity: cookie is Ingress-scoped, so every upstream gets it');
});

test('a $n rewrite is not copied onto a path with no capture group', () => {
    /* Copying "/$1" onto a plain "/" route rewrites every request to "/".
       Faithful to the community annotation, and never what anyone meant. */
    const { out } = runConvert(INGRESS);
    const a = out.docs.find((d) => d.kind === 'VirtualServer' && d.spec.host === 'a.example.com');
    const regexRoute = a.spec.routes.find((r) => r.path.startsWith('~'));
    const plainRoute = a.spec.routes.find((r) => !r.path.startsWith('~'));
    assert.equal(regexRoute.action.proxy.rewritePath, '/$1');
    assert.ok(!plainRoute.action.proxy || !plainRoute.action.proxy.rewritePath);
    assert.ok(out.notes.some((n) => /no capture group/.test(n)), 'the drop must be reported');
});

test('the ingress target keeps the Ingress and rewrites its annotations', () => {
    const { out } = runConvert(INGRESS, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.ok(ing, 'expected an Ingress');
    const keys = Object.keys(ing.metadata.annotations);
    assert.ok(keys.every((k) => !k.startsWith('nginx.ingress.kubernetes.io/')),
        'no community annotation may survive: ' + keys.join(', '));
    assert.ok(keys.some((k) => k.startsWith('nginx.org/')), 'expected nginx.org annotations');
    // Every rule and path survives untouched.
    assert.equal(ing.spec.rules.length, 2);
    assert.equal(ing.spec.rules[0].http.paths.length, 2);
    assert.deepEqual(ing.spec.tls, [{ hosts: ['a.example.com'], secretName: 'a-tls' }]);
});

test('a regex path adds nginx.org/path-regex on the ingress target', () => {
    /* Found by the e2e pipeline, not by reading: NIC matches Ingress paths
       literally, so without this annotation "/api(/|$)(.*)" matches nothing and
       every request falls through to the catch-all "/" — a 200 from the wrong
       backend. */
    const { out } = runConvert(INGRESS, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/path-regex'], 'case_sensitive');
    assert.ok(out.notes.some((n) => /path-regex/.test(n)), 'the annotation must be explained');
});

test('an Ingress with no regex path does not get path-regex', () => {
    const plain = JSON.parse(JSON.stringify(INGRESS));
    plain.spec.rules = [{
        host: 'a.example.com',
        http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'a-svc', port: { number: 80 } } } }] }
    }];
    const { out } = runConvert(plain, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/path-regex'], undefined);
});

test('snippet output warns that NIC rejects snippets by default', () => {
    /* NIC does not degrade here, it rejects the Ingress outright:
       "snippet specified but snippets feature is not enabled". */
    const { out } = runConvert(INGRESS, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    const hasSnippet = Object.keys(ing.metadata.annotations).some((k) => /-snippets$/.test(k));
    assert.ok(hasSnippet, 'the fixture should produce snippets under the annotation strategy');
    assert.ok(out.notes.some((n) => /enableSnippets/.test(n)), 'the rejection must be flagged');
});

test('session affinity loss is reported on the ingress target, without blaming Plus', () => {
    /* affinity maps to VirtualServer upstreams[].sessionCookie — section "oss",
       plusRequired false. It works on NGINX OSS; it simply has no annotation
       form. Saying otherwise sends readers to buy a subscription they do not
       need, so the wording is asserted, not just the presence of a note. */
    const { out } = runConvert(INGRESS, { target: 'ingress', strategy: 'annotation' });
    const note = out.notes.find((n) => /session affinity/i.test(n));
    assert.ok(note, 'expected a note about affinity');
    assert.match(note, /virtualserver/i);
    assert.ok(!/plus/i.test(note), 'affinity is not a Plus feature: ' + note);
});

test('the virtualserver target keeps session affinity that the ingress target loses', () => {
    const { out } = runConvert(INGRESS);
    const vs = out.docs.filter((d) => d.kind === 'VirtualServer');
    assert.ok(vs.every((v) => v.spec.upstreams.every((u) => u.sessionCookie)),
        'every upstream should carry sessionCookie');
});

test('--class overrides the source ingressClassName on every output', () => {
    const { out } = runConvert(INGRESS, { ingressClass: 'nginx-nic' });
    for (const vs of out.docs.filter((d) => d.kind === 'VirtualServer')) {
        assert.equal(vs.spec.ingressClassName, 'nginx-nic');
    }
});

test('converted output is emittable and re-parses to the same objects', () => {
    const { out } = runConvert(INGRESS);
    const text = Y.stringifyAll(out.docs);
    assert.deepEqual(Y.parseAll(text), out.docs);
});

/* --------------------------------------------------------------- e2e fixtures

   The e2e pipeline needs a cluster and cannot run here, but its fixtures can
   drift without one: renaming a Service in workload.yaml while source-ingress
   still points at the old name produces a 503 that looks like a migration bug
   and is not. These assertions cost nothing and fail on the actual cause. */

const fs = require('node:fs');
const E2E = path.join(ROOT, 'tools', 'nic-migrate', 'e2e', 'manifests');
const readE2E = (f) => fs.readFileSync(path.join(E2E, f), 'utf8');

test('every backend the e2e Ingress routes to exists in the e2e workload', () => {
    const workload = Y.parseAll(readE2E('workload.yaml'));
    const ingress = Y.parse(readE2E('source-ingress.yaml'));

    const services = new Map(workload.filter((d) => d.kind === 'Service')
        .map((s) => [s.metadata.name, s.spec.ports.map((p) => p.port)]));
    const namespaces = new Set(workload.filter((d) => d.metadata && d.metadata.namespace)
        .map((d) => d.metadata.namespace));

    assert.ok(namespaces.has(ingress.metadata.namespace),
        'the Ingress namespace must be one the workload creates');

    for (const rule of ingress.spec.rules) {
        for (const p of rule.http.paths) {
            const svc = p.backend.service;
            assert.ok(services.has(svc.name), 'no Service named ' + svc.name + ' in workload.yaml');
            assert.ok(services.get(svc.name).includes(svc.port.number),
                svc.name + ' does not listen on port ' + svc.port.number);
        }
    }
});

test('the e2e Ingress converts cleanly and covers every host and path', () => {
    const ingress = Y.parse(readE2E('source-ingress.yaml'));
    const model = toModel(ingress);
    const result = engine.analyze(Y.stringify(ingress), 'crd');
    assert.deepEqual(result.warnings, [], 'a generator failed on the e2e fixture');

    const out = convert(model, result, { target: 'virtualserver', ingressClass: 'nginx-nic' });
    const vs = out.docs.filter((d) => d.kind === 'VirtualServer');
    assert.equal(vs.length, ingress.spec.rules.length, 'one VirtualServer per host');

    const names = vs.map((v) => v.metadata.name);
    assert.equal(new Set(names).size, names.length, 'VirtualServer names must be unique: ' + names.join(', '));

    const totalPaths = ingress.spec.rules.reduce((n, r) => n + r.http.paths.length, 0);
    const totalRoutes = vs.reduce((n, v) => n + v.spec.routes.length, 0);
    assert.equal(totalRoutes, totalPaths, 'every path must become a route');

    // The TLS secret the pipeline creates must be the one the output references.
    const withTls = vs.find((v) => v.spec.tls);
    assert.equal(withTls.spec.tls.secret, ingress.spec.tls[0].secretName);
    // ssl-redirect is "false" in the fixture, so the converter must NOT add one:
    // the pipeline asserts plain HTTP is served, and a redirect would break it.
    assert.equal(withTls.spec.tls.redirect, undefined);
});

test('the e2e workload and runner agree on names', () => {
    const runner = fs.readFileSync(path.join(ROOT, 'tools', 'nic-migrate', 'e2e', 'run-e2e.py'), 'utf8');
    const workload = Y.parseAll(readE2E('workload.yaml'));
    const ns = (runner.match(/^NS = '([^']+)'/m) || [])[1];
    assert.ok(ns, 'could not read NS from run-e2e.py');
    assert.ok(workload.some((d) => d.kind === 'Namespace' && d.metadata.name === ns),
        'run-e2e.py uses namespace ' + ns + ', which workload.yaml does not create');
    assert.ok(workload.some((d) => d.kind === 'Pod' && d.metadata.name === 'probe'),
        'the runner execs into a pod named probe');
    // The deployments the runner waits on must be the ones that exist.
    for (const dep of ['api', 'web', 'web2']) {
        assert.ok(workload.some((d) => d.kind === 'Deployment' && d.metadata.name === dep),
            'run-e2e.py waits for deploy/' + dep);
    }
});
