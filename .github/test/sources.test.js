'use strict';
/* Analyzer regression tests for every source module on the shared engine.
   Run with: node --test test/
   The load-bearing invariant is warnings.length === 0 — buildPlan wraps each
   generator in a try/catch that only console.warn()s, so a broken generator
   silently drops its resource instead of throwing. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');

const MODULES = [
    { name: 'ingress-nginx', file: 'assets/js/migration-ingress-nginx.js' },
    { name: 'haproxy', file: 'assets/js/migration-haproxy.js' },
    { name: 'traefik', file: 'assets/js/migration-traefik.js' },
];

for (const mod of MODULES) {
    test(`${mod.name}: every sample preset × strategy builds a plan with zero generator warnings`, () => {
        const { source, warnings } = loadAnalyzer(mod.file);
        for (const [presetName, yaml] of Object.entries(source.analyzer.samplePresets)) {
            for (const strategy of ['annotation', 'crd']) {
                const before = warnings.length;
                const { parsed, plan } = analyze(source, yaml, strategy);
                assert.equal(warnings.length, before,
                    `${presetName} × ${strategy} warned: ${warnings.slice(before).join(' | ')}`);
                assert.ok(parsed.foundCount > 0, `${presetName}: no findings`);
                assert.ok(plan.steps.length > 0, `${presetName} × ${strategy}: no steps`);
                assert.ok(plan.pills.length >= 2 && plan.banner && plan.liveText,
                    `${presetName} × ${strategy}: summary metadata missing`);
                assert.ok(plan.export && plan.export.parts.length > 0,
                    `${presetName} × ${strategy}: no export output`);
                for (const part of plan.export.parts) {
                    assert.ok(part && part.trim(), `${presetName} × ${strategy}: empty export part`);
                }
            }
        }
    });

    test(`${mod.name}: defines every property migration-core.js reads off MIGRATION_SOURCE`, () => {
        /* test-analyzer.js holds the contract and runs it for ingress-nginx
           only; this reads its list, so the two cannot drift, and runs it for
           every source. The end-of-life banner is optional: migration-core.js
           returns when eolCompact is absent, and only an archived source has
           one. A missing property renders a blank panel, not an error. */
        const fs = require('node:fs');
        const path = require('node:path');
        const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'test-analyzer.js'), 'utf8');
        const list = script.match(/const CONTRACT = \[([\s\S]*?)\n\];/);
        assert.ok(list, 'could not read CONTRACT out of test-analyzer.js');
        const keys = [...list[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
        assert.ok(keys.length > 20, keys.length + ' keys read');
        const OPTIONAL = /^(eolCompact\.|storage\.eolCollapsed$)/;
        const { source } = loadAnalyzer(mod.file);
        const dig = (o, k) => k.split('.').reduce((acc, p) => (acc == null ? acc : acc[p]), o);
        const missing = keys.filter((k) => !OPTIONAL.test(k) && (dig(source, k) === undefined || dig(source, k) === null));
        assert.deepEqual(missing, []);
        if (source.eolCompact) assert.ok(source.storage.eolCollapsed, 'an end-of-life banner needs its storage key');
    });

    test(`${mod.name}: empty and foreign input produce no findings and no warnings`, () => {
        const { source, warnings } = loadAnalyzer(mod.file);
        for (const input of ['', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: plain\nspec:\n  ports:\n    - port: 80']) {
            const { parsed, plan } = analyze(source, input, 'crd');
            assert.equal(parsed.foundCount, 0);
            assert.equal(plan.steps.length, 0);
        }
        assert.equal(warnings.length, 0, warnings.join(' | '));
    });
}

test('haproxy: unknown haproxy.org annotation lands in the unrecognized bucket', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: x',
        '  annotations:', '    haproxy.org/not-a-real-thing: "1"',
        'spec:', '  rules:', '    - host: a.example.com',
    ].join('\n');
    const { plan } = analyze(source, yaml, 'crd');
    assert.ok(plan.unrecognized, 'expected an unrecognized section');
    assert.equal(plan.unrecognized.items.length, 1);
});

// HAProxy applies a Global only when the controller ConfigMap names it in
// cr-global (controller/global.go), so each Global here comes with that ConfigMap.
const namingConfigMap = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: haproxy-kubernetes-ingress', 'data:', '  cr-global: g', '---'];

test('haproxy: v1 CRD spec.config unwraps and maps Global fields', () => {
    const { source, warnings } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = namingConfigMap.concat([
        'apiVersion: ingress.v1.haproxy.org/v1', 'kind: Global', 'metadata:', '  name: g',
        'spec:', '  config:', '    maxconn: 5000', '    nbthread: 4',
    ]).join('\n');
    const { parsed, plan, text } = analyze(source, yaml, 'crd');
    assert.equal(warnings.length, 0, warnings.join(' | '));
    assert.equal(parsed.foundCount, 2, 'the Global and the cr-global key');
    assert.match(text, /worker-connections: "?5000/);
    assert.match(text, /worker-processes: "?4/);
    // v1 group warning surfaces to the user: the page shows parse warnings
    // beside the plan's, as for ingress-nginx.
    assert.ok(parsed.warnings.some((w) => /ingress\.v1\.haproxy\.org/.test(w.title)));
    assert.ok(plan.steps.length > 0);
});

test('haproxy: v3 Global CRD unwraps nested performance/ssl options', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const global = [
        'apiVersion: ingress.v3.haproxy.org/v3', 'kind: Global', 'metadata:', '  name: g',
        'spec:', '  nbthread: 4',
        '  performance_options:', '    maxconn: 40000',
        '  ssl_options:', '    default_bind_ciphers: ECDHE-RSA-AES256-GCM-SHA384',
    ];
    const { text } = analyze(source, namingConfigMap.concat(global).join('\n'), 'crd');
    assert.match(text, /worker-connections: "?40000/);
    assert.match(text, /ssl-ciphers: "?ECDHE-RSA-AES256-GCM-SHA384/);
    // Pasted without the ConfigMap that names it, HAProxy applied it to nothing.
    const alone = analyze(source, global.join('\n'), 'crd');
    assert.doesNotMatch(alone.text, /worker-connections/);
    assert.ok(alone.plan.infoNotes.some((n) => /applied to nothing/.test(n.message)));
});

test('haproxy: tcp-services ConfigMap becomes GlobalConfiguration + TransportServer per entry', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: tcp-services', '  namespace: default',
        'data:', '  "5432": "databases/postgres:5432"',
    ].join('\n');
    const { text } = analyze(source, yaml, 'crd');
    assert.match(text, /kind: GlobalConfiguration/);
    assert.match(text, /protocol: TCP/);
    assert.match(text, /kind: TransportServer/);
    assert.match(text, /service: postgres/);
});

test('haproxy: ssl-passthrough emits a TLS_PASSTHROUGH TransportServer', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: pt',
        '  annotations:', '    haproxy.org/ssl-passthrough: "true"',
        'spec:', '  rules:', '    - host: pt.example.com', '      http:', '        paths:',
        '          - path: /', '            pathType: Prefix', '            backend:',
        '              service:', '                name: pt-svc', '                port:', '                  number: 443',
    ].join('\n');
    const { text } = analyze(source, yaml, 'crd');
    assert.match(text, /TLS_PASSTHROUGH/);
    assert.match(text, /host: pt\.example\.com/);
});

test('haproxy: hard no-equivalents surface as unsupported cards, not silently dropped', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: u',
        '  annotations:',
        '    haproxy.org/send-proxy-protocol: "proxy-v2"',
        '    haproxy.org/rate-limit-whitelist: "10.0.0.0/8"',
        'spec:', '  rules:', '    - host: u.example.com',
        // quic-alt-svc-max-age is read from the ConfigMap only (handler/quic.go).
        '---', 'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: haproxy-kubernetes-ingress',
        'data:', '  quic-alt-svc-max-age: "60"',
    ].join('\n');
    const { plan } = analyze(source, yaml, 'crd');
    assert.ok(plan.unsupported, 'expected unsupported section');
    assert.equal(plan.unsupported.cards.length, 2);
});

test('haproxy: rate-limit-whitelist reaches the rate-limit translator, which says how to exempt the addresses', () => {
    /* It had a mapping of its own, typed unsupported, so the rateLimit
       translator never saw it: its notes (the geo map workaround, an
       invalid address, no rate-limit-requests to exempt from) could not
       fire, and a reader got only the generic card. */
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const ing = (ann) => ['apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: rl', '  annotations:',
        ...ann.map((a) => '    ' + a), 'spec:', '  rules:', '    - host: rl.example.com'].join('\n');
    for (const strategy of ['crd', 'annotation']) {
        const text = (y) => JSON.stringify(analyze(source, y, strategy).plan);
        assert.match(text(ing(['haproxy.org/rate-limit-requests: "10"', 'haproxy.org/rate-limit-whitelist: "10.0.0.0/8"'])),
            /no rate-limit exemption list\. To keep 10\.0\.0\.0\/8 unlimited, key the limit on a geo map/, strategy);
        assert.match(text(ing(['haproxy.org/rate-limit-requests: "10"', 'haproxy.org/rate-limit-whitelist: "office"'])),
            /rate-limit-whitelist holds \\"office\\", which is not an IP address or CIDR/, strategy);
        assert.match(text(ing(['haproxy.org/rate-limit-whitelist: "10.0.0.0/8"'])),
            /so rate-limit-whitelist was inactive/, strategy);
    }
});

test('haproxy: what a reader sees names each product in full', () => {
    /* The same rule as analyzer.test.js holds for ingress-nginx: page copy and
       analyzer output say "NGINX Ingress Controller", never "NIC" or the F5
       prefix, since the HAProxy controller is always in play too. The module
       does not export its mapping table, so every key it lists goes through
       the analyzer as an annotation or a ConfigMap entry, plus the presets. */
    const fs = require('node:fs'), path = require('node:path');
    const { ROOT } = require('./lib/load.js');
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    // Page copy and analyzer output are American English (AGENTS.md). A bare
    // OSS is out too: NGINX Open Source in full, and HAProxy's own edition is
    // the community controller. This list copied the ingress-nginx one before
    // it learned OSS, and 27 sat on the page unseen.
    const BAD = /\b(NIC|NGF|OSS)\b|F5 NGINX Ingress Controller|behaviour|\b\w*([Nn]ormalis|[Rr]ecognis|[Oo]rganis|[Hh]onour|[Cc]olour)\w*/;
    const found = new Set();
    const walk = (o, where) => {
        if (typeof o === 'string') { if (BAD.test(o)) found.add(where + ': ' + o.match(new RegExp('.{0,40}' + BAD.source + '.{0,20}'))[0]); return; }
        if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], where);
    };
    const mod = fs.readFileSync(path.join(ROOT, 'assets/js/migration-haproxy.js'), 'utf8');
    const keys = [...mod.matchAll(/'(annotation|configmap):([\w.-]+)'/g)].map((m) => [m[1], m[2]]);
    assert.ok(keys.length > 60, 'mapping keys found: ' + keys.length);
    const backend = ['spec:', '  tls:', '    - hosts: [a.example.com]', '      secretName: a-tls', '  rules:', '    - host: a.example.com',
        '      http:', '        paths:', '          - path: /', '            pathType: Prefix', '            backend:',
        '              service:', '                name: web', '                port:', '                  number: 80'];
    const inputs = Object.values(source.analyzer.samplePresets).map((p) => p.yaml || p);
    // Several values per key, since many branches fire only on "false", a
    // number or a duration.
    for (const [kind, k] of keys) for (const v of ['true', 'false', '10', '30s', 'h2']) {
        inputs.push(kind === 'annotation'
            ? ['apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: app', '  annotations:',
               '    haproxy.org/' + k + ': "' + v + '"', ...backend].join('\n')
            : ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: haproxy-kubernetes-ingress', 'data:', '  ' + k + ': "' + v + '"'].join('\n'));
    }
    // And every string literal in the module, so a branch no input reaches is
    // still read. Comments are skipped: they are for maintainers, not readers.
    mod.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .forEach((l, i) => { for (const m of l.matchAll(/'((?:[^'\\]|\\.)*)'/g)) walk(m[1], 'migration-haproxy.js line ' + (i + 1)); });
    walk(source.strings, 'strings');
    walk(source.analyzer.strategies, 'strategies');
    for (const y of inputs) for (const s of ['annotation', 'crd']) walk(analyze(source, y, s).plan, 'plan');
    const html = fs.readFileSync(path.join(ROOT, 'haproxy-migration.html'), 'utf8').replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/g, '');
    // Line by line, so every offending line is reported rather than the first.
    const text = html.replace(/<[^>]+>/g, ' ') + '\n' + [...html.matchAll(/(?:aria-label|title|alt|content)="([^"]*)"/g)].map((m) => m[1]).join('\n');
    text.split('\n').forEach((l, i) => walk(l, 'haproxy-migration.html text line ' + (i + 1)));
    assert.deepEqual([...found], []);
});

test('haproxy: a verified: tag names both pinned sources', (t) => {
    /* A mapping's verified: is set in the commit that checks it
       (migration-tool). ingress-nginx's source is archived, so its tag is one
       NGINX Ingress Controller version; HAProxy moves too, so this one is
       { haproxy, nic }, and a bump on either side leaves the mapping behind.
       The count is reported, never failed, as test-analyzer.js reports
       ingress-nginx's; a tag of any other shape fails. */
    const fs = require('node:fs'), path = require('node:path');
    const { ROOT } = require('./lib/load.js');
    const mod = fs.readFileSync(path.join(ROOT, 'assets/js/migration-haproxy.js'), 'utf8');
    const haproxy = mod.match(/const HAPROXY_VERSION = '([^']+)'/)[1];
    const { tool } = loadAnalyzer('assets/js/migration-haproxy.js');
    const nic = 'v' + String(tool.NIC.VERSION).replace(/^v/, '');
    const lines = mod.split('\n').filter((l) => /^\s*\{ keys: \[/.test(l));
    const malformed = [];
    let tagged = 0, behind = 0;
    for (const l of lines) {
        if (!/verified:/.test(l)) continue;
        const m = l.match(/verified: \{ haproxy: '(v[\d.]+)', nic: '(v[\d.]+)' \}/);
        if (!m) { malformed.push(l.match(/keys: \[([^\]]*)\]/)[1]); continue; }
        tagged++;
        if (m[1] !== haproxy || m[2] !== nic) behind++;
    }
    assert.deepEqual(malformed, [], 'verified: must be { haproxy: \'vX.Y.Z\', nic: \'vX.Y.Z\' }');
    t.diagnostic(`${tagged} of ${lines.length} HAProxy mapping(s) record a verified: tag; ${behind} behind ${haproxy} / ${nic}, ${lines.length - tagged} carry none.`);
});

test('traefik: a verified: tag names both pinned sources', (t) => {
    /* As HAProxy's: Traefik moves too, so the tag is { traefik, nic }. The
       count is reported, never failed; a tag of any other shape fails. */
    const fs = require('node:fs'), path = require('node:path');
    const { ROOT } = require('./lib/load.js');
    const mod = fs.readFileSync(path.join(ROOT, 'assets/js/migration-traefik.js'), 'utf8');
    const traefik = mod.match(/const TRAEFIK_VERSION = '([^']+)'/)[1];
    const { tool } = loadAnalyzer('assets/js/migration-traefik.js');
    const nic = 'v' + String(tool.NIC.VERSION).replace(/^v/, '');
    const lines = mod.split('\n').filter((l) => /^\s*\{ keys: \[/.test(l));
    const malformed = [];
    let tagged = 0, behind = 0;
    for (const l of lines) {
        if (!/verified:/.test(l)) continue;
        const m = l.match(/verified: \{ traefik: '(v[\d.]+)', nic: '(v[\d.]+)' \}/);
        if (!m) { malformed.push(l.match(/keys: \[([^\]]*)\]/)[1]); continue; }
        tagged++;
        if (m[1] !== traefik || m[2] !== nic) behind++;
    }
    assert.deepEqual(malformed, [], 'verified: must be { traefik: \'vX.Y.Z\', nic: \'vX.Y.Z\' }');
    assert.ok(tagged > 0, 'no Traefik mapping records a verified: tag');
    t.diagnostic(`${tagged} of ${lines.length} Traefik mapping(s) record a verified: tag; ${behind} behind ${traefik} / ${nic}, ${lines.length - tagged} carry none.`);
});
