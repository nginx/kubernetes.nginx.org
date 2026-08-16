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
    /* announce / copyToClipboard are deliberately NOT stubbed here: they come
       from assets/js/shared.js, which this script loads for real. Stubbing them
       would mask the file the page scripts depend on most. */
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
   first, core second — which is also the order the page loads them in.

   shared.js goes first, exactly as the page loads it. It is loaded for real
   rather than stubbed because it is the single source of truth for the top
   bar, drawer, dark mode and copy buttons on both pages, and running it here
   is the only place anything executes it outside a browser. */
load('assets/js/shared.js');
load('assets/js/migration-ingress-nginx.js');
load('assets/js/migration-core.js');

/* The globals shared.js publishes that the page scripts call unqualified.
   Renaming one here without updating its call sites throws nothing at load —
   the button simply stops working — so the boundary is asserted instead. */
const SHARED_GLOBALS = [
    'announce', 'openSidebar', 'closeSidebar', 'copyToClipboard', 'addCopyLabel'
];
const missingShared = SHARED_GLOBALS.filter(
    name => typeof sandbox[name] !== 'function');
if (missingShared.length) {
    console.error('FAIL  assets/js/shared.js did not define: '
        + missingShared.join(', '));
    process.exit(1);
}
console.log(`  all ${SHARED_GLOBALS.length} shared.js globals the page scripts `
    + 'call are defined');

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
    'export.filename', 'export.header',
    /* Four more the core reads that this list used to omit, so the caption
       above was not true of it. Each drives visible chrome rather than the
       analysis, which is why their absence renders a blank instead of
       throwing: the version pills, the input status line, the EOL banner's
       two-part text, and the strategy selector. Derived by enumerating every
       `SOURCE.` dereference in migration-core.js. */
    'versionBindings',
    'inputStatus.pattern', 'inputStatus.noun',
    'eolCompact.strongText', 'eolCompact.restText',
    'analyzer.strategies.initial', 'analyzer.strategies.descriptions'
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

/* ── The mapping ↔ generator contract, both directions ──────────────────────
   This file's stated premise is that a broken CRD generator shows up as a
   console.warn. There is a hole in that: the generator is looked up as

       if (om.crdKind && om.templateFn && CRD_GENERATORS[om.templateFn] && …)

   so a MISSPELLED templateFn makes the condition false and the resource is
   dropped before the try/catch that produces the warning. Nothing observes it —
   the presets still yield steps, the run stays green, and the CRD is simply
   absent from the plan. The forward direction below closes that.

   The reverse direction catches a generator nothing names, which is how
   generateWAFPolicy sat in the module unreferenced. Both are pure text
   analysis of the source module, so neither needs the DOM stub. */
function checkGeneratorContract() {
    const src = fs.readFileSync(
        path.join(ROOT, 'assets/js/migration-ingress-nginx.js'), 'utf8');
    const named = new Set([...src.matchAll(/templateFn:\s*"([^"]+)"/g)].map(m => m[1]));
    /* Indentation-agnostic, and accepts both the `name: function` and
       `name(...)` forms. Pinning exactly twelve leading spaces meant a
       reindent would silently empty this set, and an empty `defined` makes
       every forward check fail loudly but every reverse check pass — the
       dead-code direction would have gone quiet. */
    const defined = new Set([...src.matchAll(
        /^\s*(generate\w+)\s*(?::\s*function\b|\()/gm)].map(m => m[1]));

    const problems = [];
    for (const fn of [...named].sort()) {
        if (!defined.has(fn)) {
            problems.push(`templateFn "${fn}" is named by a mapping but no generator `
                + 'defines it — its CRD is silently dropped, with no console.warn');
        }
    }
    for (const fn of [...defined].sort()) {
        if (!named.has(fn)) {
            problems.push(`generator "${fn}" is defined but no mapping names it — dead code`);
        }
    }
    return { problems, named: named.size, defined: defined.size };
}

/* ── The transform vocabulary ───────────────────────────────────────────────
   `translateValue` ends in `default: return value`, so a misspelled transform
   is not an error — it is a silent fallthrough that emits the RAW annotation
   value where a templated directive belonged. Proven: replacing all ten
   `transform: "snippetWrap"` with `"snipetWrap"` still exits 0 and still
   reports "All 6 preset/strategy combinations produced a clean plan", because
   no sample preset happens to exercise those mappings.

   mirrorSnippet is the one legitimate absence: it is dispatched by an explicit
   `hasMirrorSnippet` branch rather than by a case. Keep this allowlist at
   exactly the transforms handled outside the switch. */
const TRANSFORMS_HANDLED_OUTSIDE_SWITCH = new Set(['mirrorSnippet']);

function checkTransformVocabulary() {
    const src = fs.readFileSync(
        path.join(ROOT, 'assets/js/migration-ingress-nginx.js'), 'utf8');
    const named = new Set([...src.matchAll(/transform:\s*"([^"]+)"/g)].map(m => m[1]));

    const fn = src.match(/function translateValue\b[\s\S]*?\n {8}\}/);
    if (!fn) {
        return { problems: ['could not locate translateValue to read its cases'],
                 named: named.size, cases: 0 };
    }
    const cases = new Set([...fn[0].matchAll(/case\s+'([^']+)'/g)].map(m => m[1]));

    const problems = [];
    for (const t of [...named].sort()) {
        if (!cases.has(t) && !TRANSFORMS_HANDLED_OUTSIDE_SWITCH.has(t)) {
            problems.push(`transform "${t}" is named by a mapping but translateValue has no `
                + 'case for it — it falls through to `default: return value` and emits the '
                + 'raw annotation value, with no warning');
        }
    }
    for (const t of [...cases].sort()) {
        if (!named.has(t)) {
            problems.push(`translateValue handles "${t}" but no mapping names it — dead branch`);
        }
    }
    return { problems, named: named.size, cases: cases.size };
}

/* ── The mappings ↔ reference-table contract, both directions ───────────────
   AGENTS.md calls this the migration tool's first rule and "the recurring bug
   here", and nothing enforced it. Every community annotation the analyzer maps
   must be documented in a reference table, and every annotation the reference
   tables document must be mapped — otherwise the tool either recognises
   something it never explains, or explains something it silently drops into
   "unrecognized". Row-level only: it cannot tell whether a hand-written example
   YAML has drifted from its still-correct generator. */
function checkReferenceTables() {
    const src = fs.readFileSync(
        path.join(ROOT, 'assets/js/migration-ingress-nginx.js'), 'utf8');
    const html = fs.readFileSync(
        path.join(ROOT, 'ingress-nginx-migration.html'), 'utf8');

    const mapped = new Set();
    for (const m of src.matchAll(/community:\s*\[(.*?)\]/gs)) {
        for (const lit of m[1].matchAll(/"([^"]+)"/g)) { mapped.add(lit[1]); }
    }
    /* Table cells only. Scanning the whole document counted an annotation as
       "documented" when it appeared solely inside some other row's example
       YAML — so a mapping could lose its own row and this check would still
       pass on the strength of a mention in an unrelated <pre>. Restricting to
       <td> content yields the same 130 today, and now means it. */
    const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]).join('\n');
    const documented = new Set(
        [...cells.matchAll(/nginx\.ingress\.kubernetes\.io\/([a-z0-9-]+)/g)].map(m => m[1]));

    const problems = [];
    for (const a of [...documented].sort()) {
        if (!mapped.has(a)) {
            problems.push(`"${a}" is documented in a reference table but the analyzer `
                + 'has no mapping — pasting it lands in "unrecognized"');
        }
    }
    for (const a of [...mapped].sort()) {
        if (!documented.has(a)) {
            problems.push(`"${a}" is mapped by the analyzer but appears in no reference `
                + 'table row — the tool acts on something it never documents');
        }
    }
    return { problems, mapped: mapped.size, documented: documented.size };
}

/* Frozen shape of every preset/strategy run. Without these the loop below
   asserts only `findings > 0` and `steps > 0`, which is satisfied by almost
   any wrong answer: a mapping can stop contributing a CRD, or a step can lose
   half its blocks, and the run stays green because the counts are printed and
   never compared. This is the cheapest possible guard on the tool's actual
   output — six lines, and it fails the moment a number moves.

   When a number legitimately changes, update it here in the same commit as
   the change, and say in the message which way it moved and why. */
const EXPECTED = {
    'simple/crd':          { findings: 5,  steps: 1, blocks: 1, exported: 1 },
    'simple/annotation':   { findings: 5,  steps: 1, blocks: 1, exported: 1 },
    'moderate/crd':        { findings: 12, steps: 2, blocks: 2, exported: 2 },
    'moderate/annotation': { findings: 12, steps: 2, blocks: 2, exported: 2 },
    'advanced/crd':        { findings: 24, steps: 3, blocks: 5, exported: 6 },
    'advanced/annotation': { findings: 24, steps: 3, blocks: 6, exported: 4 }
};

const presets = Object.keys(SOURCE.analyzer.samplePresets);
let failures = 0;

console.log('\nChecking the mapping ↔ generator contract...');
const gen = checkGeneratorContract();
if (gen.problems.length) {
    gen.problems.forEach(p => console.error(`  FAIL  ${p}`));
    failures += gen.problems.length;
} else {
    console.log(`  ok    ${gen.named} templateFn reference(s) and `
        + `${gen.defined} generator(s) agree in both directions`);
}

console.log('\nChecking the transform vocabulary...');
const tv = checkTransformVocabulary();
if (tv.problems.length) {
    tv.problems.forEach(p => console.error(`  FAIL  ${p}`));
    failures += tv.problems.length;
} else {
    console.log(`  ok    ${tv.named} declared transform(s) and ${tv.cases} `
        + 'translateValue case(s) agree in both directions');
}

console.log('\nChecking the mappings ↔ reference tables...');
const ref = checkReferenceTables();
if (ref.problems.length) {
    ref.problems.forEach(p => console.error(`  FAIL  ${p}`));
    failures += ref.problems.length;
} else {
    console.log(`  ok    ${ref.mapped} mapped annotations and `
        + `${ref.documented} documented annotations agree in both directions`);
}

console.log('\nRunning every sample preset through both strategies...');

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

        const want = EXPECTED[label];
        if (!want) {
            console.error(`  FAIL  ${label}: no EXPECTED entry — add one so this `
                + 'preset/strategy is asserted rather than merely printed');
            failures++;
            continue;
        }
        const got = { findings, steps, blocks, exported };
        const moved = Object.keys(want).filter(k => want[k] !== got[k]);
        if (moved.length) {
            console.error(`  FAIL  ${label}: `
                + moved.map(k => `${k} ${want[k]} -> ${got[k]}`).join(', '));
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

/* ── The mapping index ──────────────────────────────────────────────────────
   Written rather than hand-maintained, and written by the script that already
   validates the same data, so it cannot drift: if it is wrong, the checks
   above have already failed. It exists so that answering "which section
   documents proxy-body-size, and does it generate a CRD?" costs one small JSON
   read instead of a grep through 4,952 lines of markup and 1,340 of JS.

   Under .github/ because Pages publishes this branch. */
function writeMappingIndex() {
    const src = fs.readFileSync(
        path.join(ROOT, 'assets/js/migration-ingress-nginx.js'), 'utf8');
    const entries = [];
    /* One record per mapping object. Split on the `community:` key rather than
       parsing JS: every mapping starts with it, and the fields wanted here all
       sit before the next one. */
    const chunks = src.split(/\n\s*\{\s*community:/).slice(1);
    for (const chunk of chunks) {
        const list = chunk.match(/^\s*\[([^\]]*)\]/);
        if (!list) { continue; }
        const names = [...list[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
        const field = (key) => {
            const m = chunk.match(new RegExp(key + ':\\s*"([^"]+)"'));
            return m ? m[1] : null;
        };
        entries.push({
            community: names,
            category: field('category'),
            anchor: field('anchor'),
            type: field('type'),
            crdKind: field('crdKind'),
            templateFn: field('templateFn'),
            transform: field('transform')
        });
    }
    const out = path.join(ROOT, '.github/data/mapping-index.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
        note: 'Generated by .github/scripts/test-analyzer.js. Do not edit by hand.',
        source: 'assets/js/migration-ingress-nginx.js',
        mappings: entries
    }, null, 1) + '\n');
    return entries.length;
}

const indexed = writeMappingIndex();
console.log(`\nWrote .github/data/mapping-index.json (${indexed} mappings).`);

/* ── Accuracy provenance ────────────────────────────────────────────────────
   The three Version-reference banners assert that the whole tool "is based on"
   a given NIC release. That is one claim about 57 mappings and 19 generators,
   and nothing records when any individual one was last checked against a
   tagged source — so a version bump silently re-asserts them all.

   A mapping may carry `verified: "v5.5.4"`, meaning its four-point accuracy
   check (see the migration-tool skill) was done against that tag. This reports
   how many are behind the current pin. It never fails: the same reasoning as
   the unused-class report in check-classes.py — a number that only goes down
   is useful, a wall of red is ignored. */
function reportProvenance() {
    const src = fs.readFileSync(
        path.join(ROOT, 'assets/js/migration-ingress-nginx.js'), 'utf8');
    const chunks = src.split(/\n\s*\{\s*community:/).slice(1);
    const current = MT.NIC.VERSION;
    let verified = 0;
    let stale = 0;
    for (const chunk of chunks) {
        const m = chunk.match(/verified:\s*"([^"]+)"/);
        if (!m) { continue; }
        verified++;
        if (m[1] !== current) { stale++; }
    }
    const unmarked = chunks.length - verified;
    console.log(`\nAccuracy provenance (reported, never failed):`);
    console.log(`  ${verified} of ${chunks.length} mapping(s) record a verified: tag`
        + `; ${stale} of those are behind ${current}, ${unmarked} carry none.`);
    if (unmarked === chunks.length) {
        console.log('  Add `verified: "<tag>"` to a mapping when its four-point accuracy');
        console.log('  check is done, so the queue shrinks instead of being re-audited whole.');
    }
}
reportProvenance();

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
