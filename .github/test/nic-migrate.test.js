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

const { readIngresses, describe: describeDoc } = require(path.join(TOOL, 'lib', 'ingress.js'));
const { detect, sortGaps } = require(path.join(TOOL, 'lib', 'gaps.js'));
const { createEngine } = require(path.join(TOOL, 'lib', 'engine.js'));
const { loadChecklist } = require(path.join(TOOL, 'nic-migrate.js'));
const Y = require(path.join(TOOL, 'lib', 'yaml.js'));
// describe() reads a parsed Ingress; the tests write theirs as text.
const describeIngress = (text, prefixes) => describeDoc(Y.parse(text), prefixes);
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

test('a multi-document stream yields its Ingresses, and --- inside a value is not a separator', () => {
    const read = readIngresses('kind: Ingress\nmetadata: {name: a}\n---\nkind: Service\nb: "---"\n');
    assert.equal(read.ingresses.length, 1);
    assert.deepEqual(read.skipped, { Service: 1 });
});

test('a kubectl List expands into one Ingress per item, from a file as from --kubectl', () => {
    /* A14: report -f rejected a saved List — only --kubectl ran the string
       surgery that split it. Every input now goes through the parser, where a
       List is a document with items. */
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
    const { ingresses } = readIngresses(list);
    assert.deepEqual(ingresses.map((d) => describeDoc(d).name), ['alpha', 'beta']);
    assert.deepEqual(ingresses.map((d) => describeDoc(d).namespace), ['ns1', 'ns2']);
    // An IngressList, and the same List as kubectl -o json, read the same.
    assert.equal(readIngresses(list.replace('kind: List', 'kind: IngressList')).ingresses.length, 2);
    assert.equal(readIngresses(JSON.stringify(Y.parse(list))).ingresses.length, 2);
});

test('a document that does not parse is reported without hiding the others', () => {
    const read = readIngresses('kind: Ingress\nmetadata: {name: ok}\n---\nkind: Ingress\nmetadata:\n\tname: tabbed\n');
    assert.equal(read.ingresses.length, 1);
    assert.match(read.errors[0], /tab/);
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

test('features that once got a VirtualServer each now share one per host', () => {
    /* rewrite-target and affinity used to emit a VirtualServer each, both bound
       to the host; NIC accepted one and rejected the other ("host is taken"). */
    const a = analyze(ing(['rewrite-target: /$1', 'affinity: cookie'], ONE_RULE.map((l) => l.replace('path: /', 'path: /(.*)'))));
    const vs = a.result.parts.filter((p) => /kind: VirtualServer/.test(p));
    assert.equal(vs.length, 1, a.result.yaml);
    assert.match(vs[0], /rewritePath/);
    assert.match(vs[0], /sessionCookie/);
    assert.ok(!gapIds(a).includes('host-conflict'), gapIds(a).join(', '));
});

test('a generated Policy is referenced by the VirtualServer', () => {
    const a = analyze(ing(['enable-cors: "true"'], ONE_RULE));
    assert.ok(!gapIds(a).includes('policy-unwired'), gapIds(a).join(', '));
    assert.match(a.result.yaml, /policies:[^\n]*\n\s+- name: app-cors/);
});

test('the gap detectors still catch a broken result', () => {
    /* The assembler makes these gaps impossible, so the detectors are tested
       against a hand-broken result: two VirtualServers on one host, a Policy
       nobody references, a host and a backend missing, TLS dropped. */
    const desc = describeIngress(ing(['enable-cors: "true"'], [
        '  tls:', '  - hosts: [a.example.com]', '    secretName: a-tls',
        ...ONE_RULE, '  - host: b.example.com', '    http:', '      paths:', '      - path: /',
        '        backend:', '          service:', '            name: b-svc', '            port:', '              number: 80']));
    const vs = (name) => 'apiVersion: k8s.nginx.org/v1\nkind: VirtualServer\nmetadata:\n  name: ' + name +
        '\nspec:\n  host: a.example.com\n  upstreams:\n    - name: a\n      service: a-svc\n      port: 80';
    const parts = [vs('one'), vs('two'), 'apiVersion: k8s.nginx.org/v1\nkind: Policy\nmetadata:\n  name: lonely\nspec:\n  cors: {}'];
    const ids = gapIds({ gaps: detect(desc, { parts, yaml: parts.join('\n---\n'), plan: {} }) });
    for (const id of ['host-conflict', 'policy-unwired', 'hosts-dropped', 'backends-dropped', 'tls-dropped']) {
        assert.ok(ids.includes(id), 'expected ' + id + ', got: ' + ids.join(', '));
    }
});

test('every host, path and backend of the community Ingress is in the output', () => {
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
        assert.ok(!ids.includes(id), id + ' reported: ' + ids.join(', '));
    }
    for (const want of ['host: a.example.com', 'host: b.example.com', 'service: api-svc', 'service: web-svc', 'service: b-svc']) {
        assert.ok(a.result.yaml.includes(want), want + ' missing:\n' + a.result.yaml);
    }
});

test('a single-backend migration reports no blocking gaps', () => {
    /* The negative case matters as much as the positives: if every input came
       back blocking, the severity would carry no information. Under CRD-first
       these two land on one VirtualServer upstream. */
    const a = analyze(ing(['proxy-body-size: 10m', 'proxy-connect-timeout: "30"'], ONE_RULE));
    const blocking = a.gaps.filter((g) => g.severity === 'blocking');
    assert.deepEqual(blocking, [], 'unexpected blocking gaps: ' + JSON.stringify(blocking));
    assert.match(a.result.yaml, /client-max-body-size: "10m"/);
});

test('upstream settings become one VirtualServer under CRD-first, in the CLI too', () => {
    /* Thirteen settings used to come out only as annotations, which the
       virtualserver target cannot carry, so it dropped them. They are now
       fields of one upstream, converted as the annotation form converts them. */
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = {
        'nginx.ingress.kubernetes.io/proxy-read-timeout': '120',
        'nginx.ingress.kubernetes.io/proxy-body-size': '8m',
        'nginx.ingress.kubernetes.io/proxy-buffering': 'on',
        'nginx.ingress.kubernetes.io/load-balance': 'ewma',
        'nginx.ingress.kubernetes.io/connection-proxy-header': 'close'
    };
    const page = engine.analyze(Y.stringify(doc), 'crd');
    const vsParts = page.parts.filter((p) => /kind: VirtualServer/.test(p));
    assert.equal(vsParts.length, doc.spec.rules.length, 'one VirtualServer per host, not one per setting: ' + page.yaml);
    assert.ok(!/^\s*nginx\.org\/[\w-]+:/m.test(page.yaml), 'no annotation swaps left: ' + page.yaml);

    const { out } = runConvert(doc);
    const ups = out.docs.filter((d) => d.kind === 'VirtualServer').flatMap((v) => v.spec.upstreams);
    assert.ok(ups.length > 0);
    for (const u of ups) {
        assert.equal(u['read-timeout'], '120s');
        assert.equal(u['client-max-body-size'], '8m');
        assert.equal(u.buffering, true);
        assert.equal(u['lb-method'], 'least_time last_byte');   // ewma: latency-based, OSS since NIC 5.7.0
        assert.equal(u.keepalive, 0);
    }
});

test('annotation values NIC would reject are converted, not passed through', () => {
    /* Each of these was emitted verbatim before, and NIC (v5.6.3, v5.7.0) rejects the
       whole Ingress for it: proxy-buffering takes a bool, sizes take no b
       suffix, and chash is not an lb-method. */
    const a = engine.analyze(ing(['proxy-buffering: "off"', 'proxy-body-size: 1048576b', 'load-balance: chash'], ONE_RULE), 'annotation');
    assert.match(a.yaml, /nginx\.org\/proxy-buffering: "false"/);
    assert.match(a.yaml, /nginx\.org\/client-max-body-size: "1048576"/);
    assert.ok(!/lb-method/.test(a.yaml), a.yaml);
    assert.ok(a.plan.infoNotes.some((n) => /chash/.test(n.code)), 'chash is reported');
});

test('an unmapped annotation is reported rather than silently dropped', () => {
    const a = analyze(ing(['not-a-real-annotation: "1"'], ONE_RULE));
    const note = a.gaps.find((g) => g.id === 'unrecognized');
    assert.ok(note, 'expected unrecognized, got: ' + gapIds(a).join(', '));
    assert.match(note.message, /not-a-real-annotation/);
});

test('the report prints a ConfigMap change once, under ConfigMap changes', () => {
    /* The ConfigMap step is a comparison block too, and "Annotation swaps"
       read every comparison: the ConfigMap printed twice, and under crd it was
       the only thing listed as an annotation swap. */
    const { renderReport } = require(path.join(TOOL, 'lib', 'render.js'));
    const yaml = ing(['proxy-body-size: "8m"', 'enable-access-log: "false"'], ONE_RULE);
    for (const strategy of ['annotation', 'crd']) {
        const result = engine.analyze(yaml, strategy);
        const item = { desc: describeIngress(yaml), result, gaps: sortGaps(detect(describeIngress(yaml), result)) };
        const out = renderReport([item], { strategy, colour: false });
        assert.equal((out.match(/^\s*kind: ConfigMap$/gm) || []).length, 1, strategy + ':\n' + out);
        assert.equal(/Annotation swaps/.test(out), strategy === 'annotation', strategy + ':\n' + out);
    }
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
    const o = Object.assign({ target: 'virtualserver' }, opts);
    return { model, out: convert(model, engine, o) };
};

test('every host becomes one VirtualServer carrying all of its routes', () => {
    /* The page and the CLI share this assembly now; it replaced one
       single-feature VirtualServer per annotation, all on the first host. */
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

test('rewrite-target makes every path a case-insensitive regex, longest first', () => {
    /* The community controller matched every path on the host as `~* "^path"`
       once rewrite-target was set, tried the longest first, and rewrote with
       "(?i)path". `~ (?i)^path` reproduces both under NIC (nginx 1.29:
       /api/things/42 -> /things/42, /API/x -> /x). "/" rewritten to "/" (the
       uncaptured $1 is empty) is a no-op and is dropped, not reported. */
    const { out } = runConvert(INGRESS);
    const a = out.docs.find((d) => d.kind === 'VirtualServer' && d.spec.host === 'a.example.com');
    assert.deepEqual(a.spec.routes.map((r) => r.path), ['~ (?i)^/api(/|$)(.*)', '~ (?i)^/']);
    assert.equal(a.spec.routes[0].action.proxy.rewritePath, '/$1');
    assert.equal(a.spec.routes[1].action.pass, 'web-svc');
    assert.ok(!out.notes.some((n) => /no capture group/.test(n)), out.notes.join(' | '));
});

test('a $n rewrite on a path without the group keeps the literal remainder, and says so', () => {
    /* B2: "/$2" on a path with no second group sent EVERY request to "/"
       (verified on nginx 1.29). The route keeps what the community controller
       did, and the note says it is probably not what was meant. */
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = { 'nginx.ingress.kubernetes.io/rewrite-target': '/app/$2' };
    doc.spec.rules = [doc.spec.rules[0]];
    const { out } = runConvert(doc);
    const routes = out.docs.find((d) => d.kind === 'VirtualServer').spec.routes;
    assert.equal(routes.find((r) => r.path === '~ (?i)^/').action.proxy.rewritePath, '/app/');
    assert.ok(out.notes.some((n) => /no capture group/.test(n)), out.notes.join(' | '));
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

test('rewrite-target adds a case-insensitive nginx.org/path-regex on the ingress target', () => {
    /* NIC matches Ingress paths literally unless told otherwise (the e2e
       pipeline found "/api(/|$)(.*)" falling through to "/"). B6: the community
       regex was ~* (case-insensitive), so the annotation says case_insensitive. */
    const { out } = runConvert(INGRESS, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/path-regex'], 'case_insensitive');
    assert.equal(ing.metadata.annotations['nginx.org/rewrite-target'], '/$1');
    assert.ok(out.notes.some((n) => /path-regex/.test(n)), 'the annotation must be explained');
});

test('an Ingress with neither use-regex nor rewrite-target gets no path-regex', () => {
    /* Without either annotation the community controller matched paths
       literally too — even "/api(/|$)(.*)" was a plain prefix. */
    const plain = JSON.parse(JSON.stringify(INGRESS));
    plain.metadata.annotations = { 'nginx.ingress.kubernetes.io/proxy-body-size': '8m' };
    const { out } = runConvert(plain, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/path-regex'], undefined);
});

test('snippet output warns that NIC rejects snippets by default', () => {
    /* NIC does not degrade here, it rejects the resource outright:
       "snippet specified but snippets feature is not enabled". CORS is a Policy
       now, so the fixture uses a configuration-snippet. */
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = { 'nginx.ingress.kubernetes.io/configuration-snippet': 'add_header X-A b;' };
    const { out } = runConvert(doc, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/location-snippets'], 'add_header X-A b;\n');
    assert.ok(out.notes.some((n) => /enableSnippets/.test(n)), 'the rejection must be flagged');
});

test('session affinity reaches the ingress target as nginx.org/sticky-cookie-services', () => {
    /* NIC 5.6 reads nginx.org/sticky-cookie-services on NGINX Open Source (since NGINX
       1.29.6); this was reported as lost. The cookie name and expiry carry
       over; the community default name is INGRESSCOOKIE. */
    const { out } = runConvert(INGRESS, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    const sticky = ing.metadata.annotations['nginx.org/sticky-cookie-services'];
    assert.ok(sticky, 'expected nginx.org/sticky-cookie-services');
    for (const svc of ['api-svc', 'web-svc', 'b-svc']) assert.match(sticky, new RegExp('serviceName=' + svc + ' INGRESSCOOKIE'));
    assert.ok(!out.notes.some((n) => /session affinity/i.test(n) && /lost|not represented/i.test(n)), out.notes.join(' | '));
});

test('an annotation the analyzer cannot translate is reported, not silently dropped', () => {
    /* NIC rejects a whole Ingress whose nginx.org/upstream-vhost is not a bare
       lowercase hostname, so the analyzer emits no swap for "$host:8080" and
       says why in an info note. The convert path read swaps and generated
       resources but never the notes, so on the ingress target the setting just
       vanished. */
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = { 'nginx.ingress.kubernetes.io/upstream-vhost': '$host:8080' };
    const { out } = runConvert(doc, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.equal((ing.metadata.annotations || {})['nginx.org/upstream-vhost'], undefined);
    assert.ok(out.notes.some((n) => /upstream-vhost/.test(n) && /hostname/.test(n)),
        'the refusal must be reported: ' + out.notes.join(' | '));
});

test('custom-http-errors without a default backend is flagged on the ingress target', () => {
    /* NIC sends intercepted errors only to the Ingress's own spec.defaultBackend
       and treats the annotation as a no-op without one; the community
       controller fell back to its global default backend. */
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = { 'nginx.ingress.kubernetes.io/custom-http-errors': '404,503' };
    delete doc.spec.defaultBackend;
    const { out } = runConvert(doc, { target: 'ingress', strategy: 'annotation' });
    const ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/custom-http-errors'], '404,503');
    assert.ok(out.notes.some((n) => /spec\.defaultBackend/.test(n)),
        'a missing default backend must be flagged: ' + out.notes.join(' | '));

    doc.spec.defaultBackend = { service: { name: 'error-svc', port: { number: 80 } } };
    const withBackend = runConvert(doc, { target: 'ingress', strategy: 'annotation' }).out;
    assert.ok(!withBackend.notes.some((n) => /no spec\.defaultBackend/.test(n)),
        'no warning once the Ingress has one: ' + withBackend.notes.join(' | '));
});

const ERRORS = (extra) => {
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = Object.assign({
        'nginx.ingress.kubernetes.io/custom-http-errors': '404,503',
        'nginx.ingress.kubernetes.io/default-backend': 'error-svc'
    }, extra);
    delete doc.spec.defaultBackend;
    return doc;
};

test('custom-http-errors under CRD-first keeps the Ingress, which alone serves the pages', () => {
    /* CRD by default, an Ingress where a setting has no CRD form: the
       annotation serves error pages from a Service, which VirtualServer
       errorPages cannot (they redirect or return a canned body). So CRD-first
       keeps this Ingress an Ingress, as annotation-first builds it, and says
       why. The virtualserver target asks for a VirtualServer regardless. */
    const result = engine.analyze(Y.stringify(ERRORS()), 'crd');
    assert.match(result.yaml, /nginx\.org\/custom-http-errors/);
    assert.ok(!/errorPages:/.test(result.yaml) && !/kind: VirtualServer/.test(result.yaml), result.yaml);
    // On the kept Ingress's card, as a warning.
    const cards = result.plan.steps.flatMap((st) => st.blocks.flatMap((b) => (b.items || [b]).flatMap((it) => it.notes || [])));
    assert.ok(cards.some((n) => /Kept as an Ingress under CRD-first/.test(n.message) && n.severity === 'warning'),
        'the reason must be a warning');
});

test('the virtualserver target gets errorPages, and is told what it loses', () => {
    const { out } = runConvert(ERRORS());
    const routes = out.docs.filter((d) => d.kind === 'VirtualServer').flatMap((v) => v.spec.routes);
    assert.ok(routes.length && routes.every((r) => r.errorPages && r.errorPages[0].codes.join() === '404,503'),
        'every route carries errorPages: ' + JSON.stringify(routes));
    // NIC allows only ${upstream_status} in an error-page body, and no code keeps the original status.
    assert.ok(routes.every((r) => r.errorPages[0].return && r.errorPages[0].return.code === undefined && !/\$\{(?!upstream_status\})/.test(r.errorPages[0].return.body)));
    assert.ok(out.notes.some((n) => /error-svc/.test(n) && /annotation-first/.test(n)), out.notes.join(' | '));
});

test('the ingress target turns default-backend into spec.defaultBackend', () => {
    /* NIC sends custom-http-errors only to spec.defaultBackend; the community
       annotation names just a Service, and the controller used its first port. */
    let { out } = runConvert(ERRORS(), { target: 'ingress', strategy: 'annotation' });
    let ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.spec.defaultBackend.service.name, 'error-svc');
    assert.ok(out.notes.some((n) => /unresolved placeholder at spec\.defaultBackend/.test(n)), out.notes.join(' | '));

    const asked = [];
    const resolveServicePort = (ns, name) => { asked.push(ns + '/' + name); return 8080; };
    ({ out } = runConvert(ERRORS(), { target: 'ingress', strategy: 'annotation', resolveServicePort }));
    ing = out.docs.find((d) => d.kind === 'Ingress');
    assert.deepEqual(ing.spec.defaultBackend, { service: { name: 'error-svc', port: { number: 8080 } } });
    assert.deepEqual(asked, ['prod/error-svc']);

    // A value that is not a Service name never reaches the resolver (kubectl
    // argv): the community controller refuses that Ingress, so nothing does.
    asked.length = 0;
    ({ out } = runConvert(ERRORS({ 'nginx.ingress.kubernetes.io/default-backend': '--kubeconfig=/tmp/x' }),
        { target: 'ingress', strategy: 'annotation', resolveServicePort }));
    assert.deepEqual(asked, []);
    assert.deepEqual(out.docs, []);

    // Without custom-http-errors, default-backend is the no-endpoints fallback,
    // which spec.defaultBackend is not.
    const alone = ERRORS();
    delete alone.metadata.annotations['nginx.ingress.kubernetes.io/custom-http-errors'];
    ({ out } = runConvert(alone, { target: 'ingress', strategy: 'annotation', resolveServicePort }));
    assert.equal(out.docs.find((d) => d.kind === 'Ingress').spec.defaultBackend, undefined);
});

test('the virtualserver target keeps session affinity as sessionCookie', () => {
    const { out } = runConvert(INGRESS);
    const vs = out.docs.filter((d) => d.kind === 'VirtualServer');
    assert.ok(vs.every((v) => v.spec.upstreams.every((u) => u.sessionCookie)),
        'every upstream should carry sessionCookie');
});

test('convert folds a canary Ingress into its stable one, as the page does', () => {
    /* B3/A7 on the CLI: convert ran one Ingress at a time, so a canary and its
       stable Ingress became two VirtualServers claiming one host. */
    const { convertAll } = require(path.join(TOOL, 'lib', 'convert.js'));
    const stable = JSON.parse(JSON.stringify(INGRESS));
    stable.metadata.annotations = {};
    stable.spec.rules = [stable.spec.rules[1]];
    const canary = JSON.parse(JSON.stringify(stable));
    canary.metadata.name = 'shop-canary';
    canary.metadata.annotations = { 'nginx.ingress.kubernetes.io/canary': 'true', 'nginx.ingress.kubernetes.io/canary-weight': '10' };
    canary.spec.rules[0].http.paths[0].backend.service.name = 'b-canary';
    const out = convertAll([toModel(stable), toModel(canary)], engine, { target: 'virtualserver' });
    assert.equal(out[1].mergedInto, 0);
    const vs = out[0].docs.filter((d) => d.kind === 'VirtualServer');
    assert.equal(vs.length, 1);
    assert.deepEqual(vs[0].spec.routes[0].splits.map((x) => x.weight), [90, 10]);
});

test('convert emits the ConfigMap keys a run needs, as one merge document', () => {
    const { convertAll, configMapDoc } = require(path.join(TOOL, 'lib', 'convert.js'));
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = { 'nginx.ingress.kubernetes.io/limit-connections': '5', 'nginx.ingress.kubernetes.io/enable-access-log': 'false' };
    const cm = configMapDoc(convertAll([toModel(doc)], engine, { target: 'virtualserver' }));
    assert.equal(cm.doc.data['access-log-off'], 'true');
    assert.match(cm.doc.data['http-snippets'], /^limit_conn_zone \$binary_remote_addr zone=prod_shop_conn:5m;$/m);
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

test('every backend the e2e community Ingresses route to exists in the e2e workload', () => {
    const workload = Y.parseAll(readE2E('workload.yaml'));
    const services = new Map(workload.filter((d) => d.kind === 'Service')
        .map((s) => [s.metadata.name, s.spec.ports.map((p) => p.port)]));
    const namespaces = new Set(workload.filter((d) => d.metadata && d.metadata.namespace)
        .map((d) => d.metadata.namespace));
    for (const ingress of Y.parseAll(readE2E('source-ingress.yaml'))) {
        assert.ok(namespaces.has(ingress.metadata.namespace), ingress.metadata.name + ': the Ingress namespace must be one the workload creates');
        for (const rule of ingress.spec.rules) {
            for (const p of rule.http.paths) {
                const svc = p.backend.service;
                assert.ok(services.has(svc.name), 'no Service named ' + svc.name + ' in workload.yaml');
                assert.ok(services.get(svc.name).includes(svc.port.number), svc.name + ' does not listen on port ' + svc.port.number);
            }
        }
    }
});

test('the e2e community Ingresses convert to one VirtualServer or Ingress per host with every path routed', () => {
    /* The fixture holds shop (two hosts, so it is split), admin (/admin on
       shop's host, so the host is merged) and docs (a plain Prefix /api on a
       host of its own, so it is split into /api/ and = /api). convert runs
       them together, as the runner does. */
    const { convertAll } = require(path.join(TOOL, 'lib', 'convert.js'));
    const ingresses = Y.parseAll(readE2E('source-ingress.yaml'));
    assert.deepEqual(ingresses.map((i) => i.metadata.name), ['shop', 'admin', 'docs']);
    for (const target of ['virtualserver', 'ingress']) {
        const out = convertAll(ingresses.map(toModel), engine, { target, ingressClass: 'nginx-nic' });
        assert.deepEqual(out.flatMap((o) => o.warnings), [], target + ': a generator failed on the e2e fixture');
        const docs = out.flatMap((o) => o.docs);
        const routing = docs.filter((d) => d.kind === (target === 'virtualserver' ? 'VirtualServer' : 'Ingress'));
        const hosts = routing.map((d) => (d.spec.host ? [d.spec.host] : d.spec.rules.map((r) => r.host)));
        assert.ok(hosts.every((h) => h.length === 1), target + ': one host per resource');
        assert.deepEqual(hosts.map((h) => h[0]).sort(), ['b.example.com', 'c.example.com', 'shop.example.com'], target + ': one resource per host');
        // Every source path is routed. shop's rewrite-target puts its hosts in
        // regex mode, where no Prefix path is split; docs's /api is split in
        // two, and "/" never is: one route per source path, plus one.
        const sourcePaths = ingresses.reduce((n, i) => n + i.spec.rules.reduce((m, r) => m + r.http.paths.length, 0), 0);
        const routed = routing.reduce((n, d) => n + (d.spec.routes ? d.spec.routes.length : d.spec.rules[0].http.paths.length), 0);
        assert.equal(routed, sourcePaths + 1, target + ': every path is routed');
        const docsHost = routing.find((d) => (d.spec.host || d.spec.rules[0].host) === 'c.example.com');
        const docsPaths = docsHost.spec.routes ? docsHost.spec.routes.map((x) => x.path) : docsHost.spec.rules[0].http.paths.map((x) => x.pathType[0] + ':' + x.path);
        assert.deepEqual(docsPaths, target === 'virtualserver' ? ['/api/', '=/api', '/'] : ['P:/api/', 'E:/api', 'P:/'], target + ': docs\'s Prefix /api split as the community controller split it');
        // The TLS secret the pipeline creates is the one referenced, and with
        // ssl-redirect "false" on both, no redirect: the runner asserts plain HTTP.
        const shop = routing.find((d) => (d.spec.host || d.spec.rules[0].host) === 'shop.example.com');
        if (target === 'virtualserver') {
            assert.equal(shop.spec.tls.secret, 'shop-tls');
            assert.equal(shop.spec.tls.redirect, undefined);
        } else assert.equal(shop.spec.tls[0].secretName, 'shop-tls');
    }
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

/* ── Multi-source support ──────────────────────────────────────────────────
   The CLI grew a --source flag so it can batch any migration tool the site
   ships, not just ingress-nginx. Three things have to hold for a new source:
   its module boots, the scanner counts ITS annotation prefixes, and the input
   gate accepts the kinds that source keeps config on. HAProxy is the first
   source where that last one matters — its settings live on Service objects,
   a controller ConfigMap and five CRs as well as on the Ingress, so an
   Ingress-only gate reports "nothing found" on a real deployment. */

const { SOURCES, DEFAULT_SOURCE, resolveSource } = require(path.join(TOOL, 'lib', 'sources.js'));

test('sources: every entry names a module that exists and boots an analyzer', () => {
    for (const id of Object.keys(SOURCES)) {
        const src = resolveSource(id);
        assert.ok(fs.existsSync(path.join(ROOT, src.module)), id + ': ' + src.module + ' missing');
        const e = createEngine(id);
        assert.ok(e.source && e.source.analyzer, id + ': no analyzer');
        assert.equal(e.sourceInfo.id, id);
        assert.ok(src.prefixes.length > 0 && src.kinds.length > 0, id + ': empty prefixes/kinds');
        assert.ok(src.kinds.indexOf('Ingress') !== -1, id + ': Ingress must be analyzable');
    }
});

test('sources: an unknown source is refused by name, not defaulted', () => {
    assert.throws(() => resolveSource('nope'), /unknown source "nope"/);
    // Absent means default, which is what the pre-flag callers and tests rely on.
    assert.equal(resolveSource(undefined).id, DEFAULT_SOURCE);
    assert.equal(resolveSource(null).id, DEFAULT_SOURCE);
});

test('haproxy: the scanner reads Service annotations, which ingress-nginx has no tier for', () => {
    const svc = [
        'apiVersion: v1', 'kind: Service', 'metadata:', '  name: app-svc', '  namespace: default',
        '  annotations:',
        '    haproxy.org/check: "true"',
        '    ingress.kubernetes.io/cookie-persistence: JSESSIONID',
        'spec:', '  ports:', '    - port: 80',
    ].join('\n');
    const hap = resolveSource('haproxy');
    const desc = describeIngress(svc, hap.prefixes);
    assert.equal(desc.kind, 'Service');
    assert.deepEqual(desc.annotations.sort(), ['check', 'cookie-persistence']);
    // The gate: read for haproxy, skipped for ingress-nginx.
    assert.equal(readIngresses(svc, hap.kinds).ingresses.length, 1);
    assert.deepEqual(readIngresses(svc, resolveSource('ingress-nginx').kinds).skipped, { Service: 1 });
});

test('haproxy: the analyzer produces a plan for an annotated Ingress', () => {
    const hapEngine = createEngine('haproxy');
    const ing = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: web-app',
        '  annotations:',
        '    haproxy.org/load-balance: leastconn',
        '    haproxy.org/ssl-redirect: "true"',
        'spec:', '  rules:', '    - host: app.example.com', '      http:', '        paths:',
        '          - path: /', '            pathType: Prefix', '            backend:',
        '              service:', '                name: app-svc', '                port:',
        '                  number: 80',
    ].join('\n');
    const r = hapEngine.analyze(ing, 'crd');
    assert.equal(r.error, null);
    assert.deepEqual(r.warnings, [], 'a generator failed and dropped its resource');
    assert.match(r.yaml, /lb-method: "?least_conn/);
});

test('haproxy: an unmapped annotation is named as a gap, and snippets warn about HAProxy directives', () => {
    /* The gap read unknown keys with ingress-nginx's prefix only, so under
       --source haproxy the report counted "1 unrecognized" and named none; the
       snippet gap blamed ingress-nginx's modules. */
    const hap = resolveSource('haproxy');
    const hapEngine = createEngine('haproxy');
    const ing = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: web-app',
        '  annotations:',
        '    haproxy.org/not-a-real-annotation: "1"',
        '    haproxy.org/backend-config-snippet: "http-send-name-header x-dst"',
        'spec:', '  rules:', '    - host: app.example.com', '      http:', '        paths:',
        '          - path: /', '            pathType: Prefix', '            backend:',
        '              service:', '                name: app-svc', '                port:',
        '                  number: 80',
    ].join('\n');
    const result = hapEngine.analyze(ing, 'crd');
    const gaps = detect(describeIngress(ing, hap.prefixes), result, hap);
    const note = gaps.find((g) => g.id === 'unrecognized');
    assert.ok(note, 'expected unrecognized, got: ' + gaps.map((g) => g.id).join(', '));
    assert.match(note.message, /not-a-real-annotation/);
    const snip = gaps.find((g) => g.id === 'snippet-passthrough');
    assert.match(snip.message, /HAProxy directives/);
    assert.doesNotMatch(snip.message, /more_set_headers/);
});

/* HAProxy keeps an application's settings on the Ingress, the Services it
   routes to, the controller ConfigMap and its CRs, and applies them per
   backend (Service > Ingress > ConfigMap). convert hands the assembler the
   whole run, and writes the controller-wide part once. */
const HAP_RUN = [
    'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: web', '  namespace: shop',
    '  annotations:', '    haproxy.org/load-balance: leastconn', '    haproxy.org/rate-limit-requests: "20"',
    'spec:', '  ingressClassName: haproxy', '  rules:', '    - host: a.example.com', '      http:', '        paths:',
    '          - path: /', '            pathType: Prefix', '            backend:', '              service:', '                name: web',
    '                port:', '                  number: 80',
    '---', 'apiVersion: v1', 'kind: Service', 'metadata:', '  name: web', '  namespace: shop',
    '  annotations:', '    haproxy.org/load-balance: source', '    haproxy.org/timeout-server: 30s', 'spec:', '  ports:', '    - port: 80',
    '---', 'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: haproxy-kubernetes-ingress', '  namespace: haproxy-controller',
    'data:', '  timeout-connect: "3s"',
    '---', 'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: tcp-services', '  namespace: haproxy-controller',
    'data:', '  "5432": "shop/db:5432"'
].join('\n');

const cli = (args, input, env) => require('node:child_process').spawnSync(process.execPath, [path.join(TOOL, 'nic-migrate.js'), ...args],
    { input, encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });

test('haproxy convert: Service and ConfigMap settings reach the migrated resources', () => {
    const r = cli(['convert', '--source', 'haproxy', '--class', 'nginx-nic'], HAP_RUN);
    assert.equal(r.status, 0, r.stderr);
    const docs = Y.parseAll(r.stdout).filter(Boolean);
    const vs = docs.find((d) => d.kind === 'VirtualServer');
    // The Service's load-balance wins over the Ingress's; its timeout applies.
    assert.equal(vs.spec.upstreams[0]['lb-method'], 'ip_hash');
    assert.equal(vs.spec.upstreams[0]['read-timeout'], '30s');
    assert.equal(vs.spec.ingressClassName, 'nginx-nic', '--class, and the HAProxy class is never kept');
    // The ConfigMap key is global: in the merge document, not on the upstream.
    const cm = docs.find((d) => d.kind === 'ConfigMap');
    assert.equal(cm.data['proxy-connect-timeout'], '3s');
    // tcp-services: one GlobalConfiguration and a TransportServer, once.
    assert.equal(docs.filter((d) => d.kind === 'GlobalConfiguration').length, 1);
    const ts = docs.filter((d) => d.kind === 'TransportServer');
    assert.equal(ts.length, 1);
    assert.equal(ts[0].spec.ingressClassName, 'nginx-nic');
    assert.equal(docs.filter((d) => d.kind === 'Policy').length, 1, 'the rateLimit Policy');
});

test('haproxy convert --target ingress keeps the Ingress and moves the Service settings onto it', () => {
    const r = cli(['convert', '--source', 'haproxy', '--target', 'ingress'], HAP_RUN);
    assert.equal(r.status, 0, r.stderr);
    const ing = Y.parseAll(r.stdout).filter(Boolean).find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/lb-method'], 'ip_hash');
    assert.equal(ing.metadata.annotations['nginx.org/limit-req-rate'], '20r/s');
    assert.equal(ing.spec.ingressClassName, undefined, 'a class naming HAProxy is left off');
});

test('haproxy report: each Ingress sees its own Services, and Annotation swaps shows only the Ingress', () => {
    const r = cli(['report', '--source', 'haproxy', '--no-color', '-s', 'annotation'], HAP_RUN);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nginx\.org\/lb-method: "ip_hash"/);
    const swaps = r.stdout.slice(r.stdout.indexOf('Annotation swaps'), r.stdout.indexOf('Resources'));
    assert.doesNotMatch(swaps, /kind: ConfigMap/, 'the ConfigMap has its own section');
});

test('--kubectl reads every kind the source reads, and skips a CRD that is not installed', () => {
    /* One kubectl get per resource, from a stub that serves HAP_RUN and has no
       HAProxy CRDs installed. */
    const fs2 = require('node:fs'), os = require('node:os');
    const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'nic-migrate-kubectl-'));
    const log = path.join(dir, 'calls');
    const data = path.join(dir, 'run.yaml');
    fs2.writeFileSync(data, HAP_RUN);
    fs2.writeFileSync(path.join(dir, 'kubectl'), [
        '#!/bin/sh', 'echo "$*" >> "' + log + '"',
        'case "$2" in',
        '  ingress|service|configmap) "' + process.execPath + '" -e "const Y=require(\'' + path.join(TOOL, 'lib', 'yaml.js') + '\');const k={ingress:\'Ingress\',service:\'Service\',configmap:\'ConfigMap\'}[process.argv[1]];process.stdout.write(Y.stringify({apiVersion:\'v1\',kind:\'List\',items:Y.parseAll(require(\'fs\').readFileSync(\'' + data + '\',\'utf8\')).filter((d)=>d&&d.kind===k)}))" "$2" ;;',
        '  *) echo "error: the server doesn\'t have a resource type \\"$2\\"" >&2; exit 1 ;;',
        'esac'].join('\n'), { mode: 0o755 });
    const r = cli(['convert', '--source', 'haproxy', '--kubectl'], '', { PATH: dir + path.delimiter + process.env.PATH });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs2.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[1]);
    for (const k of ['ingress', 'service', 'configmap', 'backends.ingress.v3.haproxy.org', 'tcps.ingress.v3.haproxy.org']) assert.ok(calls.includes(k), 'read ' + k);
    assert.match(r.stderr, /no backends\.ingress\.v3\.haproxy\.org in this cluster; skipped/);
    assert.equal(Y.parseAll(r.stdout).filter(Boolean).find((d) => d.kind === 'VirtualServer').spec.upstreams[0]['lb-method'], 'ip_hash');
    // ingress-nginx reads Ingresses only.
    fs2.writeFileSync(log, '');
    cli(['report', '--kubectl'], '', { PATH: dir + path.delimiter + process.env.PATH });
    assert.deepEqual(fs2.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[1]), ['ingress']);
});

test('checklist reads the chosen source\'s page, with its entities decoded', () => {
    const hap = loadChecklist('haproxy-migration.html');
    assert.ok(hap.length > 10);
    assert.ok(hap.some((i) => /haproxy\.org\//.test(i)), 'the HAProxy page\'s own items');
    assert.ok(!hap.some((i) => /&[a-z#0-9]+;/i.test(i)), 'no raw HTML entity: ' + hap.find((i) => /&[a-z#0-9]+;/i.test(i)));
    assert.notDeepEqual(hap, loadChecklist());
    // And `checklist --source haproxy` is the one that reads it.
    const r = cli(['checklist', '--source', 'haproxy'], '');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Inventory haproxy\.org\/ annotations/);
});

test('the e2e runner passes its own self-test, which needs no cluster', () => {
    /* It covers the response parsing, the curl arguments and the waits a
       cluster run is worst at explaining — the readiness probe that returned
       on its first refused attempt, and a convert that exited 1 with partial
       output being applied anyway. Only the e2e workflow ran it, and only when
       e2e paths changed; here it runs with every check. */
    const { spawnSync } = require('node:child_process');
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const r = spawnSync(python, [path.join(ROOT, 'tools', 'nic-migrate', 'e2e', 'run-e2e.py'), '--self-test'],
        { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.error, undefined, 'could not run ' + python + ': ' + (r.error && r.error.message));
    assert.equal(r.status, 0, (r.stdout + r.stderr).split('\n').filter((l) => /FAIL|got/.test(l)).join('\n') || r.stdout + r.stderr);
    assert.match(r.stdout, /(\d+) of \1 self-tests passed/);
});

test('convert writes files that parse, whatever a note quotes', () => {
    /* A note quoting a multi-line annotation value (configuration-snippet)
       was written as one "# NOTE:" line with the value's newlines in it, so
       every line after the first was YAML: `more_set_headers ...` became a
       scalar, the file did not parse, and kubectl apply -f rejected it. Every
       line of a header is a comment now, the files and stdout alike. */
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nic-migrate-'));
    const src = path.join(dir, 'in.yaml');
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = {
        'nginx.ingress.kubernetes.io/configuration-snippet': 'more_set_headers "X-A: b";\nadd_header X-B c;\n',
        'nginx.ingress.kubernetes.io/limit-connections': '5'
    };
    fs.writeFileSync(src, Y.stringify(doc));
    const cli = path.join(TOOL, 'nic-migrate.js');
    for (const args of [['convert', '-f', src], ['convert', '-f', src, '--out', path.join(dir, 'out')]]) {
        const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        const texts = args.includes('--out')
            ? fs.readdirSync(path.join(dir, 'out')).map((f) => fs.readFileSync(path.join(dir, 'out', f), 'utf8'))
            : [r.stdout];
        for (const text of texts) {
            for (const part of text.split(/^---$/m)) {
                const head = part.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l))[0] || '';
                assert.match(head, /^(apiVersion|kind):/, 'a header line escaped its comment:\n' + part.slice(0, 400));
            }
            assert.ok(Y.parseAll(text).every((d) => d && d.kind), 'every document parses to a resource');
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

test('convert: community Ingresses on one host or with several hosts give one VirtualServer or Ingress per host, and one result per input file', () => {
    /* convert runs every Ingress of a run together (migrateMany). A shared
       host's VirtualServer is written with the first Ingress listed; a
       multi-host Ingress is split and comes back as one result. */
    const { convertAll } = require(path.join(TOOL, 'lib', 'convert.js'));
    const two = (name, host, p, svc) => ({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, namespace: 'prod' },
        spec: { rules: [{ host, http: { paths: [{ path: p, pathType: 'Prefix', backend: { service: { name: svc, port: { number: 80 } } } }] } }] } });
    const multi = two('multi', 'b.example.com', '/', 'b');
    multi.spec.rules.push({ host: 'c.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'c', port: { number: 80 } } } }] } });
    const docs = [two('shop', 'a.example.com', '/', 'web'), two('api', 'a.example.com', '/api', 'api'), multi];
    const out = convertAll(docs.map(toModel), engine, { target: 'virtualserver' });
    assert.equal(out.length, 3, 'one result per input Ingress');
    const all = out.flatMap((o) => o.docs);
    const owner = {};
    for (const d of all.filter((x) => x.kind === 'VirtualServer')) (owner[d.spec.host] = owner[d.spec.host] || []).push(d.metadata.name);
    assert.deepEqual(owner, { 'a.example.com': ['a-example-com'], 'b.example.com': ['multi-b'], 'c.example.com': ['multi-c'] });
    assert.deepEqual(out[0].docs.map((d) => d.kind), ['VirtualServer'], 'the merged VirtualServer goes with the first Ingress listed');
    assert.deepEqual(out[1].docs.map((d) => d.kind), [], 'api is in it');
    assert.deepEqual(all.filter((d) => d.kind === 'VirtualServerRoute'), [], 'no VirtualServerRoute');
    assert.equal(out[2].notes.filter((n) => /was split into one per host/.test(n)).length, 1);
});

test('report flags a host that several community Ingresses route, but not a canary pair', () => {
    /* report analyzes each Ingress on its own, so two Ingresses on one host
       each looked complete: 0 blocking, 0 review. */
    const { sharedHosts } = require(path.join(TOOL, 'lib', 'gaps.js'));
    const item = (name, h, canary) => ({ desc: describeIngress(Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
        metadata: { name, namespace: 'prod', annotations: canary ? { 'nginx.ingress.kubernetes.io/canary': 'true' } : {} },
        spec: { rules: [{ host: h, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: name, port: { number: 80 } } } }] } }] } })), gaps: [] });
    const items = [item('shop', 'a.example.com'), item('api', 'a.example.com'), item('shop-canary', 'a.example.com', true), item('solo', 'b.example.com')];
    sharedHosts(items);
    assert.deepEqual(items.map((i) => i.gaps.map((g) => g.id)), [['shared-host'], ['shared-host'], [], []]);
    assert.match(items[0].gaps[0].message, /routed by shop, api\. .*merges them into one VirtualServer/);
});

test('convert and report say what the page says about a community Ingress the community controller refused', () => {
    /* The page shows an error and migrates nothing for it. convert writes the
       others, prints that error to stderr and exits 1 (--json lists it under
       refused); report gives it blocking gaps. One engine function builds the
       text for all three, so they cannot disagree. */
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nic-migrate-'));
    const src = path.join(dir, 'in.yaml');
    const good = JSON.parse(JSON.stringify(INGRESS));
    good.metadata.annotations = { 'nginx.ingress.kubernetes.io/proxy-body-size': '8m' };
    const bad = JSON.parse(JSON.stringify(INGRESS));
    bad.metadata.name = 'bad';
    bad.spec.rules = [{ host: 'bad.example.com', http: bad.spec.rules[0].http }];
    bad.spec.tls = [];
    bad.metadata.annotations = { 'nginx.ingress.kubernetes.io/limit-rps': 'ten' };
    fs.writeFileSync(src, Y.stringifyAll([good, bad]));
    const cli = path.join(TOOL, 'nic-migrate.js');
    const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--no-color'], { encoding: 'utf8' });

    let r = run('convert', '-f', src);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /✗ Ingress \S*bad not migrated — The community controller \(v1\.15\.1\) refuses it by default/);
    assert.match(r.stderr, /limit-rps: ten — expects a whole number\./);
    assert.ok(Y.parseAll(r.stdout).every((d) => d && d.metadata.name !== 'bad'), 'nothing written for the refused Ingress');
    assert.ok(Y.parseAll(r.stdout).some((d) => d && d.kind === 'VirtualServer'), 'the other Ingress still migrates');

    r = run('convert', '-f', src, '--json');
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout);
    assert.deepEqual(json.refused.map((x) => x.name), ['bad']);
    assert.equal(json.refused[0].error.items[0].code, 'nginx.ingress.kubernetes.io/limit-rps: ten');

    r = run('report', '-f', src, '--json');
    const item = JSON.parse(r.stdout).ingresses.find((x) => x.name === 'bad');
    assert.deepEqual(item.gaps.map((g) => g.severity + ' ' + g.id), ['blocking refused', 'blocking refused-value']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('convert prints the command that gives a basic-auth Secret its htpasswd key, as the page does', () => {
    const doc = JSON.parse(JSON.stringify(INGRESS));
    doc.metadata.annotations = { 'nginx.ingress.kubernetes.io/auth-type': 'basic', 'nginx.ingress.kubernetes.io/auth-secret': 'basic-auth' };
    const { out } = runConvert(doc);
    const note = out.notes.find((n) => /key named htpasswd/.test(n));
    assert.ok(note, out.notes.join(' | '));
    assert.match(note, /\n\nkubectl (-n \S+ )?patch secret basic-auth --type merge/);
});
