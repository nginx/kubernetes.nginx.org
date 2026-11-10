'use strict';
/* The HAProxy analyzer held to the rules analyzer.test.js holds ingress-nginx
   to: what a migration must do whatever the engine does inside. Each rule runs
   over every mapped HAProxy key under both strategies and over the samples,
   so a failure names its rule, the input, the strategy and the card.
   conversions.test.js covers the value transforms one by one. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadAnalyzer, analyze } = require('./lib/load.js');

const { source, tool, warnings } = loadAnalyzer('assets/js/migration-haproxy.js');
const Y = tool.yaml;
const mod = fs.readFileSync(path.join(ROOT, 'assets/js/migration-haproxy.js'), 'utf8');

const run = (yaml, strategy) => {
    const before = warnings.length;
    const r = analyze(source, yaml, strategy || 'crd');
    assert.deepEqual(warnings.slice(before), [], 'a translator failed');
    return Object.assign(r, { docs: JSON.parse(JSON.stringify(Y.parseAll(r.text))) });
};
const ingress = (ann) => Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: ann },
    spec: { tls: [{ hosts: ['a.example.com'], secretName: 'a-tls' }], rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
const configMap = (data) => Y.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'haproxy-kubernetes-ingress' }, data });

// A value each key accepts, so the branch that translates it runs.
const VALUES = {
    'allow-list': '10.0.0.0/8', 'deny-list': '10.1.0.0/16', whitelist: '10.0.0.0/8', blacklist: '10.1.0.0/16', 'src-ip-header': 'X-Real-IP',
    'auth-type': 'basic-auth', 'auth-secret': 'default/users', 'auth-realm': 'Members', 'server-ca': 'default/backend-ca', 'server-crt': 'default/client-crt',
    'server-proto': 'h2', 'cookie-persistence': 'SRV', 'cookie-persistence-no-dynamic': 'SRV', 'rate-limit-requests': '10', 'rate-limit-period': '1s',
    'rate-limit-size': '100k', 'rate-limit-status-code': '429', 'rate-limit-whitelist': '10.0.0.0/8', 'cors-allow-origin': 'https://a.example.com',
    'cors-allow-methods': 'GET, POST', 'cors-allow-headers': 'X-Custom', 'cors-max-age': '1m', 'request-set-header': 'X-From haproxy',
    'response-set-header': 'X-Served-By nginx', 'set-host': 'internal.example.com', 'request-capture': 'hdr(User-Agent)', 'request-capture-len': '64',
    'check-http': '/healthz', 'check-interval': '5s', 'timeout-check': '2s', 'load-balance': 'leastconn', 'scale-server-slots': '42',
    'path-rewrite': '/old/(.*) /new/\\1', 'request-redirect': 'example.com', 'request-redirect-code': '301', 'ssl-redirect-code': '301',
    'ssl-redirect-port': '8443', 'timeout-server': '30s', 'pod-maxconn': '100', 'ingress.class': 'haproxy',
    'backend-config-snippet': 'http-send-name-header x-dst-server', 'cr-backend': 'be', 'send-proxy-protocol': 'proxy-v2', 'forwarded-for': 'false',
    'route-acl': 'rand(100) lt 25',
    'syslog-server': 'address:10.0.0.1, port:514, facility:local0, level:info', 'log-format': '%ci %ST', 'log-format-tcp': '%ci', 'http-connection-mode': 'http-keep-alive',
    'global-config-snippet': 'ssl-default-bind-ciphers ECDHE\ntune.bufsize 32768', 'frontend-config-snippet': 'http-request deny if { path /x }',
    'stats-config-snippet': 'stats show-node', 'ssl-certificate': 'default/cert', 'tls-alpn': 'h2,http/1.1', 'client-ca': 'default/ca', 'proxy-protocol': '10.0.0.0/8',
    maxconn: '2000', nbthread: '4', 'hard-stop-after': '30s', 'timeout-connect': '5s', 'timeout-client': '50s', 'timeout-http-request': '5s',
    'timeout-http-keep-alive': '1m', 'timeout-queue': '5s', 'timeout-tunnel': '1h', 'timeout-client-fin': '1s', 'timeout-server-fin': '1s',
    'generate-certificates-signer': 'default/ca', 'quic-alt-svc-max-age': '60'
};
const ANNOTATIONS = [...new Set([...mod.matchAll(/'annotation:([\w.-]+)'/g)].map((m) => m[1]))];
const CONFIGMAP = [...new Set([...mod.matchAll(/'configmap:([\w.-]+)'/g)].map((m) => m[1]))].filter((k) => k !== 'tcp-services');
const value = (k) => VALUES[k] || 'true';

// Every input the rules run over: each annotation on an Ingress, each
// ConfigMap key beside one, and the three samples.
const CASES = ANNOTATIONS.map((k) => ({ label: k, yaml: ingress({ ['haproxy.org/' + k]: value(k) }), keys: [k] }))
    .concat(CONFIGMAP.map((k) => ({ label: 'ConfigMap ' + k, yaml: ingress({}) + '---\n' + configMap({ [k]: value(k) }), keys: [k] })))
    .concat(Object.keys(source.analyzer.samplePresets).map((p) => ({ label: 'sample ' + p, yaml: source.analyzer.samplePresets[p], keys: [] })));

test('the case list covers every mapped HAProxy key', () => {
    assert.ok(ANNOTATIONS.length > 50 && CONFIGMAP.length > 25, ANNOTATIONS.length + ' annotations, ' + CONFIGMAP.length + ' ConfigMap keys');
});

test('every recognised setting is named in the output, under both strategies', () => {
    /* Nothing recognised may vanish: a key is named in a generated comment, a
       note or a card — and not only as "has no translation". */
    const broken = [];
    for (const c of CASES.filter((x) => x.keys.length)) for (const strategy of ['crd', 'annotation']) {
        const r = run(c.yaml, strategy);
        const k = c.keys[0];
        const said = r.text + '\n' + JSON.stringify(r.plan.infoNotes) + JSON.stringify(r.plan.unsupported || '') + JSON.stringify(r.plan.unrecognized || '');
        if (!said.includes(k)) broken.push(c.label + ' / ' + strategy + ': not named');
        if (r.plan.infoNotes.some((n) => /no translation for it/.test(n.message) && n.code.includes(k))) broken.push(c.label + ' / ' + strategy + ': only "no translation"');
        // The catch-all for a translator that wrote nothing and said nothing.
        if (r.plan.infoNotes.some((n) => /did not say why/.test(n.message) && n.message.includes(k))) broken.push(c.label + ' / ' + strategy + ': lost (its translator wrote and said nothing)');
    }
    assert.deepEqual(broken, []);
});

test('a migrated Ingress never claims a setting it does not carry was folded in', () => {
    /* "Also applied, folded into the fields above" is a promise the YAML holds
       it. Annotation-first wrote check-interval and timeout-check into CRD
       fragments a migrated Ingress cannot carry, and said exactly that. Every
       single key, every grouped mapping together, and the samples. */
    const groups = [...mod.matchAll(/keys: \[([^\]]+)\]/g)].map((m) => [...m[1].matchAll(/'annotation:([\w.-]+)'/g)].map((x) => x[1])).filter((g) => g.length > 1);
    const inputs = CASES.concat(groups.map((g) => ({ label: g.join(' + '), yaml: ingress(Object.fromEntries(g.map((k) => ['haproxy.org/' + k, value(k)]))) })));
    const broken = [];
    for (const c of inputs) for (const strategy of ['crd', 'annotation']) {
        const r = run(c.yaml, strategy);
        r.plan.infoNotes.filter((n) => /folded into the fields above/.test(n.message)).forEach((n) => broken.push(c.label + ' / ' + strategy + ': ' + n.message));
    }
    assert.deepEqual(broken, []);
});

test('a migrated Ingress names the health-check settings no annotation carries', () => {
    /* NGINX Ingress Controller v5.7.0 takes an Ingress health check's path,
       interval and timeout from the Pods' readiness probe and nothing else
       (controller.go findProbeForPods), so each one set is named, with the
       probe field that replaces it. */
    const r = run(ingress({ 'haproxy.org/check-http': '/healthz', 'haproxy.org/check-interval': '5s', 'haproxy.org/timeout-check': '2s' }), 'annotation');
    const note = r.plan.infoNotes.find((n) => /readiness probe/.test(n.message));
    assert.ok(note, 'no health-check note');
    assert.match(note.message, /check-http, check-interval, timeout-check are not carried over/);
    assert.match(note.message, /the path, periodSeconds, timeoutSeconds on the readiness probe/);
    assert.doesNotMatch(note.message, /probe "\/"/, 'NGINX Ingress Controller adds no probe without a readiness probe');
});

test('the analyzer view keeps its promises for every setting and sample', () => {
    /* The rules analyzer.test.js holds ingress-nginx to: both sides on every
       card; a Policy card shows one mapping's settings; the export holds
       exactly the cards' resources; CRD-first replaces the Ingress and
       annotation-first keeps it (TLS passthrough is a TransportServer under both). */
    const mappingOf = {};
    for (const m of source.analyzer.mappings) for (const k of m.keys) mappingOf[k.split(':')[1]] = m;
    const kindsIn = (text) => (text.match(/^kind: (\w+)/gm) || []).map((k) => k.slice(6));
    const settingsIn = (yaml) => [...yaml.matchAll(/(?:haproxy\.(?:org|com)|ingress\.kubernetes\.io)\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    const broken = [];
    for (const c of CASES) for (const strategy of ['crd', 'annotation']) {
        const r = run(c.yaml, strategy);
        const at = c.label + ' / ' + strategy;
        const cards = r.plan.steps.flatMap((s) => s.blocks.flatMap((b) => b.items || (b.old ? [b] : [])))
            .map((it) => ({ title: it.category || it.old.title, old: it.old.yaml, kinds: kindsIn(it.new.yaml), left: settingsIn(it.old.yaml) }));
        for (const card of cards) {
            if (!card.old.trim()) broken.push('1 ' + at + ': ' + card.title + ' has an empty side');
            if (/annotations: \{\}/.test(card.old)) broken.push('1 ' + at + ': ' + card.title + ' shows an empty annotations block');
            for (const k of card.left) if (!c.yaml.includes(k)) broken.push('1 ' + at + ': ' + card.title + ' shows ' + k + ', which was not pasted');
            if (card.kinds.length === 1 && card.kinds[0] === 'Policy' && new Set(card.left.map((k) => mappingOf[k])).size > 1) broken.push('2 ' + at + ': Policy card ' + card.title + ' mixes ' + card.left.join(', '));
        }
        const shown = cards.flatMap((card) => card.kinds).sort().join(', ');
        const exported = (r.plan.export ? r.plan.export.parts : []).flatMap(kindsIn).sort().join(', ');
        if (shown !== exported) broken.push('4 ' + at + ': the cards show [' + shown + '], the export holds [' + exported + ']');
        const all = cards.flatMap((card) => card.kinds);
        if (strategy === 'crd' && all.includes('Ingress')) broken.push('5 ' + at + ': CRD-first emitted an Ingress');
        if (strategy === 'annotation' && all.includes('VirtualServer')) broken.push('5 ' + at + ': annotation-first emitted a VirtualServer');
    }
    assert.deepEqual(broken, [], 'a promise of the analyzer view broke');
});

test('generated resources pass the checks NGINX Ingress Controller applies at admission', () => {
    /* A static subset of v5.7.0's validation: one of action/splits per route,
       split weights summing to 100, a pass or proxy naming an upstream, numeric
       upstream ports, valid redirect codes, unique route paths (NGINX refuses a
       duplicate location) and no class naming HAProxy (NGINX Ingress Controller
       ignores the resource). */
    const broken = [];
    for (const c of CASES) for (const strategy of ['crd', 'annotation']) {
        for (const d of run(c.yaml, strategy).docs) {
            if (!d || d.kind !== 'VirtualServer') continue;
            const at = c.label + ' / ' + strategy + ' ' + d.metadata.name;
            const names = new Set((d.spec.upstreams || []).map((u) => u.name));
            const seen = new Set();
            for (const route of d.spec.routes || []) {
                if (seen.has(route.path)) broken.push(at + ': duplicate route ' + route.path);
                seen.add(route.path);
                if (Number(!!route.action) + Number(!!route.splits) !== 1) broken.push(at + ' ' + route.path + ': exactly one of action / splits');
                if (route.splits && route.splits.reduce((n, s) => n + s.weight, 0) !== 100) broken.push(at + ': splits do not sum to 100');
                for (const a of [route.action].concat((route.splits || []).map((s) => s.action), (route.matches || []).map((m) => m.action))) {
                    if (a && a.pass && !names.has(a.pass)) broken.push(at + ': pass ' + a.pass + ' names no upstream');
                    if (a && a.proxy && !names.has(a.proxy.upstream)) broken.push(at + ': proxy ' + a.proxy.upstream + ' names no upstream');
                    if (a && a.redirect && ![301, 302, 307, 308].includes(a.redirect.code)) broken.push(at + ': redirect code ' + a.redirect.code);
                }
            }
            for (const u of d.spec.upstreams || []) if (typeof u.port !== 'number') broken.push(at + ': upstream port ' + u.port);
            if (/haproxy/i.test(d.spec.ingressClassName || '')) broken.push(at + ': a class naming HAProxy');
        }
    }
    assert.deepEqual(broken, []);
});

test('generated YAML parses back to the same objects', () => {
    /* What the page shows, the export copies and nic-migrate writes goes
       through MigrationTool.yaml; each part must read back as emitted. */
    for (const c of CASES) for (const strategy of ['crd', 'annotation']) {
        const r = run(c.yaml, strategy);
        for (const part of (r.plan.export ? r.plan.export.parts : [])) {
            const doc = Y.parse(part);
            assert.deepEqual(JSON.parse(JSON.stringify(Y.parse(Y.stringify(doc)))), JSON.parse(JSON.stringify(doc)), c.label + ' / ' + strategy);
        }
    }
});

test('each card shows the HAProxy objects behind its own resource', () => {
    /* The VirtualServer card of the advanced sample shows the Ingress's own
       annotations, the canary Service's route-acl and the Backend the
       Service's cr-backend names — every object that shaped it — and no
       Policy's settings. */
    const r = run(source.analyzer.samplePresets.advanced);
    const items = r.plan.steps.flatMap((s) => s.blocks.flatMap((b) => b.items || (b.old ? [b] : [])));
    const vs = items.find((it) => /web-app — app\.example\.com/.test(it.category)).old.yaml;
    assert.match(vs, /haproxy\.org\/path-rewrite/);
    assert.match(vs, /name: app-canary[\s\S]*route-acl/);
    assert.match(vs, /kind: Backend/);
    assert.doesNotMatch(vs, /rate-limit|cors-|auth-secret/, 'Policy settings belong on their own cards');
    const rl = items.find((it) => /rate-limit$/.test(it.category)).old.yaml;
    assert.deepEqual(rl.match(/haproxy\.org\/[a-z-]+/g).sort(), ['haproxy.org/rate-limit-period', 'haproxy.org/rate-limit-requests', 'haproxy.org/rate-limit-status-code']);
});

/* Every mapped key, under every value that tells HAProxy's readers apart, under
   both strategies. HAProxy never rejects an Ingress over a value: it logs and
   keeps what it had, so a value it could not read must migrate to nothing, and
   what does migrate must pass NGINX Ingress Controller v5.7.0's own checks
   (internal/k8s/validation.go, pkg/apis/configuration/validation, configmaps.go).
   The analyzer used to copy "5 seconds" into proxy-read-timeout and
   "10.0.0.0/8, bogus" into an accessControl Policy, both refused. */
const SPREAD = ['', 'true', 'false', 't', '1', 'on', 'yes', 'off', '0', '-1', '5', '100abc', '5 seconds', '500us', '30s', 'x y z', 'X-H a, b', 'X-H a:b',
    '10.0.0.0/8, bogus', 'https://a.com,https://b.com', 'Cookie', 'GET,FOO', '302', 'default/name'];
const nicTime = (s) => typeof s === 'string' && s.trim() !== '' && /^(\d+y)??\s*(\d+M)??\s*(\d+w)??\s*(\d+d)??\s*(\d+h)??\s*(\d+m)??\s*(\d+s?)??\s*(\d+ms)??$/.test(s);
const nicLb = (s) => ['round_robin', 'least_conn', 'ip_hash', 'random', 'random two', 'random two least_conn', 'least_time header', 'least_time last_byte', 'least_time header inflight', 'least_time last_byte inflight'].includes(s) || /^hash \S+( consistent)?$/.test(s);
const nicAddress = (s) => /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(s) || (/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s) && s.includes(':'));
const nicHeader = /^[-A-Za-z0-9!#$%&'*+.^_`|~]+$/;
function refused(d) {
    const out = [];
    const ann = (d.metadata && d.metadata.annotations) || {};
    const check = (k, ok) => { if (k in ann && !ok(String(ann[k]))) out.push(k + '=' + ann[k]); };
    ['nginx.org/proxy-read-timeout', 'nginx.org/proxy-send-timeout', 'nginx.org/proxy-connect-timeout'].forEach((k) => check(k, nicTime));
    ['nginx.org/max-conns', 'nginx.org/max-fails'].forEach((k) => check(k, (v) => /^\d+$/.test(v)));
    check('nginx.org/lb-method', nicLb);
    ['nginx.org/ssl-redirect', 'nginx.org/redirect-to-https'].forEach((k) => check(k, (v) => /^(1|t|T|TRUE|true|True|0|f|F|FALSE|false|False)$/.test(v)));
    check('nginx.org/http-redirect-code', (v) => ['301', '302', '307', '308'].includes(v));
    check('nginx.org/limit-req-burst', (v) => /^\d+$/.test(v) && v !== '0');
    check('nginx.org/limit-req-reject-code', (v) => +v >= 400 && +v <= 599);
    ['nginx.org/proxy-set-headers', 'nginx.org/add-header'].forEach((k) => check(k, (v) => v.split(',').every((e) => nicHeader.test(e.split(':')[0].trim()))));
    // add-header splits on ":" into name, value and flag; the flag must be
    // "always" (validateAddHeaderAnnotation, v5.7.0).
    check('nginx.org/add-header', (v) => v.split(',').every((e) => { const p = e.split(':'); return p.length < 3 || (p.length === 3 && /^\s*always\s*$/i.test(p[2])); }));
    const s = d.spec || {};
    if (d.kind === 'Policy') {
        const rl = s.rateLimit;
        if (rl && (rl.burst !== undefined && !(rl.burst > 0) || rl.rejectCode < 400 || rl.rejectCode > 599)) out.push('rateLimit ' + JSON.stringify(rl));
        const ac = s.accessControl;
        if (ac) [].concat(ac.allow || [], ac.deny || []).filter((x) => !nicAddress(String(x))).forEach((x) => out.push('accessControl ' + x));
        const c = s.cors;
        if (c) {
            (c.allowHeaders || []).filter((h) => h !== '*' && (!nicHeader.test(h) || /^(cookie|host|origin|connection|referer|set-cookie|proxy-.*|sec-.*)$/i.test(h))).forEach((h) => out.push('cors header ' + h));
            (c.allowMethods || []).filter((m) => !['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'].includes(m)).forEach((m) => out.push('cors method ' + m));
            (c.allowOrigin || []).filter((o) => o !== '*' && !/^https?:\/\/[^/\s]+$/.test(o)).forEach((o) => out.push('cors origin ' + o));
        }
    }
    if (d.kind === 'VirtualServer') {
        for (const u of s.upstreams || []) {
            ['read-timeout', 'send-timeout', 'connect-timeout'].forEach((f) => { if (u[f] !== undefined && !nicTime(String(u[f]))) out.push('upstream ' + f + '=' + u[f]); });
            if (u['lb-method'] !== undefined && !nicLb(u['lb-method'])) out.push('upstream lb-method=' + u['lb-method']);
            if (u['max-conns'] !== undefined && !(u['max-conns'] >= 0)) out.push('upstream max-conns=' + u['max-conns']);
            if (u.sessionCookie && !/^[_A-Za-z0-9]+$/.test(u.sessionCookie.name)) out.push('sessionCookie.name=' + u.sessionCookie.name);
            if (u.healthCheck) ['interval', 'read-timeout'].forEach((f) => { if (u.healthCheck[f] !== undefined && !nicTime(String(u.healthCheck[f]))) out.push('healthCheck ' + f + '=' + u.healthCheck[f]); });
        }
        if (s.tls && s.tls.redirect && ![301, 302, 307, 308].includes(s.tls.redirect.code)) out.push('tls.redirect.code=' + s.tls.redirect.code);
    }
    if (d.kind === 'ConfigMap') {
        const data = d.data || {};
        ['proxy-read-timeout', 'proxy-send-timeout', 'proxy-connect-timeout', 'keepalive-timeout', 'worker-shutdown-timeout'].forEach((k) => { if (k in data && !nicTime(String(data[k]))) out.push(k + '=' + data[k]); });
        ['worker-connections', 'keepalive'].forEach((k) => { if (k in data && !/^\d+$/.test(String(data[k]))) out.push(k + '=' + data[k]); });
        if ('worker-processes' in data && !/^(\d+|auto)$/.test(String(data['worker-processes']))) out.push('worker-processes=' + data['worker-processes']);
        if ('lb-method' in data && !nicLb(data['lb-method'])) out.push('lb-method=' + data['lb-method']);
        // http-snippets reach nginx.conf unchecked: a bad time there fails the
        // reload for every resource on the controller.
        String(data['http-snippets'] || '').split('\n').forEach((l) => { const m = l.match(/^\s*(\w+_timeout)\s+(.*);$/); if (m && !nicTime(m[2])) out.push('http-snippets ' + l.trim()); });
    }
    return out;
}

test('every value of every key migrates to something NGINX Ingress Controller accepts, or to a note', () => {
    const broken = [];
    let runs = 0;
    const inputs = ANNOTATIONS.flatMap((k) => SPREAD.map((v) => ({ at: k + '="' + v + '"', yaml: ingress({ ['haproxy.org/' + k]: v }) })))
        .concat(CONFIGMAP.flatMap((k) => SPREAD.map((v) => ({ at: 'ConfigMap ' + k + '="' + v + '"', yaml: ingress({}) + '---\n' + configMap({ [k]: v }) }))));
    for (const c of inputs) for (const strategy of ['crd', 'annotation']) {
        runs++;
        const r = run(c.yaml, strategy);
        for (const d of r.docs) if (d) for (const e of refused(d)) broken.push(c.at + ' / ' + strategy + ': ' + e);
        const said = JSON.stringify(r.plan.infoNotes);
        if (/did not say why/.test(said)) broken.push(c.at + ' / ' + strategy + ': lost');
        if (/undefined|NaN|\[object Object\]/.test(r.text + said)) broken.push(c.at + ' / ' + strategy + ': undefined or NaN in the output');
    }
    assert.ok(runs > 3000, runs + ' runs');
    assert.deepEqual(broken.slice(0, 40), [], broken.length + ' problems');
});

test('each value is read as HAProxy v3.2.19 reads it', () => {
    /* The readers differ per annotation (pkg/annotations, pkg/utils): booleans
       are utils.GetBoolValue (ParseBool plus on/off/enabled/disabled, not
       "yes"), or annotations.Bool (only "true"), or input == "true"; times are
       utils.ParseTime (an int64 and one suffix, bare is milliseconds); the
       gates are the processors' own. Each row: an input, then what the
       migration must, and must not, contain. */
    const ROWS = [
        ['cors-enable yes is not a boolean: no CORS', { 'cors-enable': 'yes' }, null, /kind: Policy/],
        ['cors-enable t is true', { 'cors-enable': 't' }, /cors:/, null],
        ['cors-max-age 1500 is 1s, truncated', { 'cors-enable': 'true', 'cors-max-age': '1500' }, /maxAge: 1 /, null],
        ['an unknown CORS method voids the methods header', { 'cors-enable': 'true', 'cors-allow-methods': 'GET, FOO' }, null, /allowMethods/],
        ['ssl-redirect yes: no redirect, TLS or not', { 'ssl-redirect': 'yes' }, null, /redirect:/],
        ['ssl-redirect t: a redirect', { 'ssl-redirect': 't' }, /redirect:[\s\S]*enable: true/, null],
        ['ssl-passthrough 1: off (annotations.Bool)', { 'ssl-passthrough': '1' }, /kind: VirtualServer/, /TransportServer/],
        ['server-ssl yes: plaintext', { 'server-ssl': 'yes' }, null, /tls:\s*# server-ssl/],
        ['check t: checks on, so no max-fails 0', { check: 't' }, null, /max-fails/],
        ['check off: max-fails 0', { check: 'off' }, /max-fails: 0/, null],
        ['forwarded-for 0: false', { 'forwarded-for': '0' }, /disable-forwarded-headers/, null],
        ['auth-secret without auth-type: no authentication', { 'auth-secret': 'users' }, null, /basicAuth|basic-auth-secret/],
        ['an unset realm is Protected-Content', { 'auth-type': 'basic-auth', 'auth-secret': 'users' }, /realm: Protected-Content/, null],
        ['spaces in a realm become dashes', { 'auth-type': 'basic-auth', 'auth-secret': 'users', 'auth-realm': 'Members Only' }, /realm: Members-Only/, null],
        ['both cookie annotations: no cookie', { 'cookie-persistence': 'A', 'cookie-persistence-no-dynamic': 'B' }, null, /sessionCookie/],
        ['a bad address voids the allow-list', { 'allow-list': '10.0.0.0/8, nope' }, null, /accessControl/],
        // accessControl.go since v3.2.13: empty entries skipped (a trailing
        // comma voided the whole list before), and none at all is an error.
        ['an empty entry is skipped', { 'allow-list': '10.0.0.1,,10.0.0.2,' }, /allow:[^\n]*\n\s+- "?10\.0\.0\.1"?\n\s+- "?10\.0\.0\.2"?\n/, null],
        ['a list of no address applies none', { 'allow-list': ' , ' }, null, /accessControl/],
        ['rate-limit-requests 100r does not parse: no limit', { 'rate-limit-requests': '100r' }, null, /rateLimit/],
        ['rate-limit-requests 1: no burst field', { 'rate-limit-requests': '1' }, /rate: "?1r\/s/, /burst/],
        ['a status code HAProxy cannot send falls back to 403', { 'rate-limit-requests': '5', 'rate-limit-status-code': '302' }, /rejectCode: 403/, null],
        ['timeout-server 5 seconds: nothing', { 'timeout-server': '5 seconds' }, null, /read-timeout/],
        ['timeout-server 500us: ParseTime has no microseconds', { 'timeout-server': '500us' }, null, /read-timeout/],
        ['load-balance random is two draws', { 'load-balance': 'random' }, /lb-method: random two/, null],
        ['load-balance ROUNDROBIN is invalid, so roundrobin', { 'load-balance': 'ROUNDROBIN' }, /lb-method: round_robin/, null],
        ['pod-maxconn 100abc: nothing', { 'pod-maxconn': '100abc' }, null, /max-conns/],
        ['check false stops check-http', { check: 'false', 'check-http': '/healthz' }, null, /healthCheck/],
        ['a request-redirect-code HAProxy refuses: no redirect', { 'request-redirect': 'example.com', 'request-redirect-code': '305' }, null, /redirect:\s*\n\s*url/]
    ];
    const broken = [];
    for (const [label, ann, want, not] of ROWS) {
        const r = run(ingress(Object.fromEntries(Object.entries(ann).map(([k, v]) => ['haproxy.org/' + k, v]))), 'crd');
        if (want && !want.test(r.text)) broken.push(label + ': missing ' + want);
        if (not && not.test(r.text)) broken.push(label + ': has ' + not);
        if (!r.plan.infoNotes.some((n) => Object.keys(ann).some((k) => n.code.includes(k) || n.message.includes(k))) && !want) broken.push(label + ': says nothing');
    }
    const cm = (data) => run(ingress({}) + '---\n' + configMap(data), 'crd');
    if (/basicAuth|ingressMTLS/.test(cm({ 'client-crt-optional': 'true' }).text)) broken.push('client-crt-optional without client-ca made a Policy');
    if (!/verifyClient: "?on/.test(cm({ 'client-ca': 'ca', 'client-crt-optional': '1' }).text)) broken.push('client-crt-optional 1 relaxed verification (annotations.Bool)');
    if (/client_\w+_timeout 5 seconds/.test(cm({ 'timeout-client': '5 seconds' }).text)) broken.push('timeout-client 5 seconds reached http-snippets');
    if (/worker-connections/.test(cm({ maxconn: 'lots' }).text)) broken.push('maxconn lots reached nginx-config');
    assert.deepEqual(broken, []);
});

test('a backend checked with server-ca names the certificate name NGINX checks', () => {
    /* HAProxy's server-ca verifies the chain only (service/ca.go: verify
       required, no verifyhost). NGINX with verifyServer also checks the name
       against proxy_ssl_name, $proxy_host unless sslName is set — the
       VirtualServer upstream name, which no certificate carries. */
    const r = run(ingress({ 'haproxy.org/server-ca': 'default/backend-ca' }), 'crd');
    assert.match(r.text, /sslName: web\.default\.svc|sslName: web\.svc/);
    assert.ok(r.plan.infoNotes.some((n) => /checks its name/.test(n.message)), 'the name check is called out');
});

/* ------------------------------------------------- v3.2.19: decided on the walk */

const doc = (o) => Y.stringify(o);
const svc = (name, ann) => doc({ apiVersion: 'v1', kind: 'Service', metadata: { name, annotations: ann || {} }, spec: { ports: [{ port: 443 }] } });
const ing = (name, host, paths, ann, extra) => doc(Object.assign({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: Object.assign({ name, annotations: ann || {} }, extra && extra.metadata) },
    { spec: Object.assign({ rules: [{ host, http: { paths: paths.map(([p, s]) => ({ path: p, pathType: 'Prefix', backend: { service: { name: s, port: { number: 443 } } } })) } }] }, extra && extra.spec) }));
const kinds = (r, k) => r.docs.filter((d) => d && d.kind === k);
const said = (r, re) => r.plan.infoNotes.some((n) => re.test(n.message));

test('ssl-passthrough is read per path, from the Service first (v3.2.19)', () => {
    /* ingress.SSLPassthroughEnabled: the Service a path routes to, then the
       Ingress, then the ConfigMap. 3.2.12 read the Ingress and ConfigMap only,
       so a Service's annotation did nothing and the analyzer followed. */
    const r = run([svc('tls-app', { 'haproxy.org/ssl-passthrough': 'true' }), ing('app', 'a.example.com', [['/', 'tls-app']])].join('---\n'));
    assert.equal(kinds(r, 'TransportServer').length, 1, 'a Service-level ssl-passthrough is a TransportServer');
    assert.equal(kinds(r, 'VirtualServer').length, 0);
    // The Service's "false" wins over the Ingress's "true".
    const off = run([svc('web', { 'haproxy.org/ssl-passthrough': 'false' }), ing('app', 'a.example.com', [['/', 'web']], { 'haproxy.org/ssl-passthrough': 'true' })].join('---\n'));
    assert.equal(kinds(off, 'TransportServer').length, 0, 'the Service value overrides the Ingress one');
    assert.equal(kinds(off, 'VirtualServer').length, 1);
});

test('one Ingress can hold passthrough and HTTP hosts', () => {
    /* Per path, so per host here: a.example.com to a TLS-terminating Service
       is a TransportServer, b.example.com stays a VirtualServer. */
    const two = doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'mix' }, spec: { rules: [
        { host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'tls-app', port: { number: 443 } } } }] } },
        { host: 'b.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 443 } } } }] } }] } });
    const r = run([svc('tls-app', { 'haproxy.org/ssl-passthrough': 'true' }), svc('web'), two].join('---\n'));
    assert.deepEqual(kinds(r, 'TransportServer').map((d) => d.spec.host), ['a.example.com']);
    assert.deepEqual(kinds(r, 'VirtualServer').map((d) => d.spec.host), ['b.example.com']);
    // A host with a passthrough path and an HTTP path: HAProxy keyed the sni
    // map on the host, so all its TLS went to the passthrough backend.
    const mixed = run([svc('tls-app', { 'haproxy.org/ssl-passthrough': 'true' }), svc('web'), ing('m', 'a.example.com', [['/', 'tls-app'], ['/api', 'web']])].join('---\n'));
    assert.equal(kinds(mixed, 'TransportServer').length, 1);
    assert.equal(kinds(mixed, 'VirtualServer').length, 0, 'NGINX Ingress Controller gives a host to one resource');
    assert.ok(said(mixed, /also has HTTP paths \(\/api\)/), 'the HTTP path left behind is named');
});

test('allow-list and deny-list on a passthrough Ingress reach the TransportServer', () => {
    /* The ssl frontend enforced them: rules/reqDeny.go renders tcp-request
       content reject in tcp mode, scoped by txn.sni_match (3.2.12 too). The
       analyzer listed them as never applying and dropped them. On NGINX
       Ingress Controller they are serverSnippets: verified on nginx 1.31.7
       behind the passthrough listener's PROXY protocol, 10.5.5.5 admitted,
       10.1.2.3 and 192.168.1.9 refused, all three admitted without them. */
    const r = run(ing('pt', 'a.example.com', [['/', 'tls-app']], { 'haproxy.org/ssl-passthrough': 'true', 'haproxy.org/allow-list': '10.0.0.0/8', 'haproxy.org/deny-list': '10.1.2.3' }));
    const ts = kinds(r, 'TransportServer');
    assert.equal(ts.length, 1);
    assert.equal(ts[0].spec.serverSnippets, 'deny 10.1.2.3;\nallow 10.0.0.0/8;\ndeny all;\n');
    assert.ok(!said(r, /never applied to passthrough traffic: .*allow-list/), 'not reported as idle');
    assert.ok(said(r, /-enable-snippets/));
    const only = run(ing('pt', 'a.example.com', [['/', 'tls-app']], { 'haproxy.org/ssl-passthrough': 'true', 'haproxy.org/deny-list': '192.0.2.0/24' }));
    assert.equal(kinds(only, 'TransportServer')[0].spec.serverSnippets, 'deny 192.0.2.0/24;\n');
});

test('a passthrough backend keeps the backend settings HAProxy applies in tcp mode', () => {
    /* getBackendModel runs Backend() in tcp mode too: load-balance, pod-maxconn
       and timeout-server shape the passthrough backend. */
    const r = run(ing('pt', 'a.example.com', [['/', 'tls-app']], { 'haproxy.org/ssl-passthrough': 'true', 'haproxy.org/load-balance': 'leastconn', 'haproxy.org/pod-maxconn': '50', 'haproxy.org/timeout-server': '30s' }));
    const ts = kinds(r, 'TransportServer')[0];
    assert.equal(ts.spec.upstreams[0].loadBalancingMethod, 'least_conn');
    assert.equal(ts.spec.upstreams[0].maxConns, 50);
    assert.equal(ts.spec.sessionParameters.timeout, '30s');
    // source has no ip_hash in a TransportServer: a hash on the client address.
    const src = run(ing('pt', 'a.example.com', [['/', 'tls-app']], { 'haproxy.org/ssl-passthrough': 'true', 'haproxy.org/load-balance': 'source' }));
    assert.equal(kinds(src, 'TransportServer')[0].spec.upstreams[0].loadBalancingMethod, 'hash $remote_addr consistent');
});

test('a backend shared by two Ingresses is the first one\'s (v3.2.19)', () => {
    /* handlePath: the first Ingress to route to a backend, by creation time
       then name, constitutes it. A later one in the same mode is routed but
       its own backend annotations are dropped; in the other mode it gets no
       route at all. */
    const older = ing('a-first', 'a.example.com', [['/', 'web']], { 'haproxy.org/load-balance': 'leastconn' });
    const newer = ing('b-second', 'b.example.com', [['/', 'web']], { 'haproxy.org/load-balance': 'source', 'haproxy.org/pod-maxconn': '10' });
    const r = run([svc('web'), older, newer].join('---\n'));
    const vs = kinds(r, 'VirtualServer');
    const lb = (host) => vs.find((d) => d.spec.host === host).spec.upstreams[0]['lb-method'];
    assert.equal(lb('a.example.com'), 'least_conn');
    assert.equal(lb('b.example.com'), undefined, 'the second Ingress\'s load-balance never applied');
    assert.ok(said(r, /did not apply this Ingress's load-balance, pod-maxconn to Service web: Ingress a-first/));
    // creationTimestamp decides before the name does.
    const aged = run([svc('web'), ing('a-first', 'a.example.com', [['/', 'web']], { 'haproxy.org/load-balance': 'leastconn' }, { metadata: { creationTimestamp: '2026-01-02T00:00:00Z' } }),
        ing('b-second', 'b.example.com', [['/', 'web']], { 'haproxy.org/load-balance': 'source' }, { metadata: { creationTimestamp: '2026-01-01T00:00:00Z' } })].join('---\n'));
    assert.equal(kinds(aged, 'VirtualServer').find((d) => d.spec.host === 'b.example.com').spec.upstreams[0]['lb-method'], 'ip_hash');
    // The other mode: no route.
    const split = run([svc('web'), ing('a-first', 'a.example.com', [['/', 'web']]), ing('b-second', 'b.example.com', [['/', 'web']], { 'haproxy.org/ssl-passthrough': 'true' })].join('---\n'));
    assert.equal(kinds(split, 'TransportServer').length, 0);
    assert.ok(said(split, /did not route b\.example\.com\/ to Service web at all/));
    // standalone-backend gives the second its own backend.
    const own = run([svc('web'), older, ing('b-second', 'b.example.com', [['/', 'web']], { 'haproxy.org/load-balance': 'source', 'haproxy.org/standalone-backend': 'true' })].join('---\n'));
    assert.equal(kinds(own, 'VirtualServer').find((d) => d.spec.host === 'b.example.com').spec.upstreams[0]['lb-method'], 'ip_hash');
});

test('the frontends\' default backend is the lowest Ingress by namespace/name (v3.2.19)', () => {
    /* default_backend.go pickDefaultBackend; 3.2.12 let the last Ingress
       processed win, in Go map order. */
    const withDefault = (name) => doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name }, spec: { defaultBackend: { service: { name: name + '-svc', port: { number: 80 } } } } });
    const r = run([withDefault('zeta'), withDefault('alpha')].join('---\n'), 'annotation');
    assert.ok(said(r, /HAProxy ignored this spec\.defaultBackend: .* alpha\./), 'the loser names the winner');
});

test('CRD-first keeps an Ingress where only an Ingress carries a setting', () => {
    /* CRD by default, an Ingress where a setting has no CRD form: a rule with
       no host (a VirtualServer needs one) and spec.defaultBackend (a
       VirtualServer has none) keep the Ingress, as annotation-first builds
       it, and say why. An ordinary Ingress still becomes a VirtualServer. */
    const rules = (host) => [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }];
    const doc = (spec) => Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app' }, spec });
    const kinds = (r) => [...new Set((r.text.match(/^kind: \w+/gm) || []).map((k) => k.slice(6)))];
    const kept = (r) => r.plan.infoNotes.some((n) => /Kept as an Ingress under CRD-first/.test(n.message) && n.severity === 'warning');
    for (const spec of [{ rules: rules(undefined) }, { defaultBackend: { service: { name: 'err', port: { number: 80 } } }, rules: rules('a.example.com') }]) {
        const r = run(doc(spec), 'crd');
        assert.deepEqual(kinds(r), ['Ingress'], JSON.stringify(spec));
        assert.ok(kept(r), 'the reason is a warning');
    }
    const plain = run(doc({ rules: rules('a.example.com') }), 'crd');
    assert.deepEqual(kinds(plain), ['VirtualServer']);
    assert.ok(!kept(plain));
});

test('a Backend CR carries what HAProxy did with it: checks, retry_on, cookie, TLS', () => {
    /* Each read from HAProxy 3.2 (configuration.txt, DEF_CHKINTR/RISETIME/
       FALLTIME 2000/2/3) and NGINX Ingress Controller 5.7.0's fields. */
    const cr = (spec) => Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: 'Backend', metadata: { name: 'b' }, spec });
    const ing = Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: { 'haproxy.org/cr-backend': 'b' } },
        spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const up = (spec) => { const r = run(cr(spec) + '---\n' + ing); return { r, u: r.docs.find((d) => d.kind === 'VirtualServer').spec.upstreams[0] }; };
    // default_server check: an NGINX Plus healthCheck with HAProxy's defaults.
    assert.deepEqual(up({ adv_check: 'httpchk', httpchk_params: { uri: '/healthz' }, default_server: { check: 'enabled' } }).u.healthCheck,
        { enable: true, path: '/healthz', interval: '2s', fails: 3, passes: 2 });
    assert.equal(up({ httpchk_params: { uri: '/x' } }).u.healthCheck, undefined, 'no check enabled, no probes');
    // retry_on replaces HAProxy's default conn-failure.
    assert.equal(up({ retries: 2, retry_on: '502 503 504' }).u['next-upstream'], 'http_502 http_503 http_504');
    assert.equal(up({ retry_on: 'conn-failure response-timeout junk-response' }).u['next-upstream'], 'error timeout invalid_header');
    // Cookie attributes HAProxy wrote.
    assert.deepEqual(up({ cookie: { name: 'S', httponly: true, secure: true, domain: [{ value: 'example.com' }] } }).u.sessionCookie,
        { enable: true, name: 'S', path: '/', httpOnly: true, secure: true, domain: 'example.com' });
    // default_server ssl/verify/sni: tls.enable and an egressMTLS Policy.
    const t = up({ default_server: { ssl: 'enabled', verify: 'required', sni: 'req.hdr(host)' } });
    assert.deepEqual(t.u.tls, { enable: true });
    const em = t.r.docs.find((d) => d.kind === 'Policy').spec.egressMTLS;
    assert.equal(em.verifyServer, true);
    assert.equal(em.sslName, 'a.example.com', 'req.hdr(host) on a one-host Ingress is that host');
});

test('the controller settings HAProxy read become NGINX settings that load', () => {
    const cmap = (data) => configMap(data) + '---\n' + ingress({});
    const g = (spec, kind) => Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: kind || 'Global', metadata: { name: 'g' }, spec })
        + '---\n' + configMap({ ['cr-' + (kind || 'Global').toLowerCase()]: 'g' }) + '---\n' + ingress({});
    const cm = (r) => (r.docs.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'nginx-config') || { data: {} }).data;
    // nginx refuses a directive twice: client_header_timeout is
    // timeout-http-request's when both are set.
    for (const r of [run(cmap({ 'timeout-client': '30s', 'timeout-http-request': '5s' })), run(g({ client_timeout: 30000, http_request_timeout: 5000 }, 'Defaults'))]) {
        const lines = cm(r)['http-snippets'].trim().split('\n');
        assert.equal(lines.filter((l) => /^client_header_timeout/.test(l)).length, 1, lines.join(' | '));
        assert.ok(lines.includes('client_header_timeout 5s;'), lines.join(' | '));
    }
    // log-format tokens with an NGINX variable; %B is every byte sent.
    assert.equal(cm(run(cmap({ 'log-format': '%ci:%cp [%tr] %ST %B' })))['log-format'], '$remote_addr:$remote_port [$time_local] $status $bytes_sent\n');
    // Defaults compression: gzip of the listed types, proxied responses included.
    assert.match(cm(run(g({ compression: { algorithms: ['gzip'], types: ['text/html'] } }, 'Defaults')))['http-snippets'], /gzip on;\ngzip_proxied any;\ngzip_types text\/html;/);
    // Global: hard_stop_after, not grace, is the drain cap.
    assert.equal(cm(run(g({ hard_stop_after: 1800000, grace: 30000 })))['worker-shutdown-timeout'], '30m');
    const b = cm(run(g({ ssl_options: { default_bind_options: 'ssl-min-ver TLSv1.2 prefer-client-ciphers no-tls-tickets' } })));
    assert.equal(b['ssl-protocols'], 'TLSv1.2 TLSv1.3');
    assert.equal(b['ssl-prefer-server-ciphers'], 'false');
    assert.match(b['http-snippets'], /ssl_session_tickets off;/);
    assert.equal(cm(run(g({ nbthread: 4, cpu_maps: [{ process: '1/1-4', cpu_set: '0-3' }] })))['worker-cpu-affinity'], '0001 0010 0100 1000');
    assert.equal(cm(run(g({ log_target_list: [{ address: '10.0.0.1:514', facility: 'local0', level: 'info' }] })))['access-log'], 'syslog:server=10.0.0.1:514,facility=local0,severity=info main');
});

/* ------------------------------------------- one host, one owning resource

   NGINX Ingress Controller gives a host to one resource. The HAProxy module
   emitted a VirtualServer (or Ingress) per HAProxy Ingress, so two HAProxy
   Ingresses on one host became two owners, the second rejected, and a
   two-host HAProxy Ingress stayed one Ingress under annotation-first. HAProxy
   itself serves every Ingress from one frontend, routing by its host and path
   maps (route.go MapRows; controller.go: exact, then prefix-exact, then the
   longest prefix) and scoping each Ingress's frontend rules to its own map
   rows (ingress.go resolveFrontendRules). v3.2.19. */

const hapIngress = (name, hosts, ann, tls) => ({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, namespace: 'prod', annotations: ann || {} },
    spec: Object.assign(tls ? { tls: [{ hosts: [hosts[0][0]], secretName: tls }] } : {}, { ingressClassName: 'haproxy',
        rules: hosts.map(([h, p, svc]) => ({ host: h, http: { paths: [{ path: p, pathType: 'Prefix', backend: { service: { name: svc || 'web', port: { number: 80 } } } }] } })) }) });
const paste = (...docs) => docs.map((d) => Y.stringify(d)).join('---\n');
const hostsOf = (d) => d.kind === 'Ingress' ? d.spec.rules.map((r) => r.host) : [d.spec.host];
const claims = (r) => {
    const by = {};
    // A TCP TransportServer owns a GlobalConfiguration listener, not a host.
    for (const d of r.docs) if (['VirtualServer', 'TransportServer', 'Ingress'].includes(d.kind)) for (const h of hostsOf(d)) if (h) (by[h] = by[h] || []).push(d.kind + '/' + d.metadata.name);
    return by;
};
const noteText = (r) => r.plan.infoNotes.map((n) => n.code + ' — ' + n.message).join('\n');

test('for any HAProxy input, no VirtualServer, Ingress or TransportServer has two hosts, and no host has two of them', () => {
    /* Every mapped HAProxy key, alone, on an HAProxy Ingress that routes a
       second host, and beside a second HAProxy Ingress on its host; both
       strategies. A TLS-passthrough host shared with HTTP routing cannot be
       merged and passes only if it warns. */
    const keys = [...new Set(source.analyzer.mappings.flatMap((m) => m.keys || []).filter((k) => /^annotation:/.test(k)).map((k) => k.slice(11)))];
    const bad = [];
    const check = (label, text, strategy) => {
        const r = run(text, strategy);
        for (const d of r.docs) if (['VirtualServer', 'TransportServer', 'Ingress'].includes(d.kind) && hostsOf(d).length > 1) bad.push(label + ' ' + strategy + ': ' + d.kind + '/' + d.metadata.name + ' has ' + hostsOf(d).join(', '));
        const warned = r.plan.infoNotes.filter((n) => n.severity === 'warning').map((n) => n.message).join('\n');
        for (const [h, list] of Object.entries(claims(r))) {
            if (list.length > 1 && !(list.some((x) => /^TransportServer\//.test(x)) && /passes .* through as TLS/.test(warned))) bad.push(label + ' ' + strategy + ': ' + h + ' is claimed by ' + list.join(', '));
        }
    };
    for (const strategy of ['crd', 'annotation']) {
        for (const p of Object.keys(source.analyzer.samplePresets)) check('preset ' + p, source.analyzer.samplePresets[p], strategy);
        for (const k of keys) {
            const ann = { ['haproxy.org/' + k]: VALUES[k] !== undefined ? VALUES[k] : 'true' };
            check(k, paste(hapIngress('app', [['a.example.com', '/']], ann, 'a-tls')), strategy);
            check(k + ' (two hosts)', paste(hapIngress('app', [['a.example.com', '/'], ['b.example.com', '/b']], ann, 'a-tls')), strategy);
            check(k + ' (shared host)', paste(hapIngress('app', [['a.example.com', '/']], ann, 'a-tls'), hapIngress('other', [['a.example.com', '/other', 'other']])), strategy);
        }
    }
    assert.deepEqual(bad, []);
});

test('HAProxy Ingresses on one host merge into one VirtualServer, each keeping its own settings (CRD-first)', () => {
    /* HAProxy scoped each Ingress's rules to its own routes; one VirtualServer
       keeps that where NGINX Ingress Controller can: upstream settings on each
       Ingress's upstreams, its Policies on its own routes. */
    const r = run(paste(
        hapIngress('shop', [['a.example.com', '/', 'web']], {}, 'a-tls'),
        hapIngress('api', [['a.example.com', '/api', 'api']], { 'haproxy.org/timeout-server': '30s', 'haproxy.org/allow-list': '10.0.0.0/8' })
    ));
    assert.deepEqual(claims(r), { 'a.example.com': ['VirtualServer/a-example-com'] });
    assert.equal(r.docs.filter((d) => d.kind === 'VirtualServerRoute').length, 0);
    const vs = r.docs.find((d) => d.kind === 'VirtualServer');
    assert.equal(vs.spec.tls.secret, 'a-tls');
    const up = (svc) => vs.spec.upstreams.find((u) => u.service === svc);
    assert.equal(up('api')['read-timeout'], '30s');
    assert.equal(up('web')['read-timeout'], undefined, 'api\'s timeout stays on api\'s upstream');
    const route = (p) => vs.spec.routes.find((x) => x.path === p);
    assert.ok(['=/api', '/api/'].every((x) => route(x).policies && route(x).policies.length), 'api\'s access control on its own routes');
    assert.equal(route('/').policies, undefined, 'and not on shop\'s');
    // HAProxy redirected only the Ingress with TLS; one resource redirects every path.
    assert.match(noteText(r), /HAProxy redirected HTTP to HTTPS on the paths of shop only; .*api's included/);
    assert.match(noteText(r), /shop, api share a\.example\.com, so they are merged into one VirtualServer.*NGINX Gateway Fabric/);
});

test('HAProxy Ingresses on one host merge into one NGINX Ingress Controller Ingress (annotation-first)', () => {
    const r = run(paste(
        hapIngress('shop', [['a.example.com', '/', 'web']], { 'haproxy.org/server-ssl': 'true' }, 'a-tls'),
        hapIngress('api', [['a.example.com', '/api', 'api']], { 'haproxy.org/timeout-server': '30s' })
    ), 'annotation');
    const ings = r.docs.filter((d) => d.kind === 'Ingress');
    assert.equal(ings.length, 1);
    // pathType Prefix /api becomes /api exactly and /api/ as a prefix, as HAProxy matches it.
    assert.deepEqual(ings[0].spec.rules[0].http.paths.map((p) => [p.path, p.pathType, p.backend.service.name]),
        [['/', 'Prefix', 'web'], ['/api', 'Exact', 'api'], ['/api/', 'Prefix', 'api']]);
    // A per-Service list keeps its Service; an Ingress-wide setting covers every
    // path, where HAProxy applied it to api's own paths.
    assert.equal(ings[0].metadata.annotations['nginx.org/ssl-services'], 'web');
    assert.match(noteText(r), /Only api sets nginx\.org\/proxy-read-timeout; .* applies to the paths of shop too, where HAProxy applied it to api's own paths/);
});

test('a path two HAProxy Ingresses route goes to the backend HAProxy kept, the one that sorts first', () => {
    /* routecollision.go: HAProxy keeps the map row whose value sorts first,
       the backend name (<namespace>_svc_<service>_<port>), whichever Ingress
       declared it first. */
    for (const strategy of ['crd', 'annotation']) {
        const r = run(paste(hapIngress('one', [['a.example.com', '/', 'zebra']]), hapIngress('two', [['a.example.com', '/', 'alpha']])), strategy);
        const d = r.docs.find((x) => x.kind === (strategy === 'crd' ? 'VirtualServer' : 'Ingress'));
        const svc = strategy === 'crd' ? d.spec.upstreams.find((u) => u.name === d.spec.routes[0].action.pass).service : d.spec.rules[0].http.paths[0].backend.service.name;
        assert.equal(svc, 'alpha', strategy);
        assert.match(noteText(r), /HAProxy kept one map row, the backend that sorts first; .*keeping two's/, strategy);
    }
});

test('an HAProxy Ingress with several hosts becomes one VirtualServer or Ingress per host, with one note', () => {
    const doc = hapIngress('shop', [['a.example.com', '/', 'web'], ['b.example.com', '/', 'web2']], { 'haproxy.org/timeout-server': '30s' }, 'ab-tls');
    for (const strategy of ['crd', 'annotation']) {
        const r = run(paste(doc), strategy);
        const routing = r.docs.filter((d) => d.kind === 'VirtualServer' || d.kind === 'Ingress');
        assert.deepEqual(routing.map((d) => hostsOf(d)), [['a.example.com'], ['b.example.com']], strategy);
        assert.equal(r.plan.infoNotes.filter((n) => /was split into one per host/.test(n.message)).length, 1, strategy + ': said once');
    }
});

test('each pathType tab of the reference row matches what the analyzer emits', () => {
    /* where.py --diff treats a route path as scaffolding, so it passed a Prefix
       tab whose regex the analyzer never emitted, and an analyzer whose plain
       /foo also matched /foobar, which HAProxy's Prefix never did (route.go). */
    const page = fs.readFileSync(path.join(ROOT, 'haproxy-migration.html'), 'utf8');
    const at = page.indexOf('<td><code>pathType</code>');
    const row = page.slice(at, page.indexOf('</div></td></tr>', at));
    const unescape = (t) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const tabs = [...row.matchAll(/data-approach="([\w-]+)">\s*<div class="comparison">\s*<div class="comparison-block old"><h4>[^<]*<\/h4><pre><code>([\s\S]*?)<\/code>[\s\S]*?comparison-block new"><h4>[^<]*<\/h4><pre><code>([\s\S]*?)<\/code>/g)];
    assert.deepEqual(tabs.map((t) => t[1]), ['exact', 'prefix', 'implementation-specific']);
    for (const [, tab, src, want] of tabs) {
        assert.equal(unescape(want), run(unescape(src), 'crd').text.replace(/^# .*\n/, ''), tab);
    }
    // And what each route matches, as HAProxy did: Prefix stops at a segment.
    const prefix = run(unescape(tabs[1][2]), 'crd').docs.find((d) => d.kind === 'VirtualServer').spec.routes.map((r) => r.path);
    assert.deepEqual(prefix, ['=/foo', '/foo/']);
});

test('the reference row for HAProxy Ingresses on one host matches what the analyzer emits', () => {
    /* The row has no HAProxy annotation, so where.py --diff cannot reach it.
       Its source block is run under each tab's strategy and compared,
       comments included; the ConfigMap the run also emits is not shown. */
    const page = fs.readFileSync(path.join(ROOT, 'haproxy-migration.html'), 'utf8');
    const at = page.indexOf('<td>Several Ingresses on one host</td>');
    const row = page.slice(at, page.indexOf('</div></td></tr>', at));
    assert.ok(at > 0, 'the row is on the page');
    const unescape = (t) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const strategy of ['crd', 'annotation']) {
        const tab = row.slice(row.indexOf('class="approach-content' + (strategy === 'crd' ? ' active' : '') + '" data-approach="' + strategy + '">'));
        const [, src] = /comparison-block old"><h4>[^<]*<\/h4><pre><code>([\s\S]*?)<\/code>/.exec(tab);
        const [, want] = /comparison-block new"><h4>[^<]*<\/h4><pre><code>([\s\S]*?)<\/code>/.exec(tab);
        const shown = unescape(want).split('\n---\n').map((d) => d.replace(/^# .*\n/, ''));
        const got = run(unescape(src), strategy).text.split('\n---\n').filter((d) => !/kind: ConfigMap/.test(d)).map((d) => d.replace(/^# .*\n/, ''));
        assert.deepEqual(shown, got, strategy);
    }
});
