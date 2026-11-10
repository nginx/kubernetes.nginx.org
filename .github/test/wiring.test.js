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
    { name: 'haproxy', page: 'haproxy-migration.html', module: 'assets/js/migration-haproxy.js' },
    { name: 'traefik', page: 'traefik-migration.html', module: 'assets/js/migration-traefik.js' },
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

// Find-in-page searches only the open view. Inactive views were
// hidden="until-found", so a match in one revealed it and a beforematch handler
// switched the page to it while the reader was still typing in the find bar.
// Plain `hidden` is not searchable, so a view changes only when it is clicked.
const allScripts = fs.readdirSync(path.join(ROOT, 'assets/js'))
    .filter((f) => f.endsWith('.js')).map((f) => 'assets/js/' + f);

test('no view is revealed by find-in-page: no hidden="until-found", no beforematch handler', () => {
    const found = [];
    for (const f of allPages) {
        if (/\bhidden\s*=\s*["']?until-found/i.test(read(f))) found.push(f + ': hidden="until-found"');
    }
    for (const f of allScripts) {
        const js = read(f);
        if (/(setAttribute\(\s*['"]hidden['"]\s*,|\.hidden\s*=)\s*['"]until-found/.test(js)) found.push(f + ': sets until-found');
        if (/['"]beforematch['"]|onbeforematch/.test(js)) found.push(f + ': beforematch handler');
    }
    assert.deepEqual(found, []);
});

// NGINX is a name, so it is written in capitals wherever a reader meets it as
// a word (AGENTS.md). Lowercase nginx is right only as code: a directive, a
// path, `ingressClassName: nginx`. Seven "verified on nginx 1.31.7" and
// "nginx has no ..." sentences sat on the pages until a reader spotted one.
test('page prose writes NGINX in capitals; lowercase nginx is only code', () => {
    const found = [];
    for (const f of allPages) {
        const prose = read(f)
            .replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<pre\b[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>/g, ' ')
            .replace(/<[^>]+>/g, ' ');
        for (const m of prose.matchAll(/(?<![\w./`'"-])nginx(?![\w./`'"-])/g)) {
            found.push(f + ': ' + prose.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, ' ').trim());
        }
    }
    assert.deepEqual(found, []);
});

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
        const rows = [...page.matchAll(/<tr class="expandable"(?: id="[\w-]+")?>\s*([\s\S]*?)\s*<\/tr>\s*<tr class="example-row">([\s\S]*?)<\/tr>/g)];
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

    // Categories are alphabetical within their section, so the order a reader
    // scrolls past matches the order the category filter offers. Appending a new
    // category to the end is the easy mistake and is invisible on a long page.
    test(`${p.name}: category headings are alphabetical within each section`, () => {
        const sections = [...page.matchAll(/<section id="([\w-]+)"([\s\S]*?)(?=<section id="|$)/g)];
        let checked = 0;
        for (const [, id, body] of sections) {
            // Only a reference section has a category filter to match; prose
            // subsections (Install, then Defaults) keep their reading order.
            if (!/class="mapping-table"/.test(body)) continue;
            const headings = [...body.matchAll(/<h3 id="[\w-]+">([\s\S]*?)<\/h3>/g)]
                .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());
            if (headings.length < 2) continue;
            checked++;
            const sorted = [...headings].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            assert.deepEqual(headings, sorted, `#${id} categories out of order`);
        }
        assert.ok(checked >= 3, `expected several multi-category sections, checked ${checked}`);
    });

    // A mapping's category is the label the analyzer prints beside a finding, and
    // the reader then looks for that heading in the reference tables. Nothing
    // renders them together, so drift is invisible until someone hunts for a
    // heading that does not exist — "Access Control" against "Access control".
    test(`${p.name}: every mapping category is a heading on the page, verbatim`, () => {
        const headings = new Set([...page.matchAll(/<h3 id="[\w-]+">(.*?)<\/h3>/g)]
            .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim()));
        const categories = new Set([...mod.matchAll(/category: ['"]([^'"]+)['"]/g)].map((m) => m[1])
            .filter((c) => !c.startsWith('categoryFilter')));
        assert.ok(categories.size > 5, 'categories found');
        assert.deepEqual([...categories].filter((c) => !headings.has(c)), [], 'categories without a matching h3');
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
        // [\w-]: \w alone skipped every hyphenated value (vs-policy, v5-7-0).
        const tabs = count(/class="approach-tab[^"]*" data-action="switchApproach" data-approach="([\w-]+)"/g);
        const panes = count(/class="approach-content[^"]*" data-approach="([\w-]+)"/g);
        assert.deepEqual(tabs, panes, 'approach tab/pane pairing');
    });

    // Both sides of a comparison are complete manifests. A bare `annotations:`
    // or `data:` block is not something a reader can paste or diff against their
    // own cluster, and the two sides must be the same shape or the diff the panel
    // exists to show is not a diff. 1878479 applied this to the source side and
    // recorded it only in its commit body, so the target side kept its 61
    // fragments; hence an assertion rather than a convention. Comment-only
    // blocks ("# No direct equivalent") declare nothing and are exempt.
    //
    // So is a block whose first line is `args:`. A controller flag is not a
    // resource to author — the reader is editing the Deployment they already
    // run — and #flag-mappings says once, in a banner above the tables, which
    // Deployment and which field (`spec.template.spec.containers[].args`) every
    // args block below belongs to. Wrapping each of them in nine lines of
    // Deployment scaffolding would add over a thousand lines to the page to
    // repeat that one sentence, against a stated size budget.
    //
    // And so is a block that opens by naming a static configuration file
    // ("# traefik.yml"). Traefik's static configuration is not a Kubernetes
    // object at all — it is a file or CLI flags, read at startup and not from
    // the API server — so there is no kind to declare and no manifest to make
    // complete. The two sides of those rows are genuinely different shapes, and
    // that difference IS the migration fact the row exists to teach. The NIC
    // side of each is still held to the rule.
    test(`${p.name}: every comparison example is a complete manifest`, () => {
        const fragments = [];
        const blocks = page.matchAll(
            /<div class="comparison-block (?:old|new)"><h4>[\s\S]*?<\/h4><pre><code>([\s\S]*?)<\/code><\/pre><\/div>/g);
        for (const b of blocks) {
            const line = page.slice(0, b.index).split('\n').length;
            for (const doc of b[1].split(/^---$/m)) {
                const raw = doc.split('\n').filter((l) => l.trim());
                const content = doc.split('\n')
                    .filter((l) => l.trim() && !l.trimStart().startsWith('#'));
                if (!content.length) continue;
                if (content[0].trim() === 'args:') continue;
                if (raw.length && /^#\s*\S+\.ya?ml\b/.test(raw[0].trim())) continue;
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
    //
    // Position is part of a line's identity, or the comparison is not
    // like-for-like: a Policy's own `  name: office-ips-policy` is scaffolding
    // and stays bare, while the `    - name: office-ips-policy` that references
    // it from spec.policies names the middleware it replaces. Same key, same
    // value, different lines — keying on text alone read that as drift and
    // would have been "fixed" by commenting a metadata name.
    test(`${p.name}: mapping comments agree across a row's approach tabs`, () => {
        const LINE = /^(\s*)(-\s*)?([\w.\-/]+):(\s*)(\S.*?)(?:\s\s#\s*(.*))?$/;
        const drift = [];
        const rows = page.matchAll(
            /<tr class="expandable"(?: id="[\w-]+")?>\s*[\s\S]*?\s*<\/tr>\s*<tr class="example-row">([\s\S]*?)<\/tr>/g);
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
                    const k = `${m[1].length}${m[2] ? '-' : ''}${m[3]}=${m[5]}`;
                    if (!seen.has(k)) seen.set(k, { bare: new Set(), commented: new Set() });
                    seen.get(k)[m[6] ? 'commented' : 'bare'].add(i);
                }
            });
            for (const [k, at] of seen) {
                if ([...at.bare].some((i) => [...at.commented].some((j) => j !== i))) drift.push(k);
            }
        }
        assert.deepEqual(drift, [], 'lines commented in one approach tab and bare in another');
    });

    // A reference row belongs to exactly one section, and which one is not a
    // judgement call: NIC tier first (a Plus-only target goes to #plus-mappings,
    // unless it is a ConfigMap key), then the source surface — annotations to
    // #mappings, ConfigMap keys to #configmap-mappings, CR fields to
    // #crd-mappings, controller flags to #flag-mappings. A row may still be
    // cross-listed outside its surface's section, but only if its left cell NAMES
    // the surface (a ConfigMap badge before hsts), because the
    // section heading is otherwise the reader's only clue about what a bare key is.
    // Drift here is invisible: the page renders perfectly and quietly tells the
    // reader an Ingress annotation exists where only a ConfigMap key does.
    test(`${p.name}: every mapping row sits in the section its surface implies`, () => {
        const rows = [...page.matchAll(
            /<section id="([\w-]+)"|<tr class="expandable"(?: id="[\w-]+")?>\s*([\s\S]*?)\s*<\/tr>\s*<tr class="example-row">([\s\S]*?)<\/tr>/g)];
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
            // A ConfigMap is not always a ConfigMap *setting*. HAProxy Enterprise's
            // platform modules have no key of their own: their configuration travels
            // in a `*-config-snippet` value or in the `haproxy-aux.cfg` file mounted
            // beside the generated config, so the ConfigMap is the vehicle, not the
            // construct, and those rows belong with their feature rather than in
            // #configmap-mappings. A row that documents the snippet key itself names
            // it in the left cell, and stays subject to the rule.
            const vehicleOnly = /(-config-snippet|haproxy-aux\.cfg):/.test(old)
                && !/config-snippet|aux/.test(strip(src));

            let want;
            // A ConfigMap key stays with the ConfigMap keys whatever its tier;
            // the NGINX Plus badge in its cell carries the tier. timeout-queue
            // and the modsecurity key sat in #plus-mappings until the
            // maintainer asked for them with their siblings.
            const configMapKey = /badge-configmap/.test(src) || (kind === 'ConfigMap' && !vehicleOnly && !/annotations:/.test(old));
            if (/badge-plus/.test(nic) && configMapKey) want = 'configmap-mappings';
            else if (/badge-plus/.test(nic)) want = 'plus-mappings';
            else if (/ConfigMap|CRD?\b|controller flag|\bflag\b/.test(strip(src))) want = section;
            else if (/annotations:/.test(old)) want = 'mappings';
            else if (strip(src).startsWith('--')) want = 'flag-mappings';
            else if (vendorCr) want = 'crd-mappings';
            else if (kind === 'ConfigMap' && !vehicleOnly) want = 'configmap-mappings';
            else want = section;              // spec fields, gap rows: no surface to key off
            // Only hold a page to a section it actually ships.
            if (want !== section && page.includes(`<section id="${want}"`)) {
                misplaced.push(`[${section} -> ${want}] ${strip(src).slice(0, 48)}`);
            }
        }
        assert.deepEqual(misplaced, [], 'rows in the wrong reference section');
    });

    // "Not needed" says the reader drops a setting and keeps its behavior,
    // and it takes one of two forms: NGINX Ingress Controller already does it,
    // or a construct the reader migrates to covers it. Five cells had grown
    // five phrasings ("Not needed, sent automatically", "Not needed: the
    // Policy CRD cors answers preflights itself"); the reason is in the panel.
    test(`${p.name}: every "Not needed" cell uses one of the two forms`, () => {
        const bad = [];
        for (const m of page.matchAll(/<tr class="expandable"[^>]*>\s*<td>[\s\S]*?<\/td>\s*<td>(Not needed[\s\S]*?)<\/td>/g)) {
            if (!/^Not needed \((?:default behavior|built into <code>[^<]+<\/code>[^)<]*)\)$/.test(m[1])) bad.push(m[1].slice(0, 60));
        }
        assert.deepEqual(bad, []);
    });

    // A row with no configuration to show answers in the NGINX Ingress
    // Controller column itself: the note sits there, in place of a code block.
    // 32 rows held a block of comments with a note below repeating it, and the
    // Copy button copied the comments.
    test(`${p.name}: no NGINX Ingress Controller example is comments only`, () => {
        const only = [];
        for (const m of page.matchAll(/<div class="comparison-block new"><h4>[\s\S]*?<\/h4><pre><code>([\s\S]*?)<\/code><\/pre><\/div>/g)) {
            const lines = m[1].split('\n').filter((l) => l.trim());
            if (lines.length && lines.every((l) => l.trim().startsWith('#'))) {
                only.push(page.slice(0, m.index).split('\n').length + ': ' + lines[0].trim().slice(0, 40));
            }
        }
        assert.deepEqual(only, []);
    });

    // In the NGINX Ingress Controller column the verdict is in the collapsed
    // cell straight above, so a note there starts with its content. A bold
    // lead-in stays only when it says what the cell does not ("Different
    // mechanism:", "Partial:").
    test(`${p.name}: a note in the NGINX Ingress Controller column does not repeat the cell's verdict`, () => {
        const repeats = [];
        for (const m of page.matchAll(/<div class="comparison-block new answer-only">[\s\S]*?(?=<\/div>\s*<\/div>\s*(?:<div class="info-box|<\/div>))/g)) {
            for (const b of m[0].matchAll(/<div class="info-box[^"]*"><strong>([^<]*)<\/strong>/g)) {
                if (/^(Note|Not applicable|Not needed|Not planned|Not supported|No direct equivalent|No NGINX Open Source equivalent):?$/.test(b[1])) repeats.push(b[1]);
            }
        }
        assert.deepEqual(repeats, []);
    });

    // A panel opens on its code: tabs or the comparison first, then the notes.
    // Ten panels opened on a paragraph, eight of them in a CRD overview table
    // that had no code at all; a reader expanding a row expects the example.
    test(`${p.name}: every expanded panel opens on its code`, () => {
        const prose = [];
        for (const m of page.matchAll(/<div class="example-content">\s*<div class="info-box/g)) {
            prose.push(page.slice(0, m.index).split('\n').length);
        }
        assert.deepEqual(prose, [], 'lines where a panel opens on a note');
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
    // ingress-nginx names the annotation in community:, on the line before;
    // other modules name the row's left cell in source:, on the same line.
    const ANNOTATION_FIRST = [...mod.matchAll(/\{ community: \["([\w-]+)"[^\n]*\n\s*preferAnnotation:/g)]
        .map((m) => `nginx.ingress.kubernetes.io/${m[1]}`)
        .concat([...mod.matchAll(/\{ keys: [^\n]*?source: '([^']+)'[^\n]*?preferAnnotation:/g)].map((m) => m[1]));
    test(`${p.name}: rows with a CRD and an annotation approach lead with the CRD`, () => {
        const CRD_BADGE = /badge-(?:virtualserver|virtualserverroute|policy|transportserver|globalconfiguration)\b/;
        const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const wrong = [];
        const seen = new Set();
        for (const m of page.matchAll(
                /<tr class="expandable"(?: id="[\w-]+")?>\s*([\s\S]*?)\s*<\/tr>\s*<tr class="example-row">([\s\S]*?)<\/tr>/g)) {
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

test('shell commands are highlighted without losing a character', () => {
    /* highlightShell() rebuilds a command as spans, so a regex gap drops text
       from what a reader sees, though Copy still reads the raw text. Run it
       over every command block on the page and a few that exercise pipes,
       quotes and variables: the text must survive whole, and each role land
       where index.html's hand-highlighted commands put it. */
    const start = core.indexOf('        let SHELL_START');
    const end = core.indexOf('        // Build an inline SVG icon');
    assert.ok(start > 0 && end > start, 'highlightShell() is where this test expects it');
    const doc = {
        createDocumentFragment: () => ({ kids: [], appendChild(n) { this.kids.push(n); } }),
        createElement: () => ({ className: '', textContent: '' }),
        createTextNode: (t) => ({ className: '', textContent: t })
    };
    const { highlightShell, SHELL_START } = new Function('document', core.slice(start, end) + '; return { highlightShell, SHELL_START };')(doc);
    const run = (t) => highlightShell(t).kids;
    const page = read('ingress-nginx-migration.html');
    const blocks = [...page.matchAll(/<pre[^>]*><code[^>]*>([^<]*)<\/code><\/pre>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
        .filter((t) => SHELL_START.test(t.trimStart()));
    assert.ok(blocks.length >= 3, 'the page still has command blocks: ' + blocks.length);
    const extra = ['kubectl get svc -o jsonpath="{.spec.ports[0].port}" | grep 80 && echo "ok $HOME ${X}"', '# comment\nhelm upgrade --install x y --version 2.8.0 --namespace=nginx'];
    for (const t of blocks.concat(extra)) assert.equal(run(t).map((k) => k.textContent).join(''), t);
    const roles = (t) => run(t).filter((k) => k.className).map((k) => k.className.replace('sh-', '') + ':' + k.textContent);
    assert.deepEqual(roles('helm install x \\\n  --set a.b=nginx-nic \\\n  --set c=true --version 2.8.0'),
        ['cmd:helm', 'punct:\\', 'flag:--set', 'key:a.b', 'punct:=', 'str:nginx-nic', 'punct:\\', 'flag:--set', 'key:c', 'punct:=', 'cmd:true', 'flag:--version', 'num:2.8.0']);
    assert.deepEqual(roles('a | b && c'), ['cmd:a', 'punct:|', 'cmd:b', 'punct:&&', 'cmd:c']);
});

test('the core places every source\'s notes: card, step 0, unsupported, ignored values, no change, differences', () => {
    /* MigrationTool.notes() is the one place a note's section is decided, for
       every source module; each module only says what a note is. Its
       contract: a card note stays on its card, deduped by message; step 0
       keeps its command; an unsupported note is a card with its reason;
       invalid notes are the box naming the module's controller; unchanged
       notes are the collapsed list; warnings lead the differences; and the
       attention count is step-0 warnings, differences warnings and invalid. */
    const { tool } = loadAnalyzer('assets/js/migration-ingress-nginx.js');
    const s = tool.notes();
    const n = (o) => Object.assign({ code: 'x', message: 'm', severity: 'note' }, o);
    s.add(n({ message: 'merged', card: 'prod/a.example.com' }));
    s.add(n({ message: 'merged', card: 'prod/a.example.com' }));
    s.add(n({ message: 'split', card: 'prod/a.example.com', severity: 'warning' }));
    s.add(n({ code: 'k', message: 'run this', before: true, severity: 'warning', command: 'kubectl get x' }));
    s.add(n({ code: 'u', message: 'gone', severity: 'unsupported', title: 'Load balancing', anchor: 'lb' }));
    s.add(n({ code: 'u', message: 'gone', severity: 'unsupported', title: 'Load balancing', anchor: 'lb' }));
    s.add(n({ code: 'i', message: 'unread', severity: 'invalid' }));
    s.add(n({ code: 'c', message: 'did nothing', severity: 'unchanged' }));
    s.add(n({ code: 'd1', message: 'differs', severity: 'note' }));
    s.add(n({ code: 'd2', message: 'differs badly', severity: 'warning' }));
    const out = s.sections('the community controller');
    assert.deepEqual(Array.from(s.cardsFor('prod/a.example.com'), (x) => x.message), ['split', 'merged'], 'warnings first, a repeat dropped');
    assert.deepEqual(Array.from(s.cardsFor('prod/b.example.com')), []);
    assert.equal(s.before()[0].command, 'kubectl get x');
    assert.deepEqual(Array.from(out.unsupported.cards, (c) => c.title + '|' + c.desc + '|' + c.anchor), ['Load balancing|gone|lb']);
    assert.equal(out.invalid.title, 'Values the community controller ignored');
    assert.deepEqual(Array.from(out.invalid.items, (x) => x.code), ['i']);
    assert.deepEqual(Array.from(out.unchanged, (x) => x.code), ['c']);
    assert.deepEqual(Array.from(out.infoNotes, (x) => x.code), ['d2', 'd1'], 'warnings lead');
    assert.equal(out.flagged, 1 + 1 + 1, 'step-0 warning, a differences warning, an ignored value');
    assert.ok(s.has({ code: 'd1', message: 'differs' }) && !s.has({ code: 'd1', message: 'other' }));
});
