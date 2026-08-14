/* test-analyzer.js — exercise the migration analyzer outside a browser.
   =========================================================================
   There is no build system or test framework here, so this is a plain Node
   script with a hand-rolled DOM stub.

   The load-bearing detail: buildPlan runs each CRD generator inside a
   try/catch that only console.warn()s on failure. A broken generator therefore
   DROPS ITS RESOURCE from the output instead of throwing, and the analyzer
   looks like it worked. A thrown exception is NOT the failure signal —
   counting console.warn is. This script captures warnings and fails on any.

   Usage:  node .github/scripts/test-analyzer.js
   Exit:   0 all presets produced a plan with no warnings, 1 otherwise.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Repo root: this file lives at <root>/.github/scripts/, so two levels up
// from __dirname. Under .github/ so GitHub Pages does not publish it.
const ROOT = path.dirname(path.dirname(__dirname));

/* A chainable no-op element: every property read returns something callable or
   indexable, so DOM code runs to completion without a real document. */
function stubElement() {
    const el = {
        style: {}, classList: {
            add() {}, remove() {}, toggle() {}, contains() { return false; }
        },
        dataset: {}, children: [], childNodes: [],
        appendChild(c) { return c; }, removeChild(c) { return c; },
        insertBefore(c) { return c; }, setAttribute() {}, getAttribute() { return null; },
        removeAttribute() {}, addEventListener() {}, removeEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        closest() { return null; }, focus() {}, click() {},
        scrollIntoView() {}, getBoundingClientRect() {
            return { top: 0, left: 0, width: 0, height: 0 };
        },
        textContent: '', innerHTML: '', value: '', href: '', type: '', id: '',
        className: '', hidden: false, disabled: false,
        parentNode: null, nextElementSibling: null, previousElementSibling: null,
        firstChild: null, offsetHeight: 0, offsetTop: 0, scrollTop: 0,
        getAttributeNS() { return null; }, setAttributeNS() {},
        insertAdjacentHTML() {}, remove() {}, contains() { return false; },
        select() {}, blur() {}, matches() { return false; }
    };
    return el;
}

const documentStub = {
    createElement: stubElement,
    createElementNS: stubElement,
    createTextNode(t) { return { textContent: t }; },
    createDocumentFragment: stubElement,
    /* Hand back a stub rather than null: migration-core.js wires listeners to
       elements directly at load, so a null here would throw before any of the
       analyzer code this script exists to exercise could run. */
    getElementById() { return stubElement(); },
    querySelector() { return stubElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    documentElement: stubElement(),
    body: stubElement()
};

const warnings = [];
const errors = [];

const sandbox = {
    window: {},
    document: documentStub,
    localStorage: {
        getItem() { return null; }, setItem() {}, removeItem() {}
    },
    navigator: { clipboard: null },
    location: { hash: '', pathname: '/tools/ingress-nginx-migration/' },
    history: { pushState() {} },
    matchMedia() { return { matches: false, addEventListener() {}, addListener() {} }; },
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    requestIdleCallback: null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Blob: class {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    FileReader: class {},
    announce() {},
    copyToClipboard() {},
    /* window-level APIs migration-core.js binds at load. */
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    innerWidth: 1400,
    innerHeight: 900,
    pageYOffset: 0,
    devicePixelRatio: 1,
    console: {
        log: console.log,
        warn(...args) { warnings.push(args.join(' ')); },
        error(...args) { errors.push(args.join(' ')); }
    }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);

function load(rel) {
    const file = path.join(ROOT, rel);
    const code = fs.readFileSync(file, 'utf8');
    try {
        vm.runInContext(code, context, { filename: rel });
    } catch (err) {
        console.error(`FAIL  ${rel} threw while loading: ${err.message}`);
        process.exit(1);
    }
    console.log(`  loaded ${rel}`);
}

console.log('Loading the analyzer...');
/* Order matters and is the inverse of what it looks like: the source module
   only dereferences MigrationTool inside function bodies (call time), while
   migration-core.js reads window.MIGRATION_SOURCE at top level. So source
   first, core second — which is also the order the page loads them in. */
load('assets/js/migration-ingress-nginx.js');
load('assets/js/migration-core.js');

const SOURCE = sandbox.window.MIGRATION_SOURCE;
const MT = sandbox.window.MigrationTool;

if (!SOURCE) { console.error('FAIL  window.MIGRATION_SOURCE was not defined'); process.exit(1); }
if (!MT || !MT.util) { console.error('FAIL  window.MigrationTool was not defined'); process.exit(1); }

/* Every property migration-core.js reads off SOURCE. If the contract drifts,
   this is where it shows, rather than as a blank panel in the browser. */
const CONTRACT = [
    'strings.analyzeEmpty.title', 'strings.analyzeEmpty.message',
    'strings.noFindings.title', 'strings.noFindings.message',
    'strings.emptyStateLead', 'strings.emptyStateHint', 'strings.pageNames',
    'reference.sections', 'reference.sectionPageMap',
    'reference.defaultPage', 'reference.fallbackPage',
    'storage.checklist', 'storage.eolCollapsed',
    'analyzer.samplePresets', 'analyzer.defaultPreset',
    'analyzer.parseInput', 'analyzer.buildPlan',
    'export.filename', 'export.header'
];

function dig(obj, dotted) {
    return dotted.split('.').reduce(
        (acc, key) => (acc == null ? acc : acc[key]), obj);
}

console.log('\nChecking the MIGRATION_SOURCE contract...');
let contractOk = true;
for (const key of CONTRACT) {
    const value = dig(SOURCE, key);
    if (value === undefined || value === null) {
        console.error(`  MISSING  ${key}`);
        contractOk = false;
    }
}
if (!contractOk) { process.exit(1); }
console.log(`  all ${CONTRACT.length} required properties present`);

/* The block types migration-core.js knows how to render. Anything else is
   skipped with a warning in the browser, which is invisible on a page this
   long — so it is asserted here instead. */
const RENDERABLE = new Set(['comparison', 'dual-note', 'crd-install-note', 'crd-group']);

console.log('\nRunning every sample preset through both strategies...');
const presets = Object.keys(SOURCE.analyzer.samplePresets);
let failures = 0;

for (const preset of presets) {
    for (const strategy of ['crd', 'annotation']) {
        warnings.length = 0;
        const label = `${preset}/${strategy}`;
        let parsed, plan;

        try {
            parsed = SOURCE.analyzer.parseInput(SOURCE.analyzer.samplePresets[preset]);
            plan = SOURCE.analyzer.buildPlan(parsed, strategy);
        } catch (err) {
            console.error(`  FAIL  ${label} threw: ${err.message}`);
            failures++;
            continue;
        }

        const findings = (parsed.findings || []).length;
        const steps = (plan.steps || []).length;
        const blocks = (plan.steps || []).reduce(
            (n, s) => n + ((s.blocks || []).length), 0);
        const exported = (plan.export && plan.export.parts || []).length;

        /* A generator that failed silently shows up here and nowhere else. */
        if (warnings.length) {
            console.error(`  FAIL  ${label}: ${warnings.length} console.warn — a CRD `
                + 'generator failed and its resource was dropped from the plan:');
            warnings.forEach(w => console.error(`          ${w}`));
            failures++;
            continue;
        }

        if (!findings) {
            console.error(`  FAIL  ${label}: parseInput found no annotations`);
            failures++;
            continue;
        }
        if (!steps) {
            console.error(`  FAIL  ${label}: buildPlan produced no steps`);
            failures++;
            continue;
        }

        const unknown = [];
        for (const step of plan.steps || []) {
            for (const block of step.blocks || []) {
                if (!RENDERABLE.has(block.type)) { unknown.push(block.type); }
            }
        }
        if (unknown.length) {
            console.error(`  FAIL  ${label}: block types the renderer does not `
                + `handle: ${[...new Set(unknown)].join(', ')}`);
            failures++;
            continue;
        }

        console.log(`  ok    ${label.padEnd(20)} ${findings} findings, ${steps} steps, `
            + `${blocks} blocks, ${exported} exported resource(s)`);
    }
}

/* The utils are carried verbatim, so a regression here means someone edited
   migration-core.js. These assert the behaviours the mapping data relies on. */
console.log('\nChecking the carried utility behaviours...');
const u = MT.util;
const cases = [
    ['stripInlineComment keeps a quoted hash',
        u.stripInlineComment('"a#b" # note'), '"a#b" '],
    ['stripInlineComment leaves a bare value alone',
        u.stripInlineComment('16k'), '16k'],
    /* Note the double space: each run of [\r\n;{}] becomes one space and
       existing whitespace is left alone, so 'a;' + ' return' yields 'a  return'.
       The function neutralises directive-breaking characters; it does not
       normalise whitespace, and nothing downstream needs it to. */
    ['sanitizeSnippetValue neutralises a directive break',
        u.sanitizeSnippetValue('a; return 1{}'), 'a  return 1'],
    ['sanitizeSnippetValue escapes a quote',
        u.sanitizeSnippetValue('say "hi"'), 'say \\"hi\\"'],
    ['formatYamlKV quotes a single-line value',
        u.formatYamlKV('  ', 'k', 'v'), '  k: "v"'],
    ['formatYamlKV makes a block scalar for multiline',
        u.formatYamlKV('  ', 'k', 'a\nb'), '  k: |\n    a\n    b']
];
for (const [name, actual, expected] of cases) {
    if (actual === expected) {
        console.log(`  ok    ${name}`);
    } else {
        console.error(`  FAIL  ${name}\n          expected ${JSON.stringify(expected)}`
            + `\n          got      ${JSON.stringify(actual)}`);
        failures++;
    }
}

console.log('');
if (errors.length) {
    console.error(`${errors.length} console.error during the run:`);
    errors.forEach(e => console.error(`  ${e}`));
    failures++;
}
if (failures) {
    console.error(`${failures} failure(s).`);
    process.exit(1);
}
console.log(`All ${presets.length * 2} preset/strategy combinations produced a clean `
    + 'plan, with no dropped resources.');
