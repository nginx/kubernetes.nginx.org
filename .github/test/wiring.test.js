'use strict';
/* Page ↔ engine ↔ module wiring checks. The engine binds behavior through
   element ids and data-* attributes at DOMContentLoaded; a missing hook fails
   silently in a browser, so these assertions are the only mechanical guard.
   Everything here is static-analysis over the shipped files — no DOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadAnalyzer, idsQueriedBy } = require('./lib/load.js');

/* One entry per migration tool the branch ships. Branches that add a second
   source module add a row here; nothing else in this file is source-specific. */
const PAGES = [
    { name: 'ingress-nginx', page: 'ingress-nginx-migration.html', module: 'assets/js/migration-ingress-nginx.js' },
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const core = read('assets/js/migration-core.js');

// Element ids the engine queries by literal (dynamic concatenations skipped).
const engineIds = idsQueriedBy(core);

// shared.js runs on every page and null-guards each lookup, so a page missing
// #sidebarBackdrop or #page-announce loses the drawer or the announcements
// silently. AGENTS.md lists these ids as what the shared JS keys off; nothing
// read shared.js until this test.
const sharedIds = idsQueriedBy(read('assets/js/shared.js'));
const allPages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

test('shared.js: it queries at least the ids AGENTS.md names', () => {
    for (const id of ['sidebar', 'sidebarBackdrop', 'menuToggle', 'darkToggle', 'copyright-year', 'page-announce']) {
        assert.ok(sharedIds.includes(id), 'shared.js no longer queries #' + id + ' — update AGENTS.md or this list');
    }
});

for (const f of allPages) {
    test(`${f}: every element id shared.js queries exists`, () => {
        const html = read(f);
        assert.deepEqual(sharedIds.filter((id) => !html.includes(`id="${id}"`)), []);
    });
}

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

    // The strategy line under the toggle is written twice: statically in the
    // page (what shows before any click) and in the module, which swaps it in
    // on each toggle. Nothing tied them, and the module's copy described an
    // analyzer that had since changed.
    test(`${p.name}: the strategy description in the page is the module's for the initial strategy`, () => {
        const strategies = loadAnalyzer(p.module).source.analyzer.strategies;
        const shown = (page.match(/<span class="strategy-desc" id="strategyDesc">([^<]*)<\/span>/) || [])[1];
        assert.ok(shown, 'no #strategyDesc in the page');
        assert.equal(shown.trim(), strategies.descriptions[strategies.initial]);
        assert.match(page, new RegExp('data-strategy="' + strategies.initial + '" aria-pressed="true"'));
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

    // A cell that offers two ways — "— or —", or a slash between two named
    // targets — promises both below it. The panel delivers that with approach
    // tabs. Naming an alternative and then showing one form is the drift this
    // catches: ingress-nginx has 42 such cells and 42 tabbed panels.
    test(`${p.name}: every alternative offered in a cell has an example`, () => {
        const rows = [...page.matchAll(/<tr class="expandable">\s*([\s\S]*?)\s*<\/tr>\s*<tr class="example-row">([\s\S]*?)<\/tr>/g)];
        const unbacked = [];
        for (const [, head, panel] of rows) {
            const cells = [...head.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
            if (cells.length !== 2) continue;
            const offersAlternative = cells[1].includes('or-text') || /<\/code>\s*\/\s*(<span|[A-Za-z])/.test(cells[1]);
            if (offersAlternative && !panel.includes('approach-tab')) {
                unbacked.push(cells[0].replace(/<[^>]+>/g, '').trim().slice(0, 40));
            }
        }
        assert.deepEqual(unbacked, [], 'cells offering an alternative with no tabbed example');
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
            // Bare in one block and commented in ANOTHER: within one block the
            // same key and value can be both, as a TransportServer's own name
            // is bare while its listener reference names what it replaces.
            const seen = new Map();
            blocks.forEach((b, i) => {
                for (const line of b[1].split('\n')) {
                    const m = LINE.exec(line);
                    if (!m) continue;
                    const k = `${m[1]}=${m[3]}`;
                    if (!seen.has(k)) seen.set(k, { bare: new Set(), commented: new Set() });
                    seen.get(k)[m[4] ? 'commented' : 'bare'].add(i);
                }
            });
            for (const [k, at] of seen) {
                if ([...at.bare].some((i) => [...at.commented].some((j) => j !== i))) drift.push(k);
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

    // A row offering both a CRD and an annotation answers CRD first, in all three
    // places a reader meets it: the collapsed cell's first option, the first
    // tab, and the tab that opens by default. 36 of 39 rows did; the three that
    // led with the annotation were each added on their own, and nothing said
    // the order was a rule. A mapping marked preferAnnotation is the deliberate
    // exception, and the analyzer keeps it as an annotation under CRD-first too:
    // its row must lead with the annotation, and must exist.
    const ANNOTATION_FIRST = [...mod.matchAll(/\{ community: \["([\w-]+)"[^\n]*\n\s*preferAnnotation:/g)]
        .map((m) => `nginx.ingress.kubernetes.io/${m[1]}`);
    test(`${p.name}: rows with a CRD and an annotation approach lead with the CRD`, () => {
        const CRD_BADGE = /badge-(?:virtualserver|virtualserverroute|policy|transportserver|globalconfiguration)\b/;
        const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const wrong = [];
        const seen = new Set();
        for (const m of page.matchAll(
                /<tr class="expandable">\s*([\s\S]*?)\s*<\/tr>\s*<tr class="example-row">([\s\S]*?)<\/tr>/g)) {
            const tabs = [...m[2].matchAll(
                /class="approach-tab( active)?" data-action="switchApproach" data-approach="([\w-]+)"/g)];
            const kinds = tabs.map((t) => t[2]);
            if (!kinds.includes('crd') || !kinds.includes('annotation')) continue;
            const label = strip(m[1]).slice(0, 48);
            const lead = ANNOTATION_FIRST.find((a) => m[1].includes(`<code>${a}</code>`));
            const first = lead ? 'annotation' : 'crd';
            if (lead) seen.add(lead);
            if (kinds[0] !== first || !tabs[0][1]) wrong.push(`${label} — tabs ${kinds.join(', ')}`);
            const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
            if (cells.length === 2 && CRD_BADGE.test(cells[1].split('class="or-text"')[0]) === !!lead) {
                wrong.push(`${label} — collapsed cell leads with ${strip(cells[1].split('class="or-text"')[0]).slice(0, 32)}`);
            }
        }
        assert.deepEqual(wrong, [], 'rows that lead with the wrong approach');
        assert.deepEqual(ANNOTATION_FIRST.filter((a) => !seen.has(a)), [], 'preferAnnotation rows not found');
    });

    // Bold lead-ins read "New in v5.6.0 — Custom error pages …": the clause after
    // the dash is a title, so it opens with a capital. Code-formatted words are
    // exempt (`<code>externalAuth</code>` keeps its case), so the check reads the
    // markup, not the stripped text.
    test(`${p.name}: a bold lead-in capitalises the word after an em dash`, () => {
        const lower = [...page.matchAll(/<strong>([\s\S]*?)<\/strong>/g)]
            .map((m) => m[1])
            .filter((t) => /(?:&mdash;|—)\s*[a-z]/.test(t));
        assert.deepEqual(lower, [], 'lead-ins with a lowercase letter after the em dash');
    });
}
