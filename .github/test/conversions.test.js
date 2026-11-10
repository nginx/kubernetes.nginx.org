'use strict';
/* Semantic conversion tests for the HAProxy source module — the value
   transforms where the two controllers' defaults or units diverge, and where
   HAProxy reads a setting from. Crafted YAML goes through the real
   parseInput/buildPlan path, and assertions read the generated documents,
   parsed, so the emitter's quoting is not what is tested. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');

const { source, tool, warnings } = loadAnalyzer('assets/js/migration-haproxy.js');
const Y = tool.yaml;

const run = (yaml, strategy) => {
    const before = warnings.length;
    const r = analyze(source, yaml, strategy || 'crd');
    assert.deepEqual(warnings.slice(before), [], 'a translator failed');
    return Object.assign(r, { docs: JSON.parse(JSON.stringify(Y.parseAll(r.text))) });
};
const kinds = (r, kind) => r.docs.filter((d) => d.kind === kind);
const notes = (r) => r.plan.infoNotes.map((n) => n.code + ' — ' + n.message).join('\n');
const ann = (r) => kinds(r, 'Ingress')[0].metadata.annotations || {};
const cm = (r) => (kinds(r, 'ConfigMap')[0] || { data: {} }).data;

function ingressWith(annotations, extra) {
    const doc = {
        apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: {} },
        spec: { rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'app-svc', port: { number: 80 } } } }] } }] }
    };
    for (const [k, v] of Object.entries(annotations)) doc.metadata.annotations[k] = v;
    return Y.stringify(Object.assign(doc, extra || {}));
}
const configMap = (data) => Y.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'haproxy-kubernetes-ingress' }, data });
const service = (name, annotations) => Y.stringify({ apiVersion: 'v1', kind: 'Service', metadata: { name, annotations }, spec: { ports: [{ port: 80 }] } });
const stream = (...docs) => docs.join('---\n');

// HAProxy's canary documentation: the main and canary Services each on a rule
// for the same host, the canary carrying route-acl.
const canary = (acl) => stream(
    Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'echo' }, spec: { rules: [{ host: 'echo.example.com', http: { paths: [
        { path: '/', pathType: 'ImplementationSpecific', backend: { service: { name: 'echo-prod', port: { number: 80 } } } },
        { path: '/', pathType: 'ImplementationSpecific', backend: { service: { name: 'echo-staging', port: { number: 80 } } } }] } }] } }),
    service('echo-staging', { 'haproxy.org/route-acl': acl }));

// rand(<range>) yields 0..range-1 (HAProxy 3.2 configuration.txt), so the
// canary percentage must use the exact matched count per operator.
test('route-acl rand(): exact canary percentages for lt/le/ge/gt', () => {
    for (const [acl, pct] of [['rand(100) lt 25', 25], ['rand(100) le 25', 26], ['rand(100) ge 25', 75], ['rand(100) gt 25', 74], ['rand(10) lt 3', 30]]) {
        const vs = kinds(run(canary(acl)), 'VirtualServer')[0];
        const route = vs.spec.routes.find((rt) => rt.splits);
        assert.ok(route, acl + ': a split route');
        assert.deepEqual(route.splits.map((s) => s.weight), [100 - pct, pct], acl);
        const up = (name) => vs.spec.upstreams.find((u) => u.name === name).service;
        assert.equal(up(route.splits[1].action.pass), 'echo-staging', acl + ': the canary leg');
    }
});

test('route-acl: a cookie test becomes a match, as in the HAProxy canary docs', () => {
    /* `cookie(staging) -m found` is the example in HAProxy's own documentation;
       the generator before the whole-Ingress rewrite reported it untranslatable. */
    const vs = kinds(run(canary('cookie(staging) -m found')), 'VirtualServer')[0];
    const m = vs.spec.routes[0].matches[0];
    assert.deepEqual(m.conditions, [{ cookie: 'staging', value: '!' }]);
    assert.equal(vs.spec.upstreams.find((u) => u.name === m.action.pass).service, 'echo-staging');
});

test('route-acl: compound/unsupported ACLs degrade to a warning, never wrong YAML', () => {
    for (const acl of ['rand(100) lt 25 !{ hdr(x) -m str y }', 'path_beg /admin', 'src 10.0.0.0/8 or src 192.168.0.0/16']) {
        const r = run(canary(acl));
        assert.ok(!/splits:|matches:/.test(r.text), acl + ': must not emit splits or matches');
        assert.match(notes(r), /not translat/i, acl + ': expected an untranslatable note');
    }
    // A route-acl Service no Ingress routes to: HAProxy builds no route for it.
    const alone = run(service('canary-svc', { 'haproxy.org/route-acl': 'path_beg /admin' }));
    assert.match(notes(alone), /not translatable/);
    assert.match(notes(alone), /No Ingress in the paste routes to this Service/);
});

test('cors: "*" methods expand without HEAD; explicit GET+HEAD drops HEAD (NIC admission rule)', () => {
    const methods = (m) => kinds(run(ingressWith({ 'haproxy.org/cors-enable': 'true', 'haproxy.org/cors-allow-methods': m })), 'Policy')[0].spec.cors.allowMethods;
    assert.ok(methods('*').includes('GET') && !methods('*').includes('HEAD'), 'wildcard expansion must not list HEAD');
    assert.ok(!methods('GET, HEAD, POST').includes('HEAD'), 'HEAD must be dropped when GET is present');
    assert.ok(methods('HEAD, OPTIONS').includes('HEAD'), 'HEAD without GET is valid and must be kept');
});

test('cors: maxAge always emitted (HAProxy default 5s vs NIC default 86400)', () => {
    assert.equal(kinds(run(ingressWith({ 'haproxy.org/cors-enable': 'true' })), 'Policy')[0].spec.cors.maxAge, 5);
});

test('syslog-server: level filters what HAProxy sent, and nginx severity is not that', () => {
    /* configuration.txt (log): level sends only messages at least as
       important, and connections are logged at info. nginx's severity= sets
       the level of each message instead, so it is never written: info and
       debug keep nginx's default, and err or warning sent no access log. */
    const log = (level) => cm(run(configMap({ 'syslog-server': `address:10.0.0.5, port:514, facility:local0, level:${level}` })))['access-log'];
    assert.equal(log('info'), 'syslog:server=10.0.0.5:514,facility=local0 main');
    assert.equal(log('debug'), 'syslog:server=10.0.0.5:514,facility=local0 main');
    assert.equal(log('err'), undefined);
    assert.equal(log('warning'), undefined);
});

test('ssl-redirect: code is always explicit, defaults to the HAProxy 302, and 303 clamps to 302', () => {
    const code = (a) => ann(run(ingressWith(a), 'annotation'))['nginx.org/http-redirect-code'];
    assert.equal(code({ 'haproxy.org/ssl-redirect': 'true' }), '302');
    assert.equal(code({ 'haproxy.org/ssl-redirect': 'true', 'haproxy.org/ssl-redirect-code': '303' }), '302');
    assert.equal(code({ 'haproxy.org/ssl-redirect': 'true', 'haproxy.org/ssl-redirect-code': '307' }), '307');
});

test('ssl-redirect: on by default with TLS, as HAProxy does, and off when set false', () => {
    /* httpsRedirect.go turns the redirect on when the Ingress has TLS and
       ssl-redirect is unset. */
    const tls = { spec: { tls: [{ hosts: ['app.example.com'], secretName: 'app-tls' }], rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'app-svc', port: { number: 80 } } } }] } }] } };
    assert.deepEqual(kinds(run(ingressWith({}, tls)), 'VirtualServer')[0].spec.tls.redirect, { enable: true, code: 302 });
    assert.equal(kinds(run(ingressWith({ 'haproxy.org/ssl-redirect': 'false' }, tls)), 'VirtualServer')[0].spec.tls.redirect, undefined);
});

test('timeout-server sets BOTH proxy-read-timeout and proxy-send-timeout', () => {
    const a = ann(run(ingressWith({ 'haproxy.org/timeout-server': '50s' }), 'annotation'));
    assert.equal(a['nginx.org/proxy-read-timeout'], '50s');
    assert.equal(a['nginx.org/proxy-send-timeout'], '50s');
    const up = kinds(run(ingressWith({ 'haproxy.org/timeout-server': '50s' })), 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(up['read-timeout'], '50s');
    assert.equal(up['send-timeout'], '50s');
});

test('HAProxy bare times are milliseconds: timeout-connect "5000" becomes 5s', () => {
    assert.equal(cm(run(configMap({ 'timeout-connect': '5000' })))['proxy-connect-timeout'], '5s');
});

test('rate-limit: requests/period convert to r/s or r/m, admit the same burst, and keep the HAProxy 403', () => {
    /* HAProxy denies past N requests per period (reqRateLimit.go, sc0_http_req_rate
       gt N) without queueing: N at once pass. burst 0 refused the second of two
       quick requests; burst N-1 with nodelay admits the same N. */
    const policy = (a) => kinds(run(ingressWith(a)), 'Policy')[0].spec.rateLimit;
    const perSecond = policy({ 'haproxy.org/rate-limit-requests': '100', 'haproxy.org/rate-limit-period': '1s', 'haproxy.org/rate-limit-status-code': '429' });
    assert.equal(perSecond.rate, '100r/s');
    assert.equal(perSecond.burst, 99);
    assert.equal(perSecond.noDelay, true);
    assert.equal(perSecond.rejectCode, 429);
    const perMinute = policy({ 'haproxy.org/rate-limit-requests': '100', 'haproxy.org/rate-limit-period': '1m' });
    assert.equal(perMinute.rate, '100r/m');
    assert.equal(perMinute.rejectCode, 403, 'unset status-code must emit the HAProxy 403 default');
    // A rateLimit Policy cannot be referenced from an Ingress: annotations instead.
    const a = ann(run(ingressWith({ 'haproxy.org/rate-limit-requests': '10' }), 'annotation'));
    assert.equal(a['nginx.org/limit-req-rate'], '10r/s');
    assert.equal(a['nginx.org/limit-req-burst'], '9');
});

// NIC stores this key's value as MainServerSSLDHParamFileContent and writes
// the file itself (configurator AddOrUpdateDHParam), so the key holds the DH
// parameters, not a path. Passing HAProxy's path straight through looks right
// and breaks the reload.
test('ssl_dh_param_file emits PEM content, never the HAProxy path', () => {
    const cr = Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: 'Global', metadata: { name: 'haproxy-global' }, spec: { ssl_options: { dh_param_file: '/etc/ssl/dhparam.pem' } } });
    const v = cm(run(stream(configMap({ 'cr-global': 'haproxy-global' }), cr)))['ssl-dhparam-file'];
    assert.match(v, /^-----BEGIN DH PARAMETERS-----\n/);
    assert.notEqual(v.trim(), '/etc/ssl/dhparam.pem', 'must not emit the path as the value');
});

test('load-balance: verified value map incl. no-equivalent fallbacks', () => {
    const lb = (v) => run(ingressWith({ 'haproxy.org/load-balance': v }), 'annotation');
    assert.equal(ann(lb('leastconn'))['nginx.org/lb-method'], 'least_conn');
    assert.equal(ann(lb('source'))['nginx.org/lb-method'], 'ip_hash');
    assert.equal(ann(lb('uri'))['nginx.org/lb-method'], 'hash $request_uri consistent');
    const first = lb('first');
    assert.equal(ann(first)['nginx.org/lb-method'], undefined, 'balance first has no NIC equivalent');
    assert.ok(first.plan.infoNotes.some((n) => /load-balance: first/.test(n.code)), 'the note names the value');
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
function snippetRules(text) {
    return String(text || '').split('\n').map((l) => l.trim().match(/^(allow|deny) (\S+);$/)).filter(Boolean).map((m) => [m[1], m[2]]);
}
function decide(rules, ip) {
    for (const [verb, who] of rules) if (who === 'all' || inRange(ip, who)) return verb === 'allow' ? 200 : 403;
    return 200;
}
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
        const a = ann(r);
        for (const name of String(a['nginx.org/policies'] || '').split(',').filter(Boolean)) server = server.concat(accessRules(policies[name] || {}));
        location = snippetRules(a['nginx.org/location-snippets']);
    }
    return decide(location.length ? location : server, ip);
}

test('allow-list beside deny-list: NGINX answers each client as HAProxy did', () => {
    /* HAProxy denies a client outside allow-list OR inside deny-list
       (reqDeny.go). NGINX Ingress Controller applies only the allow list when
       a resource references allow and deny Policies, so the denies are a
       snippet; but a deny in a location snippet beside a server-level allow
       Policy stopped the location inheriting the allow list, and every address
       outside it was let in (verified on nginx 1.31.7: 203.0.113.5 got 200).
       The test used to check only that the deny appeared. */
    const cases = [
        [{ 'haproxy.org/allow-list': '10.0.0.0/8, 192.168.0.0/16', 'haproxy.org/deny-list': '10.1.2.3,172.16.0.0/12' },
            { '10.1.2.3': 403, '10.9.9.9': 200, '192.168.1.1': 200, '172.16.0.1': 403, '203.0.113.5': 403 }],
        // A deny holding an allowed range denies all of it.
        [{ 'haproxy.org/allow-list': '10.1.0.0/16', 'haproxy.org/deny-list': '10.0.0.0/8' },
            { '10.1.5.5': 403, '10.9.9.9': 403, '203.0.113.5': 403 }],
        // A deny range that overlaps nothing allowed: allow-only blocks it.
        [{ 'haproxy.org/allow-list': '10.0.0.0/8', 'haproxy.org/deny-list': '192.168.1.1' },
            { '10.9.9.9': 200, '192.168.1.1': 403, '203.0.113.5': 403 }],
        // Either list alone.
        [{ 'haproxy.org/allow-list': '10.0.0.0/8' }, { '10.9.9.9': 200, '203.0.113.5': 403 }],
        [{ 'haproxy.org/deny-list': '10.1.2.3' }, { '10.1.2.3': 403, '203.0.113.5': 200 }]
    ];
    const broken = [];
    for (const [annotations, want] of cases) for (const strategy of ['crd', 'annotation']) {
        const r = run(ingressWith(annotations), strategy);
        for (const ip of Object.keys(want)) {
            const got = nginxAccess(r, strategy, ip);
            if (got !== want[ip]) broken.push(strategy + ' ' + JSON.stringify(annotations) + ': ' + ip + ' got ' + got + ', HAProxy ' + want[ip]);
        }
    }
    assert.deepEqual(broken, []);
});

test('5.7: server-proto h2 becomes proxy-http-version "2", on the annotation and the upstream field', () => {
    /* v5.7.0 sets the upstream HTTP version (annotations.go, http_version.go).
       Before it, generic HTTP/2 to a backend had no form at all. */
    const yaml = ingressWith({ 'haproxy.org/server-proto': 'h2' });
    assert.equal(ann(run(yaml, 'annotation'))['nginx.org/proxy-http-version'], '2');
    assert.equal(kinds(run(yaml), 'VirtualServer')[0].spec.upstreams[0]['proxy-http-version'], '2');
});

test('5.6: set-host becomes nginx.org/upstream-vhost when it is a plain hostname, a VirtualServer header otherwise', () => {
    assert.equal(ann(run(ingressWith({ 'haproxy.org/set-host': 'Internal.Example.com' }), 'annotation'))['nginx.org/upstream-vhost'], 'internal.example.com', 'lowercased, as validation requires');
    // A port fails upstream-vhost validation and would reject the Ingress:
    // annotation-first keeps the Ingress and says to switch; CRD-first sets Host.
    const port = ingressWith({ 'haproxy.org/set-host': 'internal.example.com:8080' });
    const a = run(port, 'annotation');
    assert.equal(ann(a)['nginx.org/upstream-vhost'], undefined);
    assert.match(notes(a), /CRD-first/);
    const set = kinds(run(port), 'VirtualServer')[0].spec.routes[0].action.proxy.requestHeaders.set;
    assert.deepEqual(set, [{ name: 'Host', value: 'internal.example.com:8080' }]);
});

test('a header value built from a sample fetch never lands in a literal-only annotation', () => {
    /* nginx.org/proxy-set-headers and add-header take literal values only; %[src]
       is HAProxy syntax, and a "$" makes NGINX Ingress Controller reject the Ingress. */
    const yaml = ingressWith({ 'haproxy.org/request-set-header': 'X-Client %[src]' });
    const a = run(yaml, 'annotation');
    assert.equal(ann(a)['nginx.org/proxy-set-headers'], undefined);
    assert.match(notes(a), /CRD-first/);
    const c = run(yaml);
    assert.equal(kinds(c, 'VirtualServer')[0].spec.routes[0].action.proxy.requestHeaders.set[0].name, 'X-Client');
    assert.match(notes(c), /sample fetch/, 'the rewrite is called out');
});

test('5.6: forwarded-for "false" becomes the disable-forwarded-headers ConfigMap key, with its cost named', () => {
    const r = run(ingressWith({ 'haproxy.org/forwarded-for': 'false' }));
    assert.equal(cm(r)['disable-forwarded-headers'], 'true');
    assert.ok(r.plan.infoNotes.some((n) => /global/.test(n.message) && /-enable-snippets/.test(n.message)));
});

test('cors-respond-to-options is answered by the cors Policy, not reported as unsupported', () => {
    /* The cors Policy renders "if ($request_method = 'OPTIONS') { return 204; }",
       which is what HAProxy's annotation turned on (resSetCORS.go). */
    const { plan } = run(ingressWith({ 'haproxy.org/cors-enable': 'true', 'haproxy.org/cors-respond-to-options': 'true' }));
    assert.ok(!plan.unsupported || !plan.unsupported.cards.some((c) => /respond-to-options/.test(c.code)));
    assert.ok(plan.infoNotes.some((n) => /respond-to-options/.test(n.code) && /204/.test(n.message)));
});

/* ------------------------------------------------- what HAProxy applies where */

test('a backend setting is read Service first, then Ingress, then ConfigMap, per Service', () => {
    /* service.New(): a Service's annotations, then the Ingress's, then the
       ConfigMap's (v3.2.19). Two Services resolving differently keep their own
       values; one ConfigMap value for all is the global key. */
    const two = Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: { 'haproxy.org/load-balance': 'leastconn' } }, spec: { rules: [{ host: 'app.example.com', http: { paths: [
        { path: '/a', pathType: 'Prefix', backend: { service: { name: 'svc-a', port: { number: 80 } } } },
        { path: '/b', pathType: 'Prefix', backend: { service: { name: 'svc-b', port: { number: 80 } } } }] } }] } });
    const r = run(stream(two, service('svc-a', { 'haproxy.org/load-balance': 'source' }), configMap({ 'load-balance': 'roundrobin' })));
    const ups = kinds(r, 'VirtualServer')[0].spec.upstreams;
    assert.equal(ups.find((u) => u.service === 'svc-a')['lb-method'], 'ip_hash', 'the Service wins');
    assert.equal(ups.find((u) => u.service === 'svc-b')['lb-method'], 'least_conn', 'then the Ingress');
    // Only the ConfigMap: one global key, not a field on every upstream.
    const g = run(stream(ingressWith({}), configMap({ 'load-balance': 'leastconn' })));
    assert.equal(cm(g)['lb-method'], 'least_conn');
    assert.equal(kinds(g, 'VirtualServer')[0].spec.upstreams[0]['lb-method'], undefined);
});

test('a cr-backend Backend replaces the backend annotations of the Service it is reached from', () => {
    /* getBackendModel: with a Backend CR, no backend annotation is processed. */
    const backend = Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: 'Backend', metadata: { name: 'be' }, spec: { balance: { algorithm: 'leastconn' }, server_timeout: 50000 } });
    const r = run(stream(ingressWith({}), service('app-svc', { 'haproxy.org/cr-backend': 'be', 'haproxy.org/load-balance': 'source' }), backend));
    const up = kinds(r, 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(up['lb-method'], 'least_conn', 'the Backend, not the annotation');
    assert.equal(up['read-timeout'], '50s');
    assert.match(notes(r), /HAProxy ignored load-balance/);
});

test('a Global or Defaults CR applies only when the ConfigMap names it, and then replaces its keys', () => {
    /* controller/global.go: cr-global / cr-defaults in the ConfigMap select the
       CR, which replaces the ConfigMap's Global / Defaults keys. */
    const defaults = Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: 'Defaults', metadata: { name: 'd' }, spec: { connect_timeout: 7000 } });
    const named = run(stream(configMap({ 'cr-defaults': 'd', 'timeout-connect': '3s' }), defaults));
    assert.equal(cm(named)['proxy-connect-timeout'], '7s', 'the CR replaces the ConfigMap key');
    assert.match(notes(named), /ignored the ConfigMap's timeout-connect/);
    const unnamed = run(stream(configMap({ 'timeout-connect': '3s' }), defaults));
    assert.equal(cm(unnamed)['proxy-connect-timeout'], '3s');
    assert.match(notes(unnamed), /applied to nothing/);
});

test('path-rewrite replaces the whole path where its regex matches, and leaves the rest', () => {
    /* replace-path searches the path and replaces all of it (configuration.txt
       3.2). The regex route matches only what the rule rewrites; the plain
       route carries the rest. Checked on nginx 1.31.7 with the location NGINX
       Ingress Controller renders: /app/a/b → /new/a/b, /app unchanged. */
    const two = Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: { 'haproxy.org/path-rewrite': '/app/(.*) /new/\\1' } }, spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/app', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const routes = kinds(run(two), 'VirtualServer')[0].spec.routes;
    // pathType Prefix keeps the segment boundary: /app exactly, and /app/ as a prefix.
    assert.deepEqual(routes.map((rt) => rt.path), ['~ ^(?=/app(?:/|$)).*?/app/(.*)', '=/app', '/app/']);
    assert.equal(routes[0].action.proxy.rewritePath, '/new/$1');
    // The one-field form on an Ingress: rewrite-target with no path-regex
    // replaces the whole path (rewrite "<path>" <target> break).
    const one = run(ingressWith({ 'haproxy.org/path-rewrite': '/fixed' }), 'annotation');
    assert.equal(ann(one)['nginx.org/rewrite-target'], '/fixed');
    assert.equal(ann(one)['nginx.org/path-regex'], undefined);
});

test('request-redirect without a scheme redirects to http://, as HAProxy does', () => {
    /* hostRedirect.go: SSLRequest only for an https:// value. */
    const action = (v) => kinds(run(ingressWith({ 'haproxy.org/request-redirect': v })), 'VirtualServer')[0].spec.routes[0].action.redirect;
    assert.deepEqual(action('example.com'), { url: 'http://example.com${request_uri}', code: 302 });
    assert.equal(action('https://example.com').url, 'https://example.com${request_uri}');
});

test('a class naming HAProxy is never carried over, since NGINX Ingress Controller would ignore the resource', () => {
    /* HasCorrectIngressClass: a class it does not own is skipped silently; an
       empty one is claimed. */
    const r = run(ingressWith({}, { spec: { ingressClassName: 'haproxy', rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } }));
    assert.equal(kinds(r, 'VirtualServer')[0].spec.ingressClassName, undefined);
});

/* Found by the HAProxy e2e (run-e2e.py --source haproxy), each a routing
   difference only a live comparison showed; held here without a cluster. */

test('path-rewrite routes leave longer prefixes to their own route, as HAProxy\'s path map does', () => {
    /* HAProxy picks the longest matching prefix, then rewrites. The "/" route's
       regex must not take /api requests: verified on nginx 1.31.7 and on kind. */
    const two = Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: { 'haproxy.org/path-rewrite': '/api/(.*) /\\1' } }, spec: { rules: [{ host: 'a.example.com', http: { paths: [
        { path: '/api', pathType: 'Prefix', backend: { service: { name: 'api', port: { number: 80 } } } },
        { path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const routes = kinds(run(two), 'VirtualServer')[0].spec.routes;
    const re = (r) => new RegExp(r.path.replace(/^~ /, ''));
    const api = routes.find((r) => r.action && r.action.proxy && r.action.proxy.upstream === 'api' && r.path.startsWith('~'));
    const web = routes.find((r) => r.action && r.action.proxy && r.action.proxy.upstream === 'web' && r.path.startsWith('~'));
    assert.ok(re(api).test('/api/things/42') && !re(web).test('/api/things/42'), '/api/things/42 is api\'s');
    assert.ok(re(web).test('/x/api/y') && !re(api).test('/x/api/y'), '/x/api/y is web\'s, rewritten');
});

test('a route-acl Service that is a path\'s only backend answers 404 unless its ACL matches', () => {
    /* AddCustomRoute adds no path-map entry: HAProxy's default backend answers
       the rest. Dropping the host instead lost the canary's requests. */
    const r = run(stream(
        Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app' }, spec: { rules: [{ host: 'b.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'canary', port: { number: 80 } } } }] } }] } }),
        service('canary', { 'haproxy.org/route-acl': 'hdr(X-Canary) -m str yes' })));
    const route = kinds(r, 'VirtualServer')[0].spec.routes[0];
    assert.equal(route.action.return.code, 404);
    assert.deepEqual(route.matches[0].conditions, [{ header: 'X-Canary', value: 'yes' }]);
});

test('a canary leg applies under its own path only', () => {
    /* The custom route tests { path -m beg <canary path> }: a canary on /beta
       leaves the / route alone. */
    const ing = Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app' }, spec: { rules: [{ host: 'a.example.com', http: { paths: [
        { path: '/beta', pathType: 'Prefix', backend: { service: { name: 'main', port: { number: 80 } } } },
        { path: '/beta', pathType: 'Prefix', backend: { service: { name: 'canary', port: { number: 80 } } } },
        { path: '/', pathType: 'Prefix', backend: { service: { name: 'main', port: { number: 80 } } } }] } }] } });
    const routes = kinds(run(stream(ing, service('canary', { 'haproxy.org/route-acl': 'hdr(X-Canary) -m str yes' }))), 'VirtualServer')[0].spec.routes;
    assert.ok(routes.find((r) => r.path === '=/beta').matches && routes.find((r) => r.path === '/beta/').matches, '/beta carries the canary');
    assert.equal(routes.find((r) => r.path === '/').matches, undefined, '/ does not');
});

test('a Backend CR\'s retries becomes next-upstream-tries plus one', () => {
    /* HAProxy's retries counts the attempts after the first (configuration.txt
       3.2, "retries"); NGINX's proxy_next_upstream_tries counts every attempt
       (nginx 1.31.7: tries 3 reached three servers). A one-to-one copy made
       one attempt fewer. */
    const backend = Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: 'Backend', metadata: { name: 'be' }, spec: { retries: 3 } });
    const r = run(stream(ingressWith({}), service('app-svc', { 'haproxy.org/cr-backend': 'be' }), backend));
    assert.equal(kinds(r, 'VirtualServer')[0].spec.upstreams[0]['next-upstream-tries'], 4);
});
