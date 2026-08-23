'use strict';
/* Page ↔ engine ↔ module wiring checks. The engine binds behavior through
   element ids and data-* attributes at DOMContentLoaded; a missing hook fails
   silently in a browser, so these assertions are the only mechanical guard.
   Everything here is static-analysis over the shipped files — no DOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadAnalyzer } = require('./lib/load.js');

/* One entry per migration tool the branch ships. Branches that add a second
   source module add a row here; nothing else in this file is source-specific. */
const PAGES = [
    { name: 'ingress-nginx', page: 'ingress-nginx-migration.html', module: 'assets/js/migration-ingress-nginx.js' },
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const core = read('assets/js/migration-core.js');

// Element ids the engine queries by literal — skip dynamic concatenations
// (ids ending in '-' come from `getElementById('page-' + x)`-style code).
const engineIds = [...new Set([
    ...[...core.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
    ...[...core.matchAll(/querySelector\(\s*'#([A-Za-z][\w-]*)'\s*\)/g)].map((m) => m[1]),
])].filter((id) => !id.endsWith('-'));

// data-action values the engine dispatches.
const actionsBlock = core.match(/let ACTIONS = \{([\s\S]*?)\n {12}\};/);
const engineActions = new Set([...actionsBlock[1].matchAll(/(\w+):\s*function/g)].map((m) => m[1]));

for (const p of PAGES) {
    const page = read(p.page);
    const mod = read(p.module);

    test(`${p.name}: every engine-queried element id exists in the page`, () => {
        const missing = engineIds.filter((id) => !page.includes(`id="${id}"`));
        assert.deepEqual(missing, []);
    });

    test(`${p.name}: every data-action in the page has an engine handler`, () => {
        const used = new Set([...page.matchAll(/data-action="(\w+)"/g)].map((m) => m[1]));
        const unhandled = [...used].filter((a) => !engineActions.has(a));
        assert.deepEqual(unhandled, []);
    });

    test(`${p.name}: filter sources, pages, and presets agree between page and module`, () => {
        // data-filter-source ↔ reference.sections[].filterSource
        const fsUsed = new Set([...page.matchAll(/data-filter-source="(\w+)"/g)].map((m) => m[1]));
        const fsDefined = new Set([...mod.matchAll(/filterSource: '(\w+)'/g)].map((m) => m[1]));
        assert.deepEqual([...fsUsed].filter((x) => !fsDefined.has(x)), [], 'filter sources');

        // data-page ↔ strings.pageNames (keys may be quoted or bare identifiers)
        const pageNamesBlock = mod.match(/pageNames:\s*\{([^}]*)\}/)[1];
        const pagesDefined = new Set([...pageNamesBlock.matchAll(/(?:'([\w-]+)'|\b([\w$]+))\s*:/g)].map((m) => m[1] || m[2]));
        const pagesUsed = new Set([...page.matchAll(/data-page="([\w-]+)"/g)].map((m) => m[1]));
        assert.deepEqual([...pagesUsed].filter((x) => !pagesDefined.has(x)), [], 'data-page values');

        // data-preset ↔ SAMPLE_PRESETS keys (via the loaded module — no regex on JS)
        const { source } = loadAnalyzer(p.module);
        const presetsDefined = new Set(Object.keys(source.analyzer.samplePresets));
        const presetsUsed = new Set([...page.matchAll(/data-preset="(\w+)"/g)].map((m) => m[1]));
        assert.deepEqual([...presetsUsed].filter((x) => !presetsDefined.has(x)), [], 'data-preset values');
        assert.ok(presetsDefined.has(source.analyzer.defaultPreset), 'defaultPreset exists');
    });

    test(`${p.name}: every reference section and mapping anchor resolves to a page id`, () => {
        const { source } = loadAnalyzer(p.module);
        const sections = new Set([
            ...Object.keys(source.reference.sectionPageMap),
            ...source.reference.sections.map((s) => s.id),
        ]);
        const missingSections = [...sections].filter((s) => !page.includes(`id="${s}"`));
        assert.deepEqual(missingSections, [], 'sectionPageMap / sections ids');

        // Mapping anchors drive the unsupported-card "See Reference Guide" links.
        const anchors = new Set([...mod.matchAll(/anchor: '([\w-]+)'/g)].map((m) => m[1]));
        const missingAnchors = [...anchors].filter((a) => !page.includes(`id="${a}"`));
        assert.deepEqual(missingAnchors, [], 'mapping anchors');
    });

    test(`${p.name}: version-binding attributes are present with static fallbacks`, () => {
        const attrs = [...mod.matchAll(/attr: '([\w-]+)'/g)].map((m) => m[1]);
        assert.ok(attrs.length >= 1);
        for (const attr of attrs) assert.ok(page.includes(attr), `missing ${attr}`);
        for (const attr of ['data-nic-version', 'data-nic-release-link']) {
            assert.ok(page.includes(attr), `missing ${attr}`);
        }
    });

    test(`${p.name}: structural invariants — unique ids, paired rows, paired approach tabs`, () => {
        // Duplicate element ids (first-match wins in browsers and hides bugs).
        const ids = [...page.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]);
        const dupes = [...new Set(ids.filter((i, idx) => ids.indexOf(i) !== idx))];
        assert.deepEqual(dupes, [], 'duplicate ids');

        // Every expandable row pairs with an example row.
        const expandable = (page.match(/class="expandable"/g) || []).length;
        const exampleRows = (page.match(/class="example-row"/g) || []).length;
        assert.equal(expandable, exampleRows, 'tr.expandable / tr.example-row pairing');

        // Checklist persistence keys must be unique.
        const dataIds = [...page.matchAll(/data-id="([\w-]+)"/g)].map((m) => m[1]);
        const dupData = [...new Set(dataIds.filter((i, idx) => dataIds.indexOf(i) !== idx))];
        assert.deepEqual(dupData, [], 'duplicate checklist data-id');

        // Approach tab buttons and content panes come in equal counts per value.
        const count = (re) => [...page.matchAll(re)].reduce((acc, m) => {
            acc[m[1]] = (acc[m[1]] || 0) + 1; return acc;
        }, {});
        const tabs = count(/class="approach-tab[^"]*" data-action="switchApproach" data-approach="(\w+)"/g);
        const panes = count(/class="approach-content[^"]*" data-approach="(\w+)"/g);
        assert.deepEqual(tabs, panes, 'approach tab/pane pairing');
    });

    // Both sides of a comparison are complete manifests. A bare `annotations:`
    // or `data:` block is not something a reader can paste or diff against their
    // own cluster, and the two sides must be the same shape or the diff the panel
    // exists to show is not a diff. 1878479 applied this to the source side and
    // recorded it only in its commit body, so the target side kept its 61
    // fragments; hence an assertion rather than a convention. Comment-only
    // blocks ("# No direct equivalent") declare nothing and are exempt.
    test(`${p.name}: every comparison example is a complete manifest`, () => {
        const fragments = [];
        const blocks = page.matchAll(
            /<div class="comparison-block (?:old|new)"><h4>[\s\S]*?<\/h4><pre><code>([\s\S]*?)<\/code><\/pre><\/div>/g);
        for (const b of blocks) {
            const line = page.slice(0, b.index).split('\n').length;
            for (const doc of b[1].split(/^---$/m)) {
                const content = doc.split('\n')
                    .filter((l) => l.trim() && !l.trimStart().startsWith('#'));
                if (!content.length) continue;
                if (!/^\s*kind:\s/m.test(doc)) {
                    fragments.push(`${p.page}:${line} ${content[0].trim().slice(0, 40)}`);
                }
            }
        }
        assert.deepEqual(fragments, [], 'comparison examples with no kind: declared');
    });

    // A NIC-side line carrying a translated value names its community source in
    // a trailing comment (`client-max-body-size: "10m"  # proxy-body-size`). Which
    // lines are translated is a judgement no regex can make, so this asserts only
    // the mechanical half: within one row, the same key and value must not be
    // commented in one approach tab and bare in another. That is the drift that
    // let 70 lines sit uncommented — the CRD tab named the source, the Annotation
    // tab beside it did not, and nothing compared them.
    test(`${p.name}: mapping comments agree across a row's approach tabs`, () => {
        const LINE = /^\s*(?:-\s*)?([\w.\-/]+):(\s*)(\S.*?)(?:\s\s#\s*(.*))?$/;
        const drift = [];
        const rows = page.matchAll(
            /<tr class="expandable">\s*[\s\S]*?\s*<\/tr>\s*<tr class="example-row">([\s\S]*?)<\/tr>/g);
        for (const row of rows) {
            const blocks = [...row[1].matchAll(
                /<div class="comparison-block new"><h4>[\s\S]*?<\/h4><pre><code>([\s\S]*?)<\/code><\/pre><\/div>/g)];
            if (blocks.length < 2) continue;
            const seen = new Map();
            for (const b of blocks) {
                for (const line of b[1].split('\n')) {
                    const m = LINE.exec(line);
                    if (!m) continue;
                    const k = `${m[1]}=${m[3]}`;
                    if (!seen.has(k)) seen.set(k, new Set());
                    seen.get(k).add(m[4] || '');
                }
            }
            for (const [k, comments] of seen) {
                if (comments.size > 1 && comments.has('')) drift.push(k);
            }
        }
        assert.deepEqual(drift, [], 'lines commented in one approach tab and bare in another');
    });

    // A reference row belongs to exactly one section, and which one is not a
    // judgement call: NIC tier first (a Plus-only target goes to #plus-mappings
    // whatever surface it came from), then the source surface — annotations to
    // #mappings, ConfigMap keys to #configmap-mappings, CR fields to
    // #crd-mappings, controller flags to #flag-mappings. A row may still be
    // cross-listed outside its surface's section, but only if its left cell NAMES
    // the surface ("timeout-queue ConfigMap key", "ConfigMap hsts"), because the
    // section heading is otherwise the reader's only clue about what a bare key is.
    // Drift here is invisible: the page renders perfectly and quietly tells the
    // reader an Ingress annotation exists where only a ConfigMap key does.
    test(`${p.name}: every mapping row sits in the section its surface implies`, () => {
        const rows = [...page.matchAll(
            /<section id="([\w-]+)"|<tr class="expandable">\s*([\s\S]*?)\s*<\/tr>\s*<tr class="example-row">([\s\S]*?)<\/tr>/g)];
        const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
        const REFERENCE = new Set(['mappings', 'plus-mappings', 'configmap-mappings',
            'crd-mappings', 'flag-mappings']);
        const misplaced = [];
        let section = '';
        for (const m of rows) {
            if (m[1]) { section = m[1]; continue; }
            if (!REFERENCE.has(section)) continue;
            const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
            if (cells.length !== 2) continue;
            const [src, nic] = cells;
            // The source side of the comparison — what the reader is migrating FROM.
            const old = (m[3].match(/comparison-block old([\s\S]*?)(?=comparison-block new|$)/) || ['', ''])[1];
            const kind = (old.match(/^\s*kind:\s*([A-Za-z]+)/m) || [])[1];
            const apiVersion = (old.match(/^\s*apiVersion:\s*(\S+)/m) || [])[1] || '';
            // A vendor CR: not a core/Kubernetes group, and not one of the built-in
            // kinds a ConfigMap-key or annotation example ships alongside.
            const vendorCr = kind && !/^(ConfigMap|Secret|Service|Ingress|Deployment|DaemonSet)$/.test(kind)
                && /\./.test(apiVersion) && !/^networking\.k8s\.io\//.test(apiVersion);

            let want;
            if (/badge-plus/.test(nic)) want = 'plus-mappings';
            else if (/ConfigMap|CRD?\b|controller flag|\bflag\b/.test(strip(src))) want = section;
            else if (/annotations:/.test(old)) want = 'mappings';
            else if (strip(src).startsWith('--')) want = 'flag-mappings';
            else if (vendorCr) want = 'crd-mappings';
            else if (kind === 'ConfigMap') want = 'configmap-mappings';
            else want = section;              // spec fields, gap rows: no surface to key off
            // Only hold a page to a section it actually ships.
            if (want !== section && page.includes(`<section id="${want}"`)) {
                misplaced.push(`[${section} -> ${want}] ${strip(src).slice(0, 48)}`);
            }
        }
        assert.deepEqual(misplaced, [], 'rows in the wrong reference section');
    });

    test(`${p.name}: page loads the three scripts in source-before-core order`, () => {
        const scripts = [...page.matchAll(/<script[^>]+src="(assets\/js\/[\w.-]+\.js)"/g)].map((m) => m[1]);
        assert.deepEqual(scripts, ['assets/js/shared.js', p.module, 'assets/js/migration-core.js']);
    });
}
