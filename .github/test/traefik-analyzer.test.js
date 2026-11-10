'use strict';
/* The Traefik analyzer held to what haproxy-analyzer.test.js holds HAProxy to:
   every value of every option migrates to something NGINX Ingress Controller
   admits, or to a note, and each behaviour is read from Traefik's source
   (v3.7.17) and, where the source left it open, settled on nginx 1.31.7. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');
const { refused } = require('./lib/nic-admission.js');

const { source, tool, warnings } = loadAnalyzer('assets/js/migration-traefik.js');
const Y = tool.yaml;

const run = (yaml, strategy) => {
    const before = warnings.length;
    const r = analyze(source, yaml, strategy || 'crd');
    assert.deepEqual(warnings.slice(before), [], 'a translator failed');
    return Object.assign(r, { docs: JSON.parse(JSON.stringify(Y.parseAll(r.text))).filter(Boolean) });
};
const kinds = (r, k) => r.docs.filter((d) => d.kind === k);
// Every note a reader sees, wherever the plan puts it.
const allNotes = (plan) => (plan.prerequisites ? plan.prerequisites.items : []).concat(plan.infoNotes, plan.unchanged || [],
    plan.invalid ? plan.invalid.items.map((x) => Object.assign({ severity: 'invalid' }, x)) : [],
    plan.unsupported ? plan.unsupported.cards.map((c) => ({ code: c.code, message: c.desc, severity: 'unsupported' })) : []);
const said = (r, re) => allNotes(r.plan).some((n) => re.test(n.message));
const doc = (o) => Y.stringify(o);
// One IngressRoute on a.example.com, /api through the named middlewares, / plain.
const route = (mws, extra) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name: 'app' }, spec: Object.assign({ routes: [
    { match: 'Host(`a.example.com`) && PathPrefix(`/api`)', kind: 'Rule', middlewares: mws.map((name) => ({ name })), services: [{ name: 'web', port: 80 }] },
    { match: 'Host(`a.example.com`) && PathPrefix(`/`)', kind: 'Rule', services: [{ name: 'web', port: 80 }] }], tls: { secretName: 'a-tls' } }, extra || {}) });
const mw = (name, type, options) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: { name }, spec: { [type]: options } });
const paste = (...docs) => docs.join('---\n');
const apiRoute = (r) => (kinds(r, 'VirtualServer')[0] || { spec: { routes: [] } }).spec.routes.find((x) => /\/api/.test(x.path));

// Options of each middleware type, and values that tell Traefik's readers apart.
const OPTIONS = {
    addPrefix: { prefix: ['/v1', ''] },
    basicAuth: { secret: ['users', ''], realm: ['Members', ''] },
    buffering: { maxRequestBodyBytes: [1048576, 0, -1, 'x'], memRequestBodyBytes: [4096] },
    circuitBreaker: { expression: ['NetworkErrorRatio() > 0.5'], fallbackDuration: ['10s', '1m30s', 'x'] },
    compress: { minResponseBodyBytes: [1024, 'x'], encodings: [['gzip'], ['br', 'zstd'], ['lzw'], []] },
    errors: { status: [['500-504'], ['404', '5xx'], ['nope']], service: [{ name: 'errsvc', port: 80 }], query: ['/{status}.html'] },
    forwardAuth: { address: ['http://auth.auth.svc.cluster.local:4180/check', 'https://auth.example.com/verify', 'not a url'], authResponseHeaders: [['X-User']] },
    headers: { customRequestHeaders: [{ 'X-A': 'a, b' }, { 'X-B': '' }], customResponseHeaders: [{ 'X-C': 'x: y' }, { 'X-D': '' }], frameDeny: [true], stsSeconds: [31536000, 0, 'x'],
        accessControlAllowOriginList: [['https://a.example.com'], ['*'], ['not-an-origin']], accessControlAllowMethods: [['GET', 'FOO']], accessControlAllowHeaders: [['X-Custom', 'Cookie']], accessControlMaxAge: [100, -1] },
    inFlightReq: { amount: [10, 0, 'x'] },
    ipAllowList: { sourceRange: [['10.0.0.0/8'], ['10.0.0.0/8', 'nope'], []], rejectStatusCode: [404, 999] },
    passTLSClientCert: { pem: [true], info: [{ subject: { commonName: true } }] },
    rateLimit: { average: [10, 0, -1, 'x'], burst: [0, 1, 5, 'x'], period: ['1s', '1m', '1m30s', '-1s', 'x'] },
    redirectRegex: { regex: ['^https?://a.example.com/(.*)', '(?=x)'], replacement: ['https://b.example.com/${1}', 'https://b.example.com/'], permanent: [true, false] },
    redirectScheme: { scheme: ['https', 'http', ''], permanent: [true, false], port: ['8443'] },
    replacePath: { path: ['/new', ''] },
    replacePathRegex: { regex: ['^/old/(.*)', '[', '(?<=x)y'], replacement: ['/new/$1'] },
    retry: { attempts: [3, 1, 0, -1, 'x'], status: [['500-503'], ['418']], timeout: ['5s', 'x'], disableRetryOnNetworkError: [true] },
    stripPrefix: { prefixes: [['/api'], []] },
    stripPrefixRegex: { regex: [['/[a-z]+'], ['[']] }
};

test('every value of every middleware option migrates to something NGINX Ingress Controller admits, or to a note', () => {
    const broken = [];
    let runs = 0;
    for (const [type, opts] of Object.entries(OPTIONS)) {
        for (const [opt, values] of Object.entries(opts)) {
            for (const v of values) {
                const yaml = paste(route(['m']), mw('m', type, { [opt]: v }));
                for (const strategy of ['crd', 'annotation']) {
                    runs++;
                    let r;
                    try { r = run(yaml, strategy); } catch (e) { broken.push(type + '.' + opt + '=' + JSON.stringify(v) + ' / ' + strategy + ': ' + e.message); continue; }
                    for (const d of r.docs) for (const e of refused(d)) broken.push(type + '.' + opt + '=' + JSON.stringify(v) + ' / ' + strategy + ': ' + e);
                    // The middleware either shaped the /api route or is explained.
                    const api = apiRoute(r);
                    // A middleware can also write the /api route's upstream fields.
                    const vs = kinds(r, 'VirtualServer')[0];
                    const ups = vs ? (vs.spec.upstreams || []).filter((u) => Object.keys(u).some((k) => !['name', 'service', 'port'].includes(k))) : [];
                    const plain = api && api.action && api.action.pass && !api.policies && !api['location-snippets'] && !ups.length;
                    const noted = allNotes(r.plan).some((n) => /Middleware m\b/.test(n.code + ' ' + n.message));
                    const global = r.plan.configMap || kinds(r, 'Policy').length;
                    if (plain && !noted && !global) broken.push(type + '.' + opt + '=' + JSON.stringify(v) + ' / ' + strategy + ': did not say why');
                }
            }
        }
    }
    assert.ok(runs >= 200, runs + ' runs');
    assert.deepEqual(broken, []);
});

test('a middleware Traefik refuses to build fails its route, which migrates as nothing', () => {
    /* pkg/server/router/router.go: a buildRouterHandler error skips the router,
       so its traffic got 404. Each refusal is the middleware's own New(). */
    const REFUSED = [
        ['ipAllowList', { sourceRange: ['10.0.0.0/8', 'nope'] }],
        ['ipAllowList', { sourceRange: [] }],
        ['ipAllowList', { sourceRange: ['10.0.0.0/8'], rejectStatusCode: 999 }],
        ['addPrefix', { prefix: '' }],
        ['redirectScheme', { scheme: '' }],
        ['retry', { attempts: 0 }],
        ['retry', { attempts: 2, disableRetryOnNetworkError: true }],
        ['rateLimit', { average: 10, period: '-1s' }],
        ['replacePathRegex', { regex: '[', replacement: '/' }],
        ['replacePathRegex', { regex: '(?<=x)y', replacement: '/' }],
        ['compress', { includedContentTypes: ['text/html'], excludedContentTypes: ['text/css'] }],
        ['compress', { encodings: ['gzip'], defaultEncoding: 'br' }],
        ['compress', { includedContentTypes: ['not a type'] }],
        ['headers', {}],
        ['errors', { status: ['500'] }]
    ];
    const kept = [];
    for (const [type, o] of REFUSED) {
        const r = run(paste(route(['m']), mw('m', type, o)));
        if (apiRoute(r)) kept.push(type + ' ' + JSON.stringify(o));
        if (!said(r, /refused to build the router/)) kept.push(type + ' ' + JSON.stringify(o) + ': not explained');
        if (!kinds(r, 'VirtualServer').length) kept.push(type + ': the healthy / route was lost too');
    }
    assert.deepEqual(kept, []);
    // An empty forwardAuth address builds (NewForward does not check it).
    assert.ok(apiRoute(run(paste(route(['m']), mw('m', 'forwardAuth', { address: '' })))), 'forwardAuth without an address is not a build error');
});

test('a middleware the paste does not hold fails its route, as Traefik refuses it', () => {
    // server/middleware/middlewares.go: "middleware %q does not exist".
    const r = run(route(['ghost']));
    assert.equal(apiRoute(r), undefined);
    assert.ok(said(r, /ghost is not in the paste/));
});

test('rate-limit burst is Traefik\'s less one, with noDelay, and absent at 0', () => {
    /* Traefik's bucket holds max(burst, 1) tokens and admits that many at once
       (ratelimiter/rate_limiter.go). NGINX limit_req admits burst + 1 and
       refuses burst=0 (nginx 1.31.7: burst=1 admitted 2, burst=2 admitted 3,
       burst=0 "invalid burst value"). */
    const rl = (o) => kinds(run(paste(route(['m']), mw('m', 'rateLimit', o))), 'Policy').map((p) => p.spec.rateLimit).find(Boolean);
    assert.deepEqual([rl({ average: 10, burst: 5 }).burst, rl({ average: 10, burst: 5 }).noDelay], [4, true]);
    assert.equal(rl({ average: 10, burst: 1 }).burst, undefined, 'burst 1 admits one: no NGINX burst');
    assert.equal(rl({ average: 10, burst: 0 }).burst, undefined, 'Traefik reads burst 0 as 1');
    assert.equal(rl({ average: 10 }).burst, undefined);
    assert.equal(rl({ average: 0 }), undefined, 'average 0 is no limit (rate.Inf)');
    assert.equal(rl({ average: 100, period: '1m' }).rate, '100r/m');
    assert.equal(rl({ average: 10, period: '1m30s' }).rate !== undefined, true, 'a compound duration is a period');
});

test('inFlightReq amount 0 refused every request, and the route answers 429', () => {
    // oxy connlimit: a request is refused once the count reaches the limit,
    // so a limit of 0 refuses them all; limit_conn takes no 0.
    const r = run(paste(route(['m']), mw('m', 'inFlightReq', { amount: 0 })));
    assert.deepEqual(apiRoute(r).action, { return: { code: 429, type: 'text/plain', body: 'Too Many Requests' } });
    assert.equal(r.plan.configMap, null, 'no limit_conn_zone for a route that refuses everything');
});

test('HSTS is sent as Traefik sent it: none at stsSeconds 0, preload only when asked', () => {
    // unrolled/secure sends the header only when STSSeconds is not 0;
    // nginx.ingress.tmpl appends preload whenever nginx.org/hsts is on.
    const ing = doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: { 'traefik.ingress.kubernetes.io/router.middlewares': 'default-h@kubernetescrd' } }, spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const ann = (o) => kinds(run(paste(ing, mw('h', 'headers', o)), 'annotation'), 'Ingress')[0].metadata.annotations || {};
    assert.deepEqual(ann({ stsSeconds: 0, frameDeny: true })['nginx.org/hsts'], undefined);
    assert.ok(!/Strict-Transport-Security/.test(ann({ stsSeconds: 0, frameDeny: true })['nginx.org/add-header'] || ''));
    assert.equal(ann({ stsSeconds: 600, stsPreload: true })['nginx.org/hsts'], 'true');
    const noPreload = ann({ stsSeconds: 600 });
    assert.equal(noPreload['nginx.org/hsts'], undefined, 'nginx.org/hsts would add preload');
    assert.equal(noPreload['nginx.org/add-header'], 'Strict-Transport-Security: max-age=600: always');
});

test('redirectRegex matches the whole URL and keeps what it does not replace', () => {
    // redirect.go: rawURL is scheme://host plus the request URI, and
    // ReplaceAllString keeps the rest; checked on nginx 1.31.7.
    const snip = (o) => apiRoute(run(paste(route(['m']), mw('m', 'redirectRegex', o))))['location-snippets'];
    const full = snip({ regex: '^https?://a.example.com/old/(.*)', replacement: 'https://a.example.com/new/${1}', permanent: true });
    assert.match(full, /^set \$traefik_url \$scheme:\/\/\$host\$request_uri;$/m);
    assert.match(full, /^if \(\$traefik_url ~ "\^https\?:\/\/a\.example\.com\/old\/\(\.\*\)"\) \{ return 308 "https:\/\/a\.example\.com\/new\/\$1"; \}$/m);
    const part = snip({ regex: '/v1/', replacement: '/v2/' });
    assert.match(part, /~ "\^\(\.\*\?\)\(\?:\/v1\/\)\(\.\*\)\$"\) \{ return 307 "\$1\/v2\/\$2"; \}/);
});

test('a router with tls serves no plain HTTP, and the migration says so', () => {
    /* GetRoutersByEntryPoints puts a router with tls on the HTTPS handler
       only, whatever entry points it names: plain HTTP got 404 (seen on
       Traefik v3.7.17 in the e2e). A VirtualServer with a TLS secret serves
       plain HTTP too. An Ingress's spec.tls only loads the certificate. */
    const ir = (tls) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name: 'app' }, spec: Object.assign({ entryPoints: ['web', 'websecure'], routes: [{ match: 'Host(`a.example.com`)', kind: 'Rule', services: [{ name: 'web', port: 80 }] }] }, tls ? { tls: { secretName: 'a-tls' } } : {}) });
    assert.ok(said(run(ir(true)), /HTTPS only and answered plain HTTP with 404/));
    assert.ok(!said(run(ir(false)), /HTTPS only/));
    const ing = doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app' }, spec: { tls: [{ hosts: ['a.example.com'], secretName: 'a-tls' }], rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    assert.ok(!said(run(ing), /HTTPS only/), 'spec.tls alone leaves the router plain HTTP');
});

test('a chain is flattened, and said so, whether an IngressRoute or an Ingress names it', () => {
    const chained = paste(mw('ips', 'ipAllowList', { sourceRange: ['10.0.0.0/8'] }), mw('both', 'chain', { middlewares: [{ name: 'ips' }] }));
    const ing = doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: { 'traefik.ingress.kubernetes.io/router.middlewares': 'default-both@kubernetescrd' } }, spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    assert.ok(said(run(paste(chained, route(['both']))), /has no chain/));
    for (const strategy of ['crd', 'annotation']) assert.ok(said(run(paste(chained, ing), strategy), /has no chain/), strategy);
});

test('under annotation-first an IngressRoute is still a VirtualServer, and the migration says why', () => {
    const r = run(route([]), 'annotation');
    assert.equal(kinds(r, 'VirtualServer').length, 1);
    assert.equal(kinds(r, 'Ingress').length, 0);
    assert.ok(said(r, /IngressRoute app has no Ingress form/));
    assert.ok(!said(run(route([])), /has no Ingress form/), 'CRD-first asked for the VirtualServer');
});

test('retry attempts count the first try, as next-upstream-tries does', () => {
    // retry.go: attempts == 1 is a single call.
    const up = kinds(run(paste(route(['m']), mw('m', 'retry', { attempts: 3 }))), 'VirtualServer')[0].spec.upstreams.find((u) => u['next-upstream-tries']);
    assert.equal(up['next-upstream-tries'], 3);
});

test('service.* annotations are read from the Service, not the Ingress', () => {
    /* provider/kubernetes/ingress/kubernetes.go: parseServiceConfig(service.Annotations). */
    const ing = (ann) => doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: ann }, spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const svc = (ann) => doc({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', annotations: ann }, spec: { ports: [{ port: 80 }] } });
    const sticky = { 'traefik.ingress.kubernetes.io/service.sticky.cookie': 'true', 'traefik.ingress.kubernetes.io/service.sticky.cookie.name': 'srv' };
    const onService = kinds(run(paste(ing({}), svc(sticky))), 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(onService.sessionCookie.name, 'srv');
    const onIngress = kinds(run(paste(ing(sticky), svc({}))), 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(onIngress.sessionCookie, undefined, 'on the Ingress, Traefik never read it');
    // A value paerser cannot decode drops the Service's paths.
    const bad = run(paste(ing({}), svc({ 'traefik.ingress.kubernetes.io/service.sticky.cookie': 'yes' })));
    assert.equal(kinds(bad, 'VirtualServer').length, 0);
    assert.ok(said(bad, /could not decode service\.sticky\.cookie="yes"/));
});

test('several IngressRoutes on one host are one VirtualServer', () => {
    // NGINX Ingress Controller gives a host to one resource (pinned convention).
    const ir = (name, path, svc) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name }, spec: { routes: [{ match: 'Host(`a.example.com`) && PathPrefix(`' + path + '`)', kind: 'Rule', services: [{ name: svc, port: 80 }] }] } });
    const r = run(paste(ir('api', '/api', 'api'), ir('web', '/', 'web')));
    const vs = kinds(r, 'VirtualServer');
    assert.equal(vs.length, 1);
    assert.deepEqual(vs[0].spec.routes.map((x) => x.path).sort(), ['/', '/api']);
});

test('an annotated Ingress is a VirtualServer under CRD-first, and an Ingress where a setting needs one', () => {
    const ing = (ann) => doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: ann }, spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const plain = run(paste(ing({ 'traefik.ingress.kubernetes.io/router.middlewares': 'default-rl@kubernetescrd' }), doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: { name: 'rl', namespace: 'default' }, spec: { rateLimit: { average: 10 } } })));
    assert.equal(kinds(plain, 'Ingress').length, 0);
    assert.equal(kinds(plain, 'VirtualServer').length, 1);
    // errors proxies the page (custom-http-errors); a VirtualServer only redirects.
    const errs = run(paste(ing({ 'traefik.ingress.kubernetes.io/router.middlewares': 'errs@kubernetescrd' }), mw('errs', 'errors', { status: ['500-502'], service: { name: 'errsvc', port: 8080 } })));
    const kept = kinds(errs, 'Ingress');
    assert.equal(kept.length, 1, 'kept an Ingress under CRD-first');
    assert.equal(kept[0].metadata.annotations['nginx.org/custom-http-errors'], '500,501,502');
    assert.equal(kept[0].spec.defaultBackend.service.name, 'errsvc');
    // Annotation-first: always the Ingress.
    assert.equal(kinds(run(ing({}), 'annotation'), 'Ingress').length, 1);
});

test('passthrough with several SNIs is a TransportServer each', () => {
    const r = run(doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRouteTCP', metadata: { name: 'pt' }, spec: { routes: [{ match: 'HostSNI(`a.example.com`) || HostSNI(`b.example.com`)', services: [{ name: 'tls', port: 443 }] }], tls: { passthrough: true } } }));
    assert.deepEqual(kinds(r, 'TransportServer').map((t) => t.spec.host).sort(), ['a.example.com', 'b.example.com']);
});

test('a TLSOption Traefik refuses fails its routers; one it builds converts its names', () => {
    // buildTLSConfig (pkg/tls/tlsmanager.go) at v3.7.17, probed with go test.
    const opt = (name, spec) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'TLSOption', metadata: { name, namespace: 'default' }, spec });
    const ir = (o) => route([], { tls: Object.assign({ secretName: 'a-tls' }, o ? { options: { name: o } } : {}) });
    // An unknown cipher refuses the option, and with it every router naming it.
    const down = run(paste(ir('strict'), opt('strict', { cipherSuites: ['TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'NOPE'] })));
    assert.equal(kinds(down, 'VirtualServer').length, 0);
    assert.ok(said(down, /cipherSuites names NOPE/));
    // The default option applies to a router naming none.
    assert.equal(kinds(run(paste(ir(), opt('default', { curvePreferences: ['prime256v1'] }))), 'VirtualServer').length, 0, 'prime256v1 is not a Traefik curve name');
    // Go names become OpenSSL names; RC4 is gone from OpenSSL 3.5.
    const cm = kinds(run(paste(ir(), opt('default', { cipherSuites: ['TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305', 'TLS_RSA_WITH_RC4_128_SHA'], curvePreferences: ['CurveP521', 'secp384r1', 'X25519'] }))), 'ConfigMap')[0].data;
    assert.equal(cm['ssl-ciphers'], 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-CHACHA20-POLY1305');
    assert.match(cm['http-snippets'], /^ssl_ecdh_curve secp521r1:secp384r1:X25519;$/m);
    // An unknown version is ignored, not refused: Go's default stands in.
    const v = run(paste(ir(), opt('default', { minVersion: 'VersionTLS99', maxVersion: 'VersionTLS12' })));
    assert.equal(kinds(v, 'ConfigMap')[0].data['ssl-protocols'], 'TLSv1.2');
    // secretNames with no clientAuthType required a certificate, and the
    // host's VirtualServer takes the ingressMTLS Policy at spec level.
    const m = run(paste(ir('mtls'), opt('mtls', { clientAuth: { secretNames: ['ca-a', 'ca-b'] } })));
    const pol = kinds(m, 'Policy').find((p) => p.spec.ingressMTLS);
    assert.equal(pol.spec.ingressMTLS.verifyClient, 'on');
    assert.equal(pol.spec.ingressMTLS.clientCertSecret, 'mtls-client-ca');
    assert.deepEqual(kinds(m, 'VirtualServer')[0].spec.policies, [{ name: 'mtls-mtls' }]);
    // A verifying clientAuthType with no CA is refused.
    assert.equal(kinds(run(paste(ir('v'), opt('v', { clientAuth: { clientAuthType: 'VerifyClientCertIfGiven' } }))), 'VirtualServer').length, 0);
});

test('a ServersTransport is the egressMTLS Policy and upstream fields of the routes that name it', () => {
    const st = (spec) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'ServersTransport', metadata: { name: 'secure' }, spec });
    const ir = doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name: 'app' }, spec: { routes: [
        { match: 'Host(`a.example.com`) && PathPrefix(`/api`)', kind: 'Rule', services: [{ name: 'api', port: 443, serversTransport: 'secure' }] },
        { match: 'Host(`a.example.com`)', kind: 'Rule', services: [{ name: 'web', port: 80 }] }] } });
    const r = run(paste(ir, st({ serverName: 'api.internal', rootCAs: [{ secret: 'ca' }], minVersion: 'VersionTLS12', maxVersion: 'VersionTLS13', cipherSuites: ['TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384'], forwardingTimeouts: { dialTimeout: '5s' }, maxIdleConnsPerHost: 16 })));
    const em = kinds(r, 'Policy').find((p) => p.spec.egressMTLS).spec.egressMTLS;
    assert.equal(em.ciphers, 'ECDHE-RSA-AES256-GCM-SHA384');
    assert.equal(em.protocols, 'TLSv1.2 TLSv1.3');
    const vs = kinds(r, 'VirtualServer')[0];
    const api = vs.spec.routes.find((x) => x.path === '/api');
    assert.deepEqual(api.policies, [{ name: 'secure-egress-mtls' }], 'only the route whose service names it');
    const up = vs.spec.upstreams.find((u) => u.service === 'api');
    assert.deepEqual(up.tls, { enable: true }, 'port 443: Traefik spoke HTTPS');
    assert.equal(up['connect-timeout'], '5s');
    assert.equal(up.keepalive, 16);
    assert.equal(vs.spec.upstreams.find((u) => u.service === 'web').tls, undefined);
    // minVersion with no maxVersion: Traefik v3.7.17 discards the TLS config.
    assert.ok(said(run(paste(ir, st({ rootCAs: [{ secret: 'ca' }], minVersion: 'VersionTLS12' }))), /discards the TLS settings/));
});

test('services[] scheme, health checks and PROXY protocol carry over', () => {
    const svc = (extra) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name: 'app' }, spec: { routes: [{ match: 'Host(`a.example.com`)', kind: 'Rule', services: [Object.assign({ name: 'web', port: 8443 }, extra)] }] } });
    const up = (r) => kinds(r, 'VirtualServer')[0].spec.upstreams[0];
    assert.deepEqual(up(run(svc({ scheme: 'https' }))).tls, { enable: true });
    assert.equal(up(run(svc({}))).tls, undefined);
    // A Service port named https* is HTTPS to Traefik (parseServiceProtocol).
    const named = doc({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web' }, spec: { ports: [{ name: 'https-web', port: 8443 }] } });
    assert.deepEqual(up(run(paste(svc({}), named))).tls, { enable: true });
    // passiveHealthCheck is max_fails / fail_timeout, with Traefik's defaults.
    const p = up(run(svc({ passiveHealthCheck: {} })));
    assert.equal(p['max-fails'], 1);
    assert.equal(p['fail-timeout'], '10s');
    const h = up(run(svc({ healthCheck: { path: '/healthz', interval: '10s' } })));
    assert.deepEqual(h.healthCheck, { enable: true, path: '/healthz', interval: '10s', 'read-timeout': '5s' });
    // PROXY protocol: Traefik sends v2 by default, NGINX 1.31.4+ too with "v2".
    const tcp = (pp) => kinds(run(doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRouteTCP', metadata: { name: 't' }, spec: { entryPoints: ['mqtt'], routes: [{ match: 'HostSNI(`*`)', services: [{ name: 'mqtt', port: 1883, proxyProtocol: pp }] }] } })), 'TransportServer')[0].spec.serverSnippets;
    assert.equal(tcp({}).trim(), 'proxy_protocol v2;');
    assert.equal(tcp({ version: 1 }).trim(), 'proxy_protocol on;');
});

test('what a reader sees names each product in full', () => {
    /* The rule analyzer.test.js holds ingress-nginx to and sources.test.js
       HAProxy: "NGINX Ingress Controller" and "NGINX Open Source" in full,
       never NIC, NGF, OSS or the F5 prefix, in page copy, the mapping text, the
       analyzer's output over the presets and every middleware, and every
       string literal in the module. American spelling in all of it. */
    const fs = require('node:fs'), path = require('node:path');
    const { ROOT } = require('./lib/load.js');
    const BAD = /\b(NIC|NGF|OSS)\b|F5 NGINX Ingress Controller|behaviour|\b\w*([Nn]ormalis|[Rr]ecognis|[Oo]rganis|[Hh]onour|[Cc]olour)\w*/;
    const found = new Set();
    const walk = (o, where) => {
        if (typeof o === 'string') { if (BAD.test(o)) found.add(where + ': ' + o.match(new RegExp('.{0,40}' + BAD.source + '.{0,20}'))[0]); return; }
        if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], where);
    };
    const mod = fs.readFileSync(path.join(ROOT, 'assets/js/migration-traefik.js'), 'utf8');
    mod.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .forEach((l, i) => { for (const m of l.replace(/\/\/.*$/, '').matchAll(/'((?:[^'\\]|\\.)*)'/g)) walk(m[1], 'migration-traefik.js line ' + (i + 1)); });
    walk(source.strings, 'strings');
    walk(source.analyzer.strategies, 'strategies');
    walk(source.analyzer.mappings, 'mappings');
    const inputs = Object.values(source.analyzer.samplePresets);
    for (const [type, opts] of Object.entries(OPTIONS)) for (const [opt, values] of Object.entries(opts)) inputs.push(paste(route(['m']), mw('m', type, { [opt]: values[0] })));
    for (const y of inputs) for (const s of ['annotation', 'crd']) walk(analyze(source, y, s).plan, 'plan');
    const html = fs.readFileSync(path.join(ROOT, 'traefik-migration.html'), 'utf8').replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/g, '');
    const text = html.replace(/<[^>]+>/g, ' ') + '\n' + [...html.matchAll(/(?:aria-label|title|alt|content)="([^"]*)"/g)].map((m) => m[1]).join('\n');
    text.split('\n').forEach((l, i) => walk(l, 'traefik-migration.html text line ' + (i + 1)));
    assert.deepEqual([...found], []);
});

/* ------------------------------------------- one host, one owning resource

   NGINX Ingress Controller gives a host to one resource. Under CRD-first the
   Traefik module already built one VirtualServer per host from every
   IngressRoute and Ingress that routes it (buildHost); the Ingress forms did
   not. A two-host Traefik Ingress stayed one Ingress, two Traefik Ingresses on
   one host stayed two, and a Traefik Ingress beside an IngressRoute on its host
   gave an Ingress and a VirtualServer. Traefik built a router per Ingress rule
   with that Ingress's middlewares (kubernetes.go, v3.7.17), so its settings
   applied to its own paths. */

const trIngress = (name, hosts, ann, tls) => doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, namespace: 'prod', annotations: ann || {} },
    spec: Object.assign(tls ? { tls: [{ hosts: [hosts[0][0]], secretName: tls }] } : {}, { ingressClassName: 'traefik',
        rules: hosts.map(([h, p, svc]) => ({ host: h, http: { paths: [{ path: p, pathType: 'Prefix', backend: { service: { name: svc || 'web', port: { number: 80 } } } }] } })) }) });
const trRoute = (name, match, svc) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name, namespace: 'prod' }, spec: { entryPoints: ['web'], routes: [{ match, kind: 'Rule', services: [{ name: svc, port: 80 }] }] } });
const hostsOf = (d) => d.kind === 'Ingress' ? d.spec.rules.map((r) => r.host) : [d.spec.host];
const claims = (r) => {
    const by = {};
    // A TCP TransportServer owns a GlobalConfiguration listener, not a host.
    for (const d of r.docs) if (['VirtualServer', 'TransportServer', 'Ingress'].includes(d.kind)) for (const h of hostsOf(d)) if (h) (by[h] = by[h] || []).push(d.kind + '/' + d.metadata.name);
    return by;
};

test('for any Traefik input, no VirtualServer, Ingress or TransportServer has two hosts, and no host has two of them', () => {
    /* Every preset, and a Traefik Ingress alone, with a second host, beside a
       second Traefik Ingress on its host, and beside an IngressRoute on its
       host; both strategies. An Ingress that must stay one (the errors
       middleware, a hostless rule) beside an IngressRoute's VirtualServer
       cannot be merged, and passes only if it warns. */
    const bad = [];
    const check = (label, text, strategy) => {
        const r = run(text, strategy);
        for (const d of r.docs) if (['VirtualServer', 'TransportServer', 'Ingress'].includes(d.kind) && hostsOf(d).filter(Boolean).length > 1) bad.push(label + ' ' + strategy + ': ' + d.kind + '/' + d.metadata.name + ' has ' + hostsOf(d).join(', '));
        const warned = allNotes(r.plan).filter((n) => n.severity === 'warning').map((n) => n.message).join('\n');
        for (const [h, list] of Object.entries(claims(r))) {
            if (list.length > 1 && !/also routed by an IngressRoute, which can only be a VirtualServer, and this Ingress must stay an Ingress|passes .* through as TLS/.test(warned)) bad.push(label + ' ' + strategy + ': ' + h + ' is claimed by ' + list.join(', '));
        }
    };
    const ann = { 'traefik.ingress.kubernetes.io/router.entrypoints': 'web' };
    for (const strategy of ['crd', 'annotation']) {
        for (const p of Object.keys(source.analyzer.samplePresets)) check('preset ' + p, source.analyzer.samplePresets[p], strategy);
        check('alone', trIngress('app', [['a.example.com', '/']], ann, 'a-tls'), strategy);
        check('two hosts', trIngress('app', [['a.example.com', '/'], ['b.example.com', '/b']], ann, 'a-tls'), strategy);
        check('two Ingresses', paste(trIngress('app', [['a.example.com', '/']], ann, 'a-tls'), trIngress('other', [['a.example.com', '/other', 'other']])), strategy);
        check('Ingress + IngressRoute', paste(trIngress('app', [['a.example.com', '/']], ann), trRoute('api', 'Host(`a.example.com`) && PathPrefix(`/api`)', 'api')), strategy);
    }
    assert.deepEqual(bad, []);
});

test('Traefik Ingresses on one host merge into one NGINX Ingress Controller Ingress (annotation-first)', () => {
    const r = run(paste(
        trIngress('shop', [['a.example.com', '/', 'web']], {}, 'a-tls'),
        trIngress('api', [['a.example.com', '/api', 'api']], { 'traefik.ingress.kubernetes.io/service.serversscheme': 'https' })
    ), 'annotation');
    const ings = kinds(r, 'Ingress');
    assert.equal(ings.length, 1);
    assert.deepEqual(ings[0].spec.rules[0].http.paths.map((p) => p.backend.service.name), ['web', 'api']);
    assert.equal(ings[0].spec.tls[0].secretName, 'a-tls');
    assert.ok(said(r, /shop, api share a\.example\.com, so they are merged into one Ingress.*NGINX Gateway Fabric/));
});

test('a Traefik Ingress beside an IngressRoute on its host joins the IngressRoute\'s VirtualServer (annotation-first)', () => {
    /* An IngressRoute has no Ingress form, so its host is a VirtualServer
       under either strategy; one host, one resource. */
    const r = run(paste(trIngress('shop', [['a.example.com', '/', 'web']]), trRoute('api', 'Host(`a.example.com`) && PathPrefix(`/api`)', 'api')), 'annotation');
    assert.deepEqual(claims(r), { 'a.example.com': ['VirtualServer/a'] });
    const vs = kinds(r, 'VirtualServer')[0];
    assert.deepEqual(vs.spec.routes.map((x) => x.path).sort(), ['/', '/api']);
    assert.ok(said(r, /also routed by an IngressRoute, which can only be a VirtualServer, so this Ingress's paths join that VirtualServer/));
});

test('a Traefik Ingress with several hosts becomes one VirtualServer or Ingress per host, with one note', () => {
    for (const strategy of ['crd', 'annotation']) {
        const r = run(trIngress('shop', [['a.example.com', '/', 'web'], ['b.example.com', '/', 'web2']], {}, 'ab-tls'), strategy);
        const routing = r.docs.filter((d) => d.kind === 'VirtualServer' || d.kind === 'Ingress');
        assert.deepEqual(routing.map((d) => hostsOf(d)), [['a.example.com'], ['b.example.com']], strategy);
        assert.equal(allNotes(r.plan).filter((n) => /was split into one per host/.test(n.message)).length, 1, strategy + ': said once');
    }
});

test('Traefik Ingresses on one host merge into one VirtualServer that calls them Ingresses (CRD-first)', () => {
    /* buildHost serves Ingress routes as well as IngressRoute ones, and its
       note called every source an IngressRoute. It names each by its kind,
       and points to the per-team resources as the annotation-first note does. */
    const r = run(paste(trIngress('web', [['a.example.com', '/', 'web']]), trIngress('api', [['a.example.com', '/api', 'api']])), 'crd');
    assert.deepEqual(r.docs.filter((d) => d.kind === 'VirtualServer').map((d) => d.spec.host), ['a.example.com']);
    const note = allNotes(r.plan).find((n) => /all route this host/.test(n.message));
    assert.ok(note, 'no merge note');
    assert.match(note.message, /^Ingresses web, api all route this host/);
    assert.match(note.message, /VirtualServerRoutes or to mergeable minion Ingresses, and NGINX Gateway Fabric/);
});

test('the reference row for Traefik Ingresses on one host matches what the analyzer emits', () => {
    /* The row names no annotation of its own, so where.py --diff cannot reach
       it. Its source block runs under each tab's strategy and is compared,
       comments included. */
    const fs = require('node:fs');
    const page = fs.readFileSync(require('node:path').join(__dirname, '..', '..', 'traefik-migration.html'), 'utf8');
    const at = page.indexOf('<td>Several Ingresses on one host</td>');
    assert.ok(at > 0, 'the row is on the page');
    const row = page.slice(at, page.indexOf('</div></td></tr>', at));
    const unescape = (t) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const strategy of ['crd', 'annotation']) {
        const tab = row.slice(row.indexOf('class="approach-content' + (strategy === 'crd' ? ' active' : '') + '" data-approach="' + strategy + '">'));
        const [, src] = /comparison-block old"><h4>[^<]*<\/h4><pre><code>([\s\S]*?)<\/code>/.exec(tab);
        const [, want] = /comparison-block new"><h4>[^<]*<\/h4><pre><code>([\s\S]*?)<\/code>/.exec(tab);
        const shown = unescape(want).split('\n---\n').map((d) => d.replace(/^# .*\n/, ''));
        const got = run(unescape(src), strategy).text.split('\n---\n').map((d) => d.replace(/^# .*\n/, ''));
        assert.deepEqual(shown, got, strategy);
    }
});

test('a Traefik stripPrefix or stripPrefixRegex with nothing to strip migrates to nothing, not a crash', () => {
    /* Traefik builds either with an empty list and strips nothing (stripprefix
       and stripprefixregex New, v3.7.17). The regex form read regexes[0] and
       threw, failing the whole analysis. */
    for (const [type, opts] of [['stripPrefix', {}], ['stripPrefix', { prefixes: [] }], ['stripPrefixRegex', {}], ['stripPrefixRegex', { regex: [] }]]) {
        for (const strategy of ['crd', 'annotation']) {
            const r = run(paste(route(['m']), mw('m', type, opts)), strategy);
            const vs = kinds(r, 'VirtualServer')[0];
            assert.ok(vs, type + ' ' + strategy);
            assert.ok(!vs.spec.routes.some((x) => x.action && x.action.proxy && x.action.proxy.rewritePath), type + ' ' + strategy + ': no rewrite');
            assert.ok(said(r, /stripped nothing/) || (r.plan.unchanged || []).some((n) => /stripped nothing/.test(n.message)), type + ' ' + strategy);
        }
    }
});

test('a Prefix path stays a prefix route, and the note gives the routes strictPrefixMatching needs', () => {
    /* Traefik's PathPrefix is character-wise unless the static option
       providers.kubernetesIngress.strictPrefixMatching is on (kubernetes.go
       buildStrictPrefixMatchingRule, v3.7.17), and no paste carries static
       configuration: the route matches Traefik's default, and the note says
       what strict matching needs. The reference row shows those routes. */
    const ing = doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app' }, spec: { rules: [{ host: 'a.example.com', http: { paths: [
        { path: '/foo', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const r = run(ing);
    assert.deepEqual(kinds(r, 'VirtualServer')[0].spec.routes.map((x) => x.path), ['/foo']);
    assert.ok(said(r, /strictPrefixMatching: true, it matched \/foo and \/foo\/ only/));
    const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'traefik-migration.html'), 'utf8');
    const at = page.indexOf('<td><code>providers.kubernetesIngress.strictPrefixMatching</code></td>');
    assert.ok(at > 0, 'the row is on the page');
    const block = /comparison-block new"><h4>[^<]*<\/h4><pre><code>([\s\S]*?)<\/code>/.exec(page.slice(at))[1];
    assert.deepEqual([...block.matchAll(/^\s*- path: (\S+)/gm)].map((m) => m[1]), ['=/foo', '/foo/']);
});
