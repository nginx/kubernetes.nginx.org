'use strict';
/* The migration analyzer's behaviour on real manifests — one test per defect
   the 2026-10-09 audit found (named A1, B4 and so on in the commit that added
   this file), plus the guarantees the rewrite rests on. test-analyzer.js covers the presets and
   the mapping/table contract; nic-migrate.test.js covers the CLI.

   Every manifest here goes through the same parseInput/buildPlan the page
   runs, so a failure is what a reader would have pasted and been told. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');

const { source, tool, warnings } = loadAnalyzer('assets/js/migration-ingress-nginx.js');
const Y = tool.yaml;

// An Ingress with one TLS host and one backend, plus the given annotations.
const ingress = (ann, extra) => {
    const doc = {
        apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
        metadata: { name: 'app', annotations: {} },
        spec: {
            tls: [{ hosts: ['a.example.com'], secretName: 'a-tls' }],
            rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }]
        }
    };
    for (const k of Object.keys(ann || {})) doc.metadata.annotations['nginx.ingress.kubernetes.io/' + k] = ann[k];
    return Object.assign(doc, extra || {});
};
const run = (doc, strategy) => {
    const before = warnings.length;
    const r = analyze(source, typeof doc === 'string' ? doc : Y.stringify(doc), strategy || 'crd');
    assert.deepEqual(warnings.slice(before), [], 'a translator failed');
    // The analyzer runs in a vm context, so its objects belong to another
    // realm and strict deepEqual compares their prototypes: re-home them.
    return Object.assign(r, { docs: JSON.parse(JSON.stringify(Y.parseAll(r.text))) });
};
const kinds = (r, kind) => r.docs.filter((d) => d.kind === kind);
const notes = (r) => r.plan.infoNotes.map((n) => n.code + ' — ' + n.message).join('\n');

/* ---------------------------------------------------------------- parsing */

test('A1: values kubectl wraps onto continuation lines are read whole', () => {
    const r = run([
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  annotations:',
        '    nginx.ingress.kubernetes.io/whitelist-source-range: 10.0.0.0/8, 172.16.0.0/12,',
        '      192.168.0.0/16',
        '    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, X-One,',
        '      X-Two"',
        '    nginx.ingress.kubernetes.io/enable-cors: "true"',
        '  name: wrapped',
        'spec:', '  rules:', '  - host: a.example.com', '    http:', '      paths:', '      - path: /', '        pathType: Prefix',
        '        backend: {service: {name: web, port: {number: 80}}}'
    ].join('\n'));
    const acl = kinds(r, 'Policy').find((p) => p.spec.accessControl);
    assert.deepEqual(acl.spec.accessControl.allow, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
    const cors = kinds(r, 'Policy').find((p) => p.spec.cors);
    assert.deepEqual(cors.spec.cors.allowHeaders, ['Authorization', 'X-One', 'X-Two']);
    assert.equal(kinds(r, 'VirtualServer')[0].metadata.name, 'wrapped', 'the rest of the document survives');
});

test('A2: quote escapes are decoded', () => {
    const r = run(ingress({ 'configuration-snippet': 'add_header X-Debug "#1";' }));
    const vs = kinds(r, 'VirtualServer')[0];
    assert.equal(vs.spec.routes[0]['location-snippets'], 'add_header X-Debug "#1";\n');
    const r2 = run("apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: app\n  annotations:\n    nginx.ingress.kubernetes.io/auth-realm: 'Bob''s'\n    nginx.ingress.kubernetes.io/auth-secret: s\n    nginx.ingress.kubernetes.io/auth-type: basic\nspec:\n  rules:\n  - host: a.example.com\n    http:\n      paths:\n      - path: /\n        pathType: Prefix\n        backend: {service: {name: web, port: {number: 80}}}\n");
    assert.equal(kinds(r2, 'Policy')[0].spec.basicAuth.realm, "Bob's");
});

test('A9: hosts and paths come from the Ingress, not from other documents', () => {
    const deploy = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      containers:\n      - name: c\n        livenessProbe:\n          httpGet: {path: /healthz, port: 8080}\n';
    const r = run(deploy + '---\n' + Y.stringify(ingress({ 'proxy-body-size': '1m' })));
    assert.deepEqual(kinds(r, 'VirtualServer')[0].spec.routes.map((x) => x.path), ['/']);
    assert.match(r.plan.warnings.map((w) => w.message).join(), /1 Deployment/);
});

test('A10: a literal backslash-n in a value is not a line break', () => {
    const r = run(ingress({ 'server-snippet': "location = /ping { return 200 'pong\\n'; }" }));
    assert.equal(kinds(r, 'VirtualServer')[0].spec['server-snippets'], "location = /ping { return 200 'pong\\n'; }\n");
});

test('A16: kubectl -o json input is analyzed', () => {
    const r = run(JSON.stringify(ingress({ 'proxy-body-size': '8m' })));
    assert.equal(kinds(r, 'VirtualServer')[0].spec.upstreams[0]['client-max-body-size'], '8m');
});

test('A18: thousands of blank lines do not stall the parser', () => {
    const t0 = Date.now();
    run(Y.stringify(ingress({ 'proxy-body-size': '8m' })) + '\n'.repeat(8000));
    assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
});

test('A20: inline annotation maps keep each key separate', () => {
    const r = run('apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: app\n  annotations: {nginx.ingress.kubernetes.io/proxy-body-size: 8m, nginx.ingress.kubernetes.io/proxy-read-timeout: "60"}\nspec:\n  rules:\n  - host: a.example.com\n    http:\n      paths:\n      - path: /\n        pathType: Prefix\n        backend: {service: {name: web, port: {number: 80}}}\n');
    const u = kinds(r, 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(u['client-max-body-size'], '8m');
    assert.equal(u['read-timeout'], '60s');
});

test('C6: an Ingress with no community annotations still migrates', () => {
    const doc = ingress({});
    delete doc.metadata.annotations;
    const parsed = source.analyzer.parseInput(Y.stringify(doc));
    assert.equal(parsed.empty, null, 'not reported as "no annotations found"');
    const r = run(doc);
    assert.equal(kinds(r, 'VirtualServer')[0].spec.tls.secret, 'a-tls');
    assert.match(r.plan.banner.strongText, /no community annotations/);
});

test('C6: an unparseable paste and a non-Ingress paste say why', () => {
    const bad = source.analyzer.parseInput('a: 1\n  b: 2\n');
    assert.match(bad.empty.title, /could not be parsed/);
    const svc = source.analyzer.parseInput('apiVersion: v1\nkind: Service\nmetadata:\n  name: s\n');
    assert.match(svc.empty.message, /1 Service/);
});

/* -------------------------------------------------------------- assembly */

test('B1/A4: one VirtualServer per host, carrying TLS — never two on one host', () => {
    const r = run(ingress({ affinity: 'cookie', 'proxy-read-timeout': '30', 'rewrite-target': '/' }));
    const vs = kinds(r, 'VirtualServer');
    assert.equal(vs.length, 1);
    assert.equal(vs[0].spec.tls.secret, 'a-tls');
    assert.ok(!/^annotations:/m.test(r.text), 'no bare annotations: block in the export');
});

test('B1: every host, path and backend of a multi-host Ingress is carried over', () => {
    const doc = ingress({ 'proxy-body-size': '1m' });
    doc.spec.rules.push({ host: 'b.example.com', http: { paths: [{ path: '/x', pathType: 'Prefix', backend: { service: { name: 'other', port: { number: 8080 } } } }] } });
    const vs = kinds(run(doc), 'VirtualServer');
    assert.deepEqual(vs.map((v) => v.spec.host), ['a.example.com', 'b.example.com']);
    assert.equal(vs[1].spec.upstreams[0].service, 'other');
    assert.equal(vs[1].spec.tls, undefined, 'only the TLS host gets tls');
});

test('B1: annotation-first emits the whole migrated Ingress, not an annotations fragment', () => {
    const r = run(ingress({ 'proxy-body-size': '8m' }), 'annotation');
    const ing = kinds(r, 'Ingress')[0];
    assert.equal(ing.metadata.annotations['nginx.org/client-max-body-size'], '8m');
    assert.deepEqual(ing.spec.tls, [{ hosts: ['a.example.com'], secretName: 'a-tls' }]);
});

/* One Ingress per mapped annotation, with the siblings it needs to mean
   anything (canary-weight alone is ignored by the community controller too).
   The sweeps below run all 130 under both strategies. */
const SAMPLE = { 'whitelist-source-range': '10.0.0.0/8', canary: 'true', affinity: 'cookie', 'auth-url': 'http://auth.ns.svc.cluster.local/auth',
    'enable-cors': 'true', 'backend-protocol': 'HTTPS', 'load-balance': 'ewma', 'upstream-hash-by': '$request_uri', 'proxy-buffering': 'on',
    'connection-proxy-header': 'keep-alive', 'ssl-passthrough': 'true', 'custom-http-errors': '404', 'permanent-redirect': 'https://x.example.com',
    'temporal-redirect': 'https://t.example.com', 'limit-rps': '10', 'mirror-target': 'https://m.example.com', 'auth-type': 'basic',
    'rewrite-target': '/', 'app-root': '/a', 'stream-snippet': 'server { listen 1; }', 'server-alias': 'b.example.com',
    'auth-tls-secret': 'ns/ca', 'proxy-ssl-secret': 'ns/c', 'custom-headers': 'ns/cm', 'from-to-www-redirect': 'true', 'default-backend': 'svc' };
const NEEDS = [[/^canary-/, { canary: 'true' }], [/^cors-/, { 'enable-cors': 'true' }], [/^(session-cookie|affinity-mode)/, { affinity: 'cookie' }],
    [/^auth-(signin|snippet|method|response-headers|request-redirect|signin-redirect-param|cache-key|cache-duration|proxy-set-headers)$/, { 'auth-url': 'http://auth.ns.svc.cluster.local/auth' }],
    [/^permanent-redirect-code$/, { 'permanent-redirect': 'https://x.example.com' }], [/^temporal-redirect-code$/, { 'temporal-redirect': 'https://t.example.com' }],
    [/^proxy-ssl-/, { 'proxy-ssl-secret': 'ns/c' }], [/^limit-burst-multiplier$/, { 'limit-rps': '10' }], [/^auth-(secret-type|realm|type)$/, { 'auth-secret': 's' }],
    [/^upstream-hash-by-subset/, { 'upstream-hash-by': '$request_uri' }]];
const sweepInput = (name) => {
    const ann = { [name]: SAMPLE[name] !== undefined ? SAMPLE[name] : '7' };
    for (const [re, add] of NEEDS) if (re.test(name)) Object.assign(ann, add);
    return ann;
};
const MAPPED = source.analyzer.mappings.flatMap((m) => m.community);

test('every recognised annotation is named in the output, under both strategies', () => {
    /* A3: ~25 recognised annotations used to vanish under "Analysis complete".
       Each of the 130 now ends up in a generated comment, a note or a card. */
    const mapped = MAPPED;
    assert.equal(mapped.length, 130);
    const missing = [];
    for (const name of mapped) {
        for (const strategy of ['crd', 'annotation']) {
            const r = run(ingress(sweepInput(name)), strategy);
            const found = (r.text.match(/#.*$/gm) || []).join('\n') + JSON.stringify([r.plan.infoNotes, r.plan.unsupported, r.plan.unrecognized]);
            if (!new RegExp('(^|[^a-z-])' + name + '($|[^a-z-])').test(found)) missing.push(strategy + ' ' + name);
            // Named only as "no translation" is a lost feature, not a migration:
            // every mapped annotation has one (this caught mirror-host and
            // mirror-request-body being dropped when mirroring lost its branch).
            if (r.plan.infoNotes.some((n) => n.code.includes('/' + name + ':') && /has no translation for it/.test(n.message))) missing.push(strategy + ' ' + name + ' (untranslated)');
        }
    }
    assert.deepEqual(missing, [], 'recognised but not named anywhere in the output');
});

/* ----------------------------------------------------------- B: accuracy */

test('B2: app-root is a 302 from "/" only, not a rewrite of everything', () => {
    const vs = kinds(run(ingress({ 'app-root': '/app1' })), 'VirtualServer')[0];
    assert.deepEqual(vs.spec.routes[0], { path: '=/', action: { redirect: { url: '${scheme}://${host}/app1', code: 302 } } });
    assert.equal(vs.spec.routes[1].action.pass, 'web');
    assert.equal(run(ingress({ 'app-root': '/app1' }), 'annotation').docs[0].metadata.annotations['nginx.org/app-root'], '/app1');
});

test('B2/B6: rewrite-target regex routes match like the community ~* and sort longest first', () => {
    const doc = ingress({ 'rewrite-target': '/$2' });
    doc.spec.rules[0].http.paths.unshift({ path: '/api(/|$)(.*)', pathType: 'ImplementationSpecific', backend: { service: { name: 'api', port: { number: 80 } } } });
    const vs = kinds(run(doc), 'VirtualServer')[0];
    assert.deepEqual(vs.spec.routes.map((x) => x.path), ['~ (?i)^/api(/|$)(.*)', '~ (?i)^/']);
    assert.equal(vs.spec.routes[0].action.proxy.rewritePath, '/$2');
    assert.equal(vs.spec.routes[1].action.pass, 'web', '"/" rewritten to "/" is dropped');
    const ing = run(doc, 'annotation').docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/path-regex'], 'case_insensitive');
});

test('B3/A6/A7: a canary defaults to weight 0, and never labels the canary as main', () => {
    const lone = kinds(run(ingress({ canary: 'true', 'canary-by-header': 'X-C' })), 'VirtualServer')[0];
    const route = lone.spec.routes[0];
    assert.equal(route.splits, undefined, 'no split without canary-weight');
    assert.equal(route.action.pass, 'stable', 'the default leg is the stable placeholder');
    assert.equal(route.matches[0].action.pass, 'web');
    const weighted = kinds(run(ingress({ canary: 'true', 'canary-weight': '30' })), 'VirtualServer')[0].spec.routes[0];
    assert.deepEqual(weighted.splits.map((s) => [s.weight, s.action.pass]), [[70, 'stable'], [30, 'web']]);
    assert.ok(!weighted.action, 'a route has splits or an action, never both');
});

test('B3: a canary pasted with its stable Ingress merges into one VirtualServer', () => {
    const stable = ingress({});
    delete stable.metadata.annotations;
    stable.spec.rules[0].http.paths[0].backend.service.name = 'stable-svc';
    const canary = ingress({ canary: 'true', 'canary-weight': '25' });
    canary.metadata.name = 'app-canary';
    canary.spec.rules[0].http.paths[0].backend.service.name = 'canary-svc';
    const r = run(Y.stringifyAll([stable, canary]));
    const vs = kinds(r, 'VirtualServer');
    assert.equal(vs.length, 1);
    assert.deepEqual(vs[0].spec.routes[0].splits.map((s) => s.weight), [75, 25]);
    assert.equal(vs[0].spec.routes[0].splits[0].action.pass, 'stable-svc');
});

/* What NGINX does with a request from `ip`, given the access rules NGINX
   Ingress Controller v5.7.0 renders from a resource. A Policy in spec.policies
   or nginx.org/policies renders at server level (nginx.virtualserver.tmpl
   183-195, nginx.ingress.tmpl 84-96); a route's own Policy in the location,
   after its snippets (328, then 348-359); location-snippets in the location.
   NGINX checks the location's rules and inherits the server's only when the
   location has none, and the first allow or deny that matches decides. */
function inRange(ip, cidr) {
    const [base, bits] = cidr.includes('/') ? cidr.split('/') : [cidr, '32'];
    const n = (a) => a.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const mask = Number(bits) === 0 ? 0 : (0xFFFFFFFF << (32 - Number(bits))) >>> 0;
    return ((n(ip) & mask) >>> 0) === ((n(base) & mask) >>> 0);
}
function accessRules(acl) {
    const out = [];
    for (const a of acl.allow || []) out.push(['allow', a]);
    if ((acl.allow || []).length) out.push(['deny', 'all']);
    for (const d of acl.deny || []) out.push(['deny', d]);
    if ((acl.deny || []).length) out.push(['allow', 'all']);
    return out;
}
const snippetRules = (text) => String(text || '').split('\n').map((l) => l.trim().match(/^(allow|deny) (\S+);$/)).filter(Boolean).map((m) => [m[1], m[2]]);
function nginxAccess(r, strategy, ip) {
    const policies = Object.fromEntries(kinds(r, 'Policy').map((p) => [p.metadata.name, p.spec.accessControl || {}]));
    let server = [], location = [];
    if (strategy === 'crd') {
        const vs = kinds(r, 'VirtualServer')[0];
        for (const ref of vs.spec.policies || []) server = server.concat(accessRules(policies[ref.name] || {}));
        const route = vs.spec.routes[0];
        location = snippetRules(route['location-snippets']);
        for (const ref of route.policies || []) location = location.concat(accessRules(policies[ref.name] || {}));
    } else {
        const a = kinds(r, 'Ingress')[0].metadata.annotations || {};
        for (const name of String(a['nginx.org/policies'] || '').split(',').filter(Boolean)) server = server.concat(accessRules(policies[name] || {}));
        location = snippetRules(a['nginx.org/location-snippets']);
    }
    for (const [verb, who] of (location.length ? location : server)) if (who === 'all' || inRange(ip, who)) return verb === 'allow' ? 200 : 403;
    return 200;
}

test('B4: an allow list beside a deny list answers each client as the community controller did', () => {
    /* The community controller renders deny, then allow, then deny all, in the
       location (nginx.tmpl 1205-1212): denied if on the deny list, else
       allowed if on the allow list, else denied. A location-snippet deny
       beside a server-level allow Policy stopped the location inheriting the
       allow list, and every address outside it was let in (nginx 1.31.7:
       203.0.113.5 got 200). This test used to check only that the deny
       appeared, so it passed. */
    const cases = [
        [{ 'whitelist-source-range': '10.0.0.0/8,172.16.0.0/12', 'denylist-source-range': '10.1.2.3,192.168.1.1' },
            { '10.1.2.3': 403, '10.9.9.9': 200, '172.16.0.1': 200, '192.168.1.1': 403, '203.0.113.5': 403 }],
        // A deny holding an allowed range denies all of it.
        [{ 'whitelist-source-range': '10.1.0.0/16', 'denylist-source-range': '10.0.0.0/8' }, { '10.1.5.5': 403, '203.0.113.5': 403 }],
        [{ 'whitelist-source-range': '10.0.0.0/8' }, { '10.9.9.9': 200, '203.0.113.5': 403 }],
        [{ 'denylist-source-range': '10.1.2.3' }, { '10.1.2.3': 403, '203.0.113.5': 200 }]
    ];
    const broken = [];
    for (const [ann, want] of cases) for (const strategy of ['crd', 'annotation']) {
        const r = run(ingress(ann), strategy);
        for (const ip of Object.keys(want)) {
            const got = nginxAccess(r, strategy, ip);
            if (got !== want[ip]) broken.push(strategy + ' ' + JSON.stringify(ann) + ': ' + ip + ' got ' + got + ', community ' + want[ip]);
        }
    }
    assert.deepEqual(broken, []);
    // Never two Policies: an allow Policy overrides a deny Policy beside it.
    assert.ok(kinds(run(ingress(cases[0][0])), 'Policy').length <= 1);
});

test('B7: externalAuth names the Service, keeps the port and drops community-only variables', () => {
    const r = run(ingress({ 'auth-url': 'http://oauth2-proxy.auth.svc.cluster.local:4180/oauth2/auth',
        'auth-signin': 'https://$host/oauth2/start?rd=$escaped_request_uri', 'auth-response-headers': 'X-Auth-Request-User' }));
    const ea = kinds(r, 'Policy')[0].spec.externalAuth;
    assert.equal(ea.authServiceName, 'auth/oauth2-proxy');
    assert.deepEqual(ea.authServicePorts, [4180]);
    assert.equal(ea.authSigninURI, '/oauth2/start');
    assert.ok(!/escaped_request_uri/.test(r.text));
    assert.match(kinds(r, 'VirtualServer')[0].spec.routes[0]['location-snippets'], /proxy_set_header X-Auth-Request-User \$auth_x_auth_request_user;/);
    const ext = kinds(run(ingress({ 'auth-url': 'https://auth.example.com/check' })), 'Policy')[0].spec.externalAuth;
    assert.notEqual(ext.authServiceName, 'auth', 'an external host is not a Service name');
});

test('B8: snippets carry the enable-snippets warning, and headers-more is called out', () => {
    const r = run(ingress({ 'configuration-snippet': 'more_set_headers "X: 1";' }));
    assert.match(notes(r), /-enable-snippets/);
    assert.match(notes(r), /more_set_headers[^\n]*unknown directive/);
});

test('B9: what NIC reads from each community Secret is stated', () => {
    /* NIC 5.7.0 validates a Secret by its role's keys, not its type (5.6.3
       required nginx.org/ca and nginx.org/htpasswd): the CA Secret works as it
       is, and basic auth needs its key renamed from auth to htpasswd. */
    const mtls = notes(run(ingress({ 'auth-tls-secret': 'ns/ca' })));
    assert.match(mtls, /ca\.crt key[^\n]*same Secret works as it is/);
    assert.doesNotMatch(mtls, /nginx\.org\/ca/);
    assert.match(notes(run(ingress({ 'auth-type': 'basic', 'auth-secret': 's' }))), /key named htpasswd[^\n]*key named auth/);
});

test('5.7: backend mTLS reads its CA from the community proxy-ssl-secret, with no TODO', () => {
    const r = run(ingress({ 'proxy-ssl-secret': 'ns/backend-certs', 'proxy-ssl-verify': 'on' }));
    const e = kinds(r, 'Policy')[0].spec.egressMTLS;
    assert.deepEqual([e.tlsSecret, e.trustedCertSecret], ['backend-certs', 'backend-certs']);
    assert.doesNotMatch(notes(r), /TODO spec\.egressMTLS/);
});

test('B10: GRPCS gets TLS, the gRPC type and HTTP/2, in both strategies', () => {
    /* NIC 5.7.0 turns HTTP/2 on per host (spec.http2, nginx.org/http2), so a
       TLS host needs no global http2 key; 5.6.3 had only that key. */
    const r = run(ingress({ 'backend-protocol': 'GRPCS' }));
    const vs = kinds(r, 'VirtualServer')[0];
    assert.deepEqual([vs.spec.upstreams[0].type, vs.spec.upstreams[0].tls, vs.spec.http2], ['grpc', { enable: true }, true]);
    assert.equal(kinds(r, 'ConfigMap').length, 0, 'a TLS host needs no global http2 key');
    const ann = run(ingress({ 'backend-protocol': 'GRPCS' }), 'annotation').docs.find((d) => d.kind === 'Ingress').metadata.annotations;
    assert.equal(ann['nginx.org/grpc-services'], 'web');
    assert.equal(ann['nginx.org/ssl-services'], 'web');
    assert.equal(ann['nginx.org/http2'], 'true');
    // Cleartext gRPC (h2c) on the default listeners follows the ConfigMap key.
    const plain = ingress({ 'backend-protocol': 'GRPC' });
    delete plain.spec.tls;
    const p = run(plain);
    assert.equal(kinds(p, 'VirtualServer')[0].spec.http2, true);
    assert.equal(kinds(p, 'ConfigMap')[0].data.http2, 'true');
    assert.match(notes(p), /h2c/);
});

test('B11: TLS passthrough is a TransportServer under both strategies, with the flag named', () => {
    for (const s of ['crd', 'annotation']) {
        const r = run(ingress({ 'ssl-passthrough': 'true' }), s);
        assert.equal(kinds(r, 'TransportServer')[0].spec.listener.protocol, 'TLS_PASSTHROUGH');
        assert.match(notes(r), /enableTLSPassthrough/);
    }
});

test('B12: CORS keeps the community defaults, and never pairs * with credentials', () => {
    const cors = kinds(run(ingress({ 'enable-cors': 'true' })), 'Policy')[0].spec.cors;
    assert.equal(cors.allowCredentials, true);
    assert.equal(cors.maxAge, 1728000);
    assert.ok(cors.allowMethods.includes('PATCH'));
    assert.ok(!cors.allowOrigin.includes('*'));
});

test('B15: rate limits keep nodelay and the community 503', () => {
    const rl = kinds(run(ingress({ 'limit-rps': '10', 'limit-connections': '5' })), 'Policy')[0].spec.rateLimit;
    assert.deepEqual([rl.rate, rl.burst, rl.noDelay, rl.rejectCode], ['10r/s', 50, true, 503]);
    const r = run(ingress({ 'limit-rps': '10', 'limit-connections': '5' }));
    assert.match(kinds(r, 'ConfigMap')[0].data['http-snippets'], /limit_conn_zone \$binary_remote_addr zone=app_conn:5m;/);
    assert.match(kinds(r, 'VirtualServer')[0].spec.routes[0]['location-snippets'], /limit_conn app_conn 5;/);
});

test('B16: session affinity keeps max-age and the community cookie name', () => {
    const sc = kinds(run(ingress({ affinity: 'cookie', 'session-cookie-max-age': '172800' })), 'VirtualServer')[0].spec.upstreams[0].sessionCookie;
    assert.equal(sc.name, 'INGRESSCOOKIE');
    assert.equal(sc.expires, '2d');
    const ann = run(ingress({ affinity: 'cookie' }), 'annotation').docs.find((d) => d.kind === 'Ingress').metadata.annotations;
    assert.equal(ann['nginx.org/sticky-cookie-services'], 'serviceName=web INGRESSCOOKIE httponly');
});

test('CRD-first does not call a setting the VirtualServer carries "no VirtualServer form"', () => {
    /* Several translators write the VirtualServer field and the nginx.org/*
       annotation; the CRD-first fallback must not report the annotation as
       lost when the field already carries it (it did, for backend-protocol). */
    for (const ann of [{ 'backend-protocol': 'HTTPS' }, { 'backend-protocol': 'GRPC' }, { 'upstream-hash-by': '$request_uri' },
        { 'proxy-next-upstream': 'error' }, { 'upstream-vhost': 'u.example.com' }, { 'x-forwarded-prefix': '/p' }, { 'custom-headers': 'ns/cm' }]) {
        assert.doesNotMatch(notes(run(ingress(ann))), /has no VirtualServer form/, JSON.stringify(ann));
    }
    // ...and still reports one that has none.
    assert.match(notes(run(ingress({ 'proxy-max-temp-file-size': '1m' }))), /snippets/);
});

test('mirroring keeps the mirror, its Host and its request body', () => {
    const vs = kinds(run(ingress({ 'mirror-target': 'https://m.example.com$request_uri', 'mirror-request-body': 'off' })), 'VirtualServer')[0];
    assert.equal(vs.spec.routes[0]['location-snippets'], 'mirror /_mirror-app;\nmirror_request_body off;\n');
    assert.match(vs.spec['server-snippets'], /location = \/_mirror-app \{\n    internal;\n    proxy_set_header Host m\.example\.com;\n    proxy_pass https:\/\/m\.example\.com\$request_uri;\n\}/);
    // A hostname with a variable needs a resolver (nginx 1.29: "no resolver defined").
    assert.match(notes(run(ingress({ 'mirror-target': 'https://m.example.com$request_uri' }))), /resolver-addresses/);
    assert.doesNotMatch(notes(run(ingress({ 'mirror-target': 'https://m.example.com/fixed' }))), /resolver-addresses/);
});

test('A14: a beta Ingress migrates to a valid networking.k8s.io/v1 one', () => {
    const doc = ingress({ 'proxy-body-size': '8m' });
    doc.apiVersion = 'extensions/v1beta1';
    doc.spec.backend = { serviceName: 'default-svc', servicePort: 80 };
    doc.spec.rules[0].http.paths[0] = { path: '/', backend: { serviceName: 'web', servicePort: 'http' } };
    const ing = kinds(run(doc, 'annotation'), 'Ingress')[0];
    assert.equal(ing.apiVersion, 'networking.k8s.io/v1');
    assert.deepEqual(ing.spec.rules[0].http.paths[0], { path: '/', backend: { service: { name: 'web', port: { name: 'http' } } }, pathType: 'ImplementationSpecific' });
    assert.deepEqual(ing.spec.defaultBackend, { service: { name: 'default-svc', port: { number: 80 } } });
    assert.equal(ing.spec.backend, undefined);
});

test('B17: each server-alias is its own lowercase host', () => {
    const vs = kinds(run(ingress({ 'server-alias': 'www.example.com,Alt.Example.com' })), 'VirtualServer');
    assert.deepEqual(vs.map((v) => v.spec.host), ['a.example.com', 'www.example.com', 'alt.example.com']);
});

test('A5: generated YAML parses back — wildcard hosts, regex values, NO/YES', () => {
    const doc = ingress({ 'canary': 'true', 'canary-by-header': 'X-C', 'canary-by-header-pattern': '^v\\d+$', 'configuration-snippet': 'NO' });
    doc.spec.rules[0].host = '*.example.com';
    doc.spec.tls[0].hosts = ['*.example.com'];
    for (const s of ['crd', 'annotation']) {
        const r = run(doc, s);
        assert.ok(r.docs.length > 0);
        assert.ok(!/^\s*host: \*/m.test(r.text), 'a wildcard host is quoted');
    }
    const vs = kinds(run(doc), 'VirtualServer')[0];
    assert.equal(vs.spec.routes[0].matches[0].conditions[0].value, '~^v\\d+$');
});

test('A12/A19: empty and prototype-named values are reported, not crashed on or emitted', () => {
    const r = run(ingress({ 'proxy-buffer-size': '', 'load-balance': 'constructor' }));
    assert.ok(!/buffer-size|lb-method/.test(r.text.replace(/#.*$/gm, '')), r.text);
    assert.match(notes(r), /constructor/);
});

test('B14: force-ssl-redirect follows the request scheme, as the community controller did', () => {
    /* lua_ingress.lua redirects when pass_access_scheme is http: $scheme, or
       X-Forwarded-Proto only under the global use-forwarded-headers. With TLS
       on the Ingress that is tls.redirect's default (basedOn scheme); without
       TLS the note explains the load-balancer case instead of guessing. */
    const vs = kinds(run(ingress({ 'force-ssl-redirect': 'true' })), 'VirtualServer')[0];
    assert.deepEqual(vs.spec.tls.redirect, { enable: true, code: 308 });
    const noTls = ingress({ 'force-ssl-redirect': 'true' });
    delete noTls.spec.tls;
    assert.match(notes(run(noTls)), /use-forwarded-headers/);
});

test('C7: every migration names the ingressClassName change', () => {
    assert.match(notes(run(ingress({ 'proxy-body-size': '1m' }))), /ingressClassName/);
});

test('C8: the simple sample is not labelled advanced under CRD-first', () => {
    const r = run(source.analyzer.samplePresets.simple);
    assert.equal(r.plan.banner.complexity, 'simple');
});

test('generated resources pass the checks NIC applies at admission', () => {
    /* A static subset of NIC's validation (v5.6.3, unchanged at v5.7.0): one of action/splits per
       route, split weights summing to 100, Service-name upstreams, valid
       redirect codes and error-page ranges. */
    const all = ['simple', 'moderate', 'advanced'].flatMap((p) => ['crd', 'annotation'].map((s) => run(source.analyzer.samplePresets[p], s)));
    all.push(run(ingress({ canary: 'true', 'canary-weight': '30', 'custom-http-errors': '404,503', 'permanent-redirect': 'https://x.example.com' })));
    for (const r of all) {
        for (const vs of kinds(r, 'VirtualServer')) {
            const names = new Set((vs.spec.upstreams || []).map((u) => u.name));
            for (const route of vs.spec.routes) {
                assert.equal(Number(!!route.action) + Number(!!route.splits), 1, 'route ' + route.path + ': exactly one of action / splits');
                if (route.splits) assert.equal(route.splits.reduce((n, s) => n + s.weight, 0), 100);
                for (const a of [route.action].concat((route.splits || []).map((s) => s.action), (route.matches || []).map((m) => m.action))) {
                    if (a && a.pass) assert.ok(names.has(a.pass), 'pass ' + a.pass + ' names an upstream');
                    if (a && a.redirect) assert.ok([301, 302, 307, 308].includes(a.redirect.code));
                }
                for (const e of route.errorPages || []) assert.ok(e.codes.every((c) => c >= 300 && c <= 599));
            }
        }
    }
});

/* Defects the reference-row sync found, each checked against NIC v5.6.3. */

test('a top-level auth-signin gets its own base path, never "/"', () => {
    /* NIC adds `location <authSigninRedirectBasePath>` for the sign-in. The
       parent of /login is "/", which duplicated the route's location "/". */
    for (const s of ['crd', 'annotation']) {
        const p = kinds(run(ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/verify', 'auth-signin': 'https://$host/login' }), s), 'Policy')[0];
        assert.equal(p.spec.externalAuth.authSigninURI, '/login');
        assert.equal(p.spec.externalAuth.authSigninRedirectBasePath, '/login');
    }
    const oauth = kinds(run(ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/oauth2/auth', 'auth-signin': 'https://$host/oauth2/start' })), 'Policy')[0];
    assert.equal(oauth.spec.externalAuth.authSigninRedirectBasePath, undefined, '/oauth2 is NIC\'s default');
    const clash = ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/verify', 'auth-signin': 'https://$host/api/login' });
    clash.spec.rules[0].http.paths.push({ path: '/api', pathType: 'Prefix', backend: { service: { name: 'api', port: { number: 80 } } } });
    assert.match(notes(run(clash)), /already routes \/api/);
});

test('enable-opentelemetry carries the exporter endpoint NIC requires', () => {
    /* otel-trace-in-http without otel-exporter-endpoint: NIC reports the
       ConfigMap invalid and turns tracing off (configmaps.go). */
    const r = run(ingress({ 'enable-opentelemetry': 'true' }));
    const cm = kinds(r, 'ConfigMap')[0];
    assert.equal(cm.data['otel-trace-in-http'], 'true');
    assert.ok(cm.data['otel-exporter-endpoint'], 'endpoint present');
    assert.match(r.text, /otel-exporter-endpoint: .*# TODO/);
    assert.equal(kinds(run(ingress({ 'enable-opentelemetry': 'false' })), 'ConfigMap').length, 0);
});

test('auth-always-set-cookie keeps always, and a plain auth-url says the cookie is not passed on', () => {
    for (const s of ['crd', 'annotation']) {
        const r = run(ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/verify', 'auth-always-set-cookie': 'true' }), s);
        assert.match(r.text, /add_header Set-Cookie \$auth_cookie always;/);
    }
    const plain = run(ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/verify' }));
    assert.doesNotMatch(plain.text, /snippets/, 'no snippet unless asked for');
    assert.match(notes(plain), /Set-Cookie from the auth response/);
});

test('custom-headers marks its placeholder and keeps more_set_headers\' every-status behaviour', () => {
    const crd = run(ingress({ 'custom-headers': 'default/h' }));
    assert.match(crd.text, /responseHeaders: +# custom-headers — TODO/);
    assert.equal(kinds(crd, 'VirtualServer')[0].spec.routes[0].action.proxy.responseHeaders.add[0].always, true);
    const ann = run(ingress({ 'custom-headers': 'default/h' }), 'annotation');
    assert.match(ann.text, /nginx\.org\/add-header: "X-Example-Header: value: always" +# custom-headers — TODO/);
});

test('advice that needs NGINX Plus says so', () => {
    /* ExternalName backends and resolver-addresses are Plus-only in v5.6.3 and
       v5.7.0 (controller.go getEndpointsForIngressBackend, configmaps.go). */
    assert.match(notes(run(ingress({ 'auth-url': 'https://auth.example.com/verify' }))), /ExternalName Service in front of auth\.example\.com works only on NGINX Plus/);
    assert.match(notes(run(ingress({ 'mirror-target': 'http://mirror.example.com$request_uri' }))), /add a resolver line .*On NGINX Plus, the resolver-addresses/);
});

test('auth-keepalive says what each target does with the auth connection', () => {
    const ann = { 'auth-url': 'http://auth.default.svc.cluster.local/verify', 'auth-keepalive': '10' };
    assert.match(notes(run(ingress(ann), 'crd')), /new connection to the auth Service for each check/);
    assert.match(notes(run(ingress(ann), 'annotation')), /shares nginx\.org\/keepalive/);
});

test('each card shows the community annotations behind its own resource', () => {
    /* Every card used to repeat the whole Ingress (24 annotations beside a
       three-line mTLS Policy); a card shows what produced the resource beside it. */
    const cardKeys = (r) => r.plan.steps.flatMap((s) => s.blocks.flatMap((b) => b.items || (b.old ? [b] : [])))
        .map((it) => ({ name: it.category || '', keys: (it.old.yaml.match(/nginx\.ingress\.kubernetes\.io\/([a-z0-9-]+)/g) || []).map((x) => x.split('/')[1]) }));
    const cards = cardKeys(run(source.analyzer.samplePresets.advanced));
    const card = (re) => cards.find((c) => re.test(c.name)).keys.sort();
    assert.deepEqual(card(/ingress-mtls$/), ['auth-tls-secret', 'auth-tls-verify-client', 'auth-tls-verify-depth']);
    assert.deepEqual(card(/rate-limit$/), ['limit-connections', 'limit-rps']);
    const vs = card(/secure\.example\.com/);
    assert.ok(vs.includes('proxy-body-size') && vs.includes('affinity') && vs.includes('limit-connections'));
    assert.ok(!vs.includes('cors-allow-origin') && !vs.includes('limit-rps') && !vs.includes('enable-modsecurity'), vs.join(' '));
    // A canary pair: the merged VirtualServer shows both Ingresses' annotations.
    const pair = Y.stringifyAll([ingress({ 'proxy-body-size': '8m' }), Object.assign(ingress({ canary: 'true', 'canary-weight': '20' }), { metadata: { name: 'app-canary', annotations: { 'nginx.ingress.kubernetes.io/canary': 'true', 'nginx.ingress.kubernetes.io/canary-weight': '20' } } })]);
    assert.deepEqual(cardKeys(run(pair)).find((c) => /a\.example\.com/.test(c.name)).keys.sort(), ['canary', 'canary-weight', 'proxy-body-size']);
    // Nothing behind the VirtualServer but the rules: the card shows the spec.
    const bare = run(ingress({ 'enable-modsecurity': 'true' })).plan.steps.find((s) => s.id === 'analyzer-step-3').blocks.find((b) => b.items).items[0];
    assert.match(bare.old.yaml, /spec:\n  tls:/);
    assert.doesNotMatch(bare.old.yaml, /annotations: \{\}/);
});

test('the analyzer view keeps its four promises for every annotation and sample', () => {
    /* Rules, not a snapshot: what must hold whatever the engine does, checked
       over the 130-annotation sweep under both strategies and the three
       samples. A snapshot would read every intended improvement as a
       regression; these fail only when a promise to the reader breaks. Each
       failure names its rule, the input, the strategy and the card. */
    const mappingOf = {};
    for (const m of source.analyzer.mappings) for (const n of m.community) mappingOf[n] = m;
    const cases = MAPPED.map((name) => ({ label: name, doc: ingress(sweepInput(name)), pasted: Object.keys(sweepInput(name)) }))
        .concat(Object.keys(source.analyzer.samplePresets).map((p) => {
            const yaml = source.analyzer.samplePresets[p];
            return { label: 'sample ' + p, doc: yaml, pasted: [...new Set((yaml.match(/nginx\.ingress\.kubernetes\.io\/([a-z0-9-]+)/g) || []).map((x) => x.split('/')[1]))] };
        }));
    const kindsIn = (text) => (text.match(/^kind: (\w+)/gm) || []).map((k) => k.slice(6));
    const broken = [];
    for (const c of cases) {
        for (const strategy of ['crd', 'annotation']) {
            const r = run(c.doc, strategy);
            const at = c.label + ' / ' + strategy;
            const cards = r.plan.steps.flatMap((s) => s.blocks.flatMap((b) => b.items || (b.old ? [b] : [])))
                .map((it) => ({
                    title: it.category || it.old.title,
                    left: (it.old.yaml.match(/nginx\.ingress\.kubernetes\.io\/([a-z0-9-]+)/g) || []).map((x) => x.split('/')[1]),
                    oldYaml: it.old.yaml,
                    kinds: kindsIn(it.new.yaml),
                    newYaml: it.new.yaml
                }));
            for (const card of cards) {
                // 1. Both sides, and the left shows only what was pasted.
                if (!card.oldYaml.trim() || !card.newYaml.trim()) broken.push('1 ' + at + ': ' + card.title + ' has an empty side');
                if (/annotations: \{\}/.test(card.oldYaml)) broken.push('1 ' + at + ': ' + card.title + ' shows an empty annotations block');
                for (const k of card.left) if (!c.pasted.includes(k)) broken.push('1 ' + at + ': ' + card.title + ' shows ' + k + ', which was not pasted');
                // 2. A Policy comes from one mapping, so its card shows that mapping's annotations only.
                if (card.kinds.length === 1 && card.kinds[0] === 'Policy' && new Set(card.left.map((k) => mappingOf[k])).size > 1) {
                    broken.push('2 ' + at + ': Policy card ' + card.title + ' mixes ' + card.left.join(', '));
                }
            }
            // 4. The export carries exactly the resources the cards show.
            const shown = cards.flatMap((card) => card.kinds).sort().join(', ');
            const exported = (r.plan.export ? r.plan.export.parts : []).flatMap(kindsIn).sort().join(', ');
            if (shown !== exported) broken.push('4 ' + at + ': the cards show [' + shown + '], the export holds [' + exported + ']');
            // 5. CRD-first replaces the Ingress; annotation-first keeps it. TLS
            //    passthrough has no Ingress form, so it is a TransportServer under both.
            const all = cards.flatMap((card) => card.kinds);
            if (strategy === 'crd' && all.includes('Ingress')) broken.push('5 ' + at + ': CRD-first emitted an Ingress');
            if (strategy === 'annotation' && all.includes('VirtualServer') && !all.includes('TransportServer')) {
                broken.push('5 ' + at + ': annotation-first emitted a VirtualServer');
            }
        }
    }
    assert.deepEqual(broken, [], 'a promise of the analyzer view broke');
});

/* NIC 5.7.0: constructs that moved from "no equivalent" or a snippet to a
   native field, each checked against the v5.7.0 tag. */

test('5.7: proxy-http-version is the native annotation and upstream field, not a snippet', () => {
    /* 5.6.3 rendered proxy_http_version 1.1 itself, so the snippet duplicated
       it and failed the reload; 5.7.0 renders it only when set. */
    const crd = run(ingress({ 'proxy-http-version': '1.0' }));
    assert.equal(kinds(crd, 'VirtualServer')[0].spec.upstreams[0]['proxy-http-version'], '1.0');
    assert.doesNotMatch(crd.text, /proxy_http_version/);
    const ann = run(ingress({ 'proxy-http-version': '1.0' }), 'annotation');
    assert.equal(kinds(ann, 'Ingress')[0].metadata.annotations['nginx.org/proxy-http-version'], '1.0');
    assert.doesNotMatch(ann.text, /snippets/);
});

test('5.7: tracing keeps the community trace context, and trust-incoming-span maps to otel-trace-context', () => {
    /* The community controller emitted opentelemetry_propagate on every traced
       location; NIC 5.7.0's otel-trace-context defaults to ignore. */
    const cm = (ann) => kinds(run(ingress(ann)), 'ConfigMap')[0].data;
    assert.equal(cm({ 'enable-opentelemetry': 'true' })['otel-trace-context'], 'propagate');
    assert.equal(cm({ 'enable-opentelemetry': 'true', 'opentelemetry-trust-incoming-span': 'false' })['otel-trace-context'], 'inject');
    assert.equal(cm({ 'enable-opentelemetry': 'true', 'opentelemetry-trust-incoming-span': 'true' })['otel-trace-context'], 'propagate');
    assert.match(notes(run(ingress({ 'enable-opentelemetry': 'true', 'opentelemetry-trust-incoming-span': 'false' }))), /global in NGINX Ingress Controller/);
});

test('5.7: ewma becomes least_time last_byte, which NGINX Open Source has since 1.31.0', () => {
    /* ewma.lua picks by a decayed average of connect plus response time;
       least_time last_byte by average time to the full response. NIC 5.7.0's
       OSS ParseLBMethod accepts it; 5.6.3 allowed it on Plus only. */
    assert.equal(kinds(run(ingress({ 'load-balance': 'ewma' })), 'VirtualServer')[0].spec.upstreams[0]['lb-method'], 'least_time last_byte');
    assert.equal(kinds(run(ingress({ 'load-balance': 'ewma' }), 'annotation'), 'Ingress')[0].metadata.annotations['nginx.org/lb-method'], 'least_time last_byte');
});

/* ----------------------------------------------------------------- naming */

test('what a reader sees names each product in full', () => {
    /* AGENTS.md: "NGINX Ingress Controller", "Ingress-NGINX" in titles. The
       notes and YAML comments had drifted to "NIC" in 40-odd places. Runs the
       presets and every mapped annotation, under both strategies, and reads
       every string the plan holds, the mapping text and the page's own copy.
       "NGINX Open Source" is never shortened either, to "NGINX OSS" or a bare
       "OSS" (F5 terminology); ten had sat on the page unseen by this list. */
    const BAD = /\b(NIC|NGF|OSS)\b|F5 NGINX Ingress Controller|community NGINX|behaviour|\b\w*([Nn]ormalis|[Rr]ecognis|[Oo]rganis|[Hh]onour|[Cc]olour)\w*/;
    const found = new Set();
    const walk = (o, where) => {
        if (typeof o === 'string') { if (BAD.test(o)) found.add(where + ': ' + o.match(new RegExp('.{0,40}' + BAD.source + '.{0,20}'))[0]); return; }
        if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], where);
    };
    const inputs = Object.values(source.analyzer.samplePresets).map((p) => p.yaml || p);
    for (const m of source.analyzer.mappings) {
        walk(m.nic, 'mapping ' + m.community[0]);
        for (const a of m.community) inputs.push(Y.stringify(ingress({ [a]: 'true', 'auth-url': 'https://auth.example.com/verify' })));
    }
    // Notes that need a companion annotation to fire at all.
    inputs.push(Y.stringify(ingress({ affinity: 'cookie', 'session-cookie-change-on-failure': 'true' })));
    // The strings the page shows around the analyzer, such as the no-findings title.
    walk(source.strings, 'strings');
    walk(source.analyzer.strategies, 'strategies');
    for (const y of inputs) for (const s of ['annotation', 'crd']) walk(analyze(source, y, s).plan, 'plan');
    const fs = require('node:fs'), path = require('node:path');
    const { ROOT } = require('./lib/load.js');
    for (const page of ['index.html', 'ingress-nginx-migration.html']) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8').replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/g, '');
        const text = html.replace(/<[^>]+>/g, ' ') + ' ' + [...html.matchAll(/(?:aria-label|title|alt)="([^"]*)"/g)].map((m) => m[1]).join(' ');
        walk(text, page);
    }
    // Strings no input above reaches, such as the note for a mapped annotation
    // its translator left unconsumed, and the gap and convert notes the CLI
    // prints: every literal, comments (British, for agents) stripped.
    // "Recognised" and four "NIC"s sat in those unseen.
    const lib = path.join('tools', 'nic-migrate', 'lib');
    for (const file of ['assets/js/migration-ingress-nginx.js', ...fs.readdirSync(path.join(ROOT, lib)).map((f) => path.join(lib, f))]) {
        const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
        for (const m of code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)) walk(m[0], file);
    }
    assert.deepEqual([...found], []);
});

test('an integer annotation the community controller would have ignored migrates to nothing, not NaN', () => {
    /* The community controller read these with strconv.Atoi and, on an
       invalid value, kept its default; parseInt read "10m" as 10 and "abc" as
       NaN, which reached the YAML. A depth of 0 also meant the default, 1. */
    for (const [ann, extra] of [['auth-tls-verify-depth', { 'auth-tls-secret': 'ns/ca' }], ['proxy-ssl-verify-depth', { 'proxy-ssl-secret': 'ns/s' }],
        ['limit-rate', {}], ['limit-rate-after', {}], ['proxy-next-upstream-tries', {}]]) {
        for (const strategy of ['annotation', 'crd']) {
            const r = run(ingress(Object.assign({ [ann]: '10m' }, extra)), strategy);
            assert.doesNotMatch(r.text, /NaN|\b10k;|verifyDepth: 10\b|tries: "?10\b/, ann + ' under ' + strategy);
            assert.match(notes(r), new RegExp(ann + ' "10m" is not a whole number'), ann + ' under ' + strategy);
        }
    }
    assert.equal(kinds(run(ingress({ 'auth-tls-secret': 'ns/ca', 'auth-tls-verify-depth': '0' })), 'Policy')[0].spec.ingressMTLS.verifyDepth, 1);
    assert.match(run(ingress({ 'limit-rate': '100' })).text, /limit_rate 100k;/);
});

test('an invalid limit-rps, limit-rpm or limit-connections says the community controller rejected the Ingress', () => {
    /* ratelimit/main.go (controller-v1.15.1) returns these three's
       ValidationError, so Extract fails: the webhook refuses the Ingress and
       the store never loads it. They were filtered out with no note and
       listed as "Also applied". limit-burst-multiplier's error is swallowed
       (the default 5 is kept), but parseInt read "10m" as 10. */
    for (const ann of ['limit-rps', 'limit-rpm', 'limit-connections']) {
        for (const strategy of ['annotation', 'crd']) {
            const r = run(ingress({ [ann]: 'x' }), strategy);
            assert.match(notes(r), new RegExp(ann + ' "x" is not a whole number, so the community controller rejected this Ingress'), ann + ' under ' + strategy);
            assert.doesNotMatch(notes(r), /Also applied/, ann + ' under ' + strategy);
        }
    }
    const burst = kinds(run(ingress({ 'limit-rps': '10', 'limit-burst-multiplier': '10m' })), 'Policy')[0].spec.rateLimit.burst;
    assert.equal(burst, 50, 'an invalid multiplier keeps the community default of 5');
});

test('only a mapping that wrote something is reported as folded in', () => {
    /* "Also applied, folded into the fields above" listed every consumed
       annotation no comment named, including ones whose translator wrote
       nothing: 27 annotations under one value or another, among them a
       cors-* without enable-cors right after the note saying nothing was
       migrated. */
    const cors = notes(run(ingress({ 'cors-allow-origin': 'https://a.example.com' })));
    assert.match(cors, /enable-cors is not "true".*nothing is migrated/);
    assert.doesNotMatch(cors, /Also applied|did not say why/, 'the enable-cors note covers the cors-* beside it');
    // Wrote nothing, said nothing: the safety net. Every mapped annotation,
    // alone, under values the community controller ignored, defaulted or
    // rejected, has its own reason; one that falls through to the generic
    // warning is a translator that dropped something silently. This sweep
    // found 27 of them.
    const lost = [];
    for (const name of MAPPED) {
        for (const value of ['true', 'false', 'on', '10', '10m', 'x', '', 'https://a.example.com/x', 'ns/secret']) {
            for (const strategy of ['crd', 'annotation']) {
                if (/did not say why/.test(notes(run(ingress({ [name]: value }), strategy)))) lost.push(name + '=' + JSON.stringify(value) + ' ' + strategy);
            }
        }
    }
    assert.deepEqual(lost, []);
    // Wrote something no comment names: still listed as folded in.
    assert.match(notes(run(ingress({ affinity: 'cookie' }))), /Also applied, folded into the fields above: affinity\./);
});

test('a boolean annotation is read as the community controller read it: strconv.ParseBool', () => {
    /* truthy() took "on" and "yes" as true. ParseBool rejects them, and each
       community parser then kept false, kept true, or rejected the Ingress
       (controller-v1.15.1). enable-cors "on" became a CORS Policy that was
       never on. */
    const r = (ann, s) => run(ingress(ann), s || 'crd');
    assert.equal(kinds(r({ 'enable-cors': 'on' }), 'Policy').length, 0, 'enable-cors "on" was off');
    assert.match(notes(r({ 'enable-cors': 'on' })), /enable-cors "on" is not a boolean, so the community controller read it as false/);
    assert.equal(kinds(r({ 'enable-cors': 'True' }), 'Policy').length, 1, 'Go accepts "True"');
    assert.equal(kinds(r({ 'enable-cors': 'true', 'cors-allow-credentials': 'yes' }), 'Policy')[0].spec.cors.allowCredentials, true, 'invalid credentials kept the default, true');
    for (const [ann, extra] of [['ssl-passthrough', {}], ['from-to-www-redirect', {}], ['upstream-hash-by-subset', { 'upstream-hash-by': '$remote_addr' }], ['auth-tls-pass-certificate-to-upstream', { 'auth-tls-secret': 'ns/ca' }]]) {
        assert.match(notes(r(Object.assign({ [ann]: 'yes' }, extra))), new RegExp(ann + ' "yes" is not a boolean, so the community controller rejected this Ingress'), ann);
    }
    // A rejected value migrates nothing for itself.
    assert.equal(kinds(r({ 'ssl-passthrough': 'yes' }), 'TransportServer').length, 0);
    assert.equal(kinds(r({ 'ssl-passthrough': 'true' }), 'TransportServer').length, 1);
    // An invalid auth-always-set-cookie failed authreq Parse: no external auth at all.
    const auth = r({ 'auth-url': 'http://auth.ns.svc/verify', 'auth-always-set-cookie': 'yes' });
    assert.equal(kinds(auth, 'Policy').length, 0);
    assert.match(notes(auth), /dropped external auth for this Ingress/);
});

test('redirects follow redirect.go: temporal wins, out-of-range codes fall back, an invalid code rejects', () => {
    const vs = (ann) => kinds(run(ingress(ann)), 'VirtualServer')[0].spec.routes[0].action.redirect;
    assert.deepEqual(vs({ 'permanent-redirect': 'https://b.example.com', 'temporal-redirect': 'https://c.example.com' }), { url: 'https://c.example.com', code: 302 });
    assert.equal(vs({ 'permanent-redirect': 'https://b.example.com', 'permanent-redirect-code': '299' }).code, 301);
    assert.match(notes(run(ingress({ 'permanent-redirect': 'https://b.example.com', 'permanent-redirect-code': '299' }))), /299 is outside 300-308, so the community controller used 301/);
    assert.equal(vs({ 'permanent-redirect': 'https://b.example.com', 'permanent-redirect-code': '308' }).code, 308);
    assert.match(notes(run(ingress({ 'permanent-redirect-code': 'x' }))), /permanent-redirect-code "x" is not a whole number, so the community controller rejected this Ingress/);
    assert.match(notes(run(ingress({ 'temporal-redirect-code': '307' }))), /applies only to temporal-redirect, which is not set/);
});

test('proxy-ssl-* without proxy-ssl-secret migrate to nothing, and verify takes on or off only', () => {
    /* proxyssl Parse returns before reading the rest without the secret;
       verify and server-name were off unless exactly "on". */
    assert.equal(kinds(run(ingress({ 'proxy-ssl-verify': 'on', 'proxy-ssl-ciphers': 'HIGH' })), 'Policy').length, 0);
    const p = kinds(run(ingress({ 'proxy-ssl-secret': 'ns/s', 'proxy-ssl-verify': 'true', 'proxy-ssl-server-name': 'yes' })), 'Policy')[0].spec.egressMTLS;
    assert.equal(p.verifyServer, undefined);
    assert.equal(p.serverName, undefined);
    assert.equal(kinds(run(ingress({ 'proxy-ssl-secret': 'ns/s', 'proxy-ssl-verify': 'on' })), 'Policy')[0].spec.egressMTLS.verifyServer, true);
});

test('basic auth needs auth-type and client mTLS needs auth-tls-secret, as in the community parsers', () => {
    /* auth and authtls Parse return before reading anything else without
       them; auth-secret or auth-tls-verify-client alone built a Policy. */
    for (const s of ['crd', 'annotation']) {
        const basic = run(ingress({ 'auth-secret': 's', 'auth-realm': 'r' }), s);
        assert.equal(kinds(basic, 'Policy').length, 0, s);
        assert.equal((basic.docs[0].metadata.annotations || {})['nginx.org/basic-auth-secret'], undefined, s);
        assert.match(notes(basic), /No auth-type, so the community controller ignored auth-secret, auth-realm/);
        assert.equal(kinds(run(ingress({ 'auth-tls-verify-client': 'on' }), s), 'Policy').length, 0, s);
    }
    assert.equal(kinds(run(ingress({ 'auth-type': 'basic', 'auth-secret': 's' })), 'Policy')[0].spec.basicAuth.secret, 's');
    assert.equal(kinds(run(ingress({ 'auth-tls-secret': 'ns/ca' })), 'Policy')[0].spec.ingressMTLS.clientCertSecret, 'ca');
});

test('values copied onto an NGINX Ingress Controller bool are the bool the community controller used', () => {
    /* ssl-redirect, force-ssl-redirect and service-upstream were copied as
       given: "on" reached nginx.org/redirect-to-https, which admission
       validates as a bool, so the migrated Ingress was rejected. An invalid
       value took the community default: true, false and false. */
    const ann = (a) => run(ingress(a), 'annotation').docs[0].metadata.annotations;
    assert.equal(ann({ 'force-ssl-redirect': 'on' })['nginx.org/redirect-to-https'], 'false');
    assert.equal(ann({ 'ssl-redirect': 'x' })['nginx.org/ssl-redirect'], 'true');
    assert.equal(ann({ 'ssl-redirect': 'False' })['nginx.org/ssl-redirect'], 'false');
    assert.equal(ann({ 'service-upstream': 'yes' })['nginx.org/use-cluster-ip'], 'false');
    // CRD-first: tls.redirect reads the same defaults, with a note.
    const redirect = (a) => (kinds(run(ingress(a)), 'VirtualServer')[0].spec.tls || {}).redirect;
    assert.ok(redirect({ 'ssl-redirect': 'off' }), 'an invalid ssl-redirect kept the default, true');
    assert.equal(redirect({ 'ssl-redirect': 'false', 'force-ssl-redirect': 'on' }), undefined);
    assert.match(notes(run(ingress({ 'force-ssl-redirect': 'on' }))), /force-ssl-redirect "on" is not a boolean, so the community controller used its default, false/);
    // canary "yes" was not a canary: the Ingress is served as itself.
    assert.match(notes(run(ingress({ canary: 'yes', 'canary-weight': '10' }))), /canary "yes" is not a boolean/);
});

test('custom-http-errors with any entry that is not a number migrates none, and proxy-redirect-to alone says why', () => {
    /* customhttperrors Parse fails on the first entry Atoi rejects, and
       Extract skips the parser: "404,x" set no error pages at all. */
    for (const s of ['crd', 'annotation']) {
        const r = run(ingress({ 'custom-http-errors': '404,x' }), s);
        assert.doesNotMatch(r.text, /errorPages|nginx\.org\/custom-http-errors/, s);
        assert.match(notes(r), /"x" is not a status code, so the community controller ignored custom-http-errors altogether/);
        assert.doesNotMatch(notes(r), /Annotation-first is recommended/);
    }
    assert.match(notes(run(ingress({ 'proxy-redirect-to': 'x' }))), /proxy-redirect-to applies only with a proxy-redirect-from/);
});

test('limit-burst-multiplier is used as given: 0 is no burst, a negative one rejected the Ingress', () => {
    /* The community template wrote burst=<rate × multiplier>; NGINX refuses a
       negative burst (nginx 1.31.7: invalid burst value), and NGINX Ingress
       Controller's Policy validator refuses 0, so 0 leaves burst out. */
    const policy = (mult) => kinds(run(ingress({ 'limit-rps': '10', 'limit-burst-multiplier': mult })), 'Policy');
    assert.equal(policy('0')[0].spec.rateLimit.burst, undefined);
    assert.equal(run(ingress({ 'limit-rps': '10', 'limit-burst-multiplier': '0' }), 'annotation').docs[0].metadata.annotations['nginx.org/limit-req-burst'], undefined);
    assert.equal(policy('-1').length, 0);
    assert.match(notes(run(ingress({ 'limit-rps': '10', 'limit-burst-multiplier': '-1' }))), /negative burst, which NGINX refuses, so it rejected this Ingress/);
    assert.equal(policy('3')[0].spec.rateLimit.burst, 30);
});

test('session-cookie annotations without affinity say so, rather than quoting "undefined"', () => {
    const n = notes(run(ingress({ 'session-cookie-name': 'x', 'affinity-mode': 'persistent' })));
    assert.doesNotMatch(n, /undefined/);
    assert.match(n, /session-cookie-name, affinity-mode without affinity: "cookie" set nothing in the community controller/);
});
