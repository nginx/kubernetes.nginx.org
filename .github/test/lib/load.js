'use strict';
/* Dependency-free loader for the classic-script migration modules.
   Builds a browser-ish global environment inside a vm context where the
   context object IS window (so bare globals resolve on window, as in a real
   browser), evals the page's SOURCE module and then migration-core.js in
   document order, and returns { source, tool, warnings }.

   `warnings` collects console.warn/console.error output — buildPlan swallows
   generator exceptions with console.warn, so a broken generator silently
   drops its resource; asserting warnings.length is the only way to catch it
   (see "Verifying analyzer changes" in .claude/skills/migration-tool/SKILL.md). */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// This file lives at <root>/.github/test/lib/, so three levels up. Under
// .github/ for the same reason the check scripts are: GitHub Pages publishes
// this branch verbatim, and a top-level test/ would be served to the public.
const ROOT = path.join(__dirname, '..', '..', '..');

// Chainable no-op element: every method returns another stub element so
// engine code that touches the DOM during load is inert.
function stubElement() {
    const el = {};
    const self = () => el;
    ['addEventListener', 'removeEventListener', 'setAttribute', 'getAttribute', 'removeAttribute',
     'appendChild', 'removeChild', 'insertBefore', 'closest', 'focus', 'blur', 'click', 'remove',
     'contains', 'scrollIntoView'].forEach((k) => { el[k] = self; });
    el.classList = { add: self, remove: self, toggle: self, contains: () => false };
    el.style = {};
    el.dataset = {};
    el.children = [];
    // Inert string properties on a stub object — nothing renders in this
    // harness, so writes to innerHTML/textContent are not DOM sinks.
    el.textContent = '';
    el.innerHTML = '';
    el.querySelector = () => null;
    el.querySelectorAll = () => [];
    return el;
}

function makeContext() {
    const warnings = [];
    const ctx = {};
    ctx.window = ctx; // browser-style: window IS the global object
    ctx.globalThis = ctx;
    ctx.console = {
        log: () => {},
        info: () => {},
        warn: (...a) => warnings.push(a.join(' ')),
        error: (...a) => warnings.push('ERROR: ' + a.join(' ')),
    };
    ctx.document = {
        getElementById: () => stubElement(),
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => stubElement(),
        createElementNS: () => stubElement(),
        createTextNode: () => stubElement(),
        createDocumentFragment: () => stubElement(),
        addEventListener: () => {},
        documentElement: stubElement(),
        body: stubElement(),
        title: '',
    };
    ctx.location = { hash: '', pathname: '/test.html', href: '' };
    ctx.history = { replaceState: () => {}, pushState: () => {} };
    ctx.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    ctx.navigator = { clipboard: { writeText: () => Promise.resolve() } };
    ctx.addEventListener = () => {};
    ctx.removeEventListener = () => {};
    ctx.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    ctx.requestIdleCallback = (fn) => fn({ timeRemaining: () => 0 });
    ctx.setTimeout = setTimeout;
    ctx.clearTimeout = clearTimeout;
    ctx.fetch = () => Promise.reject(new Error('no network in tests'));
    vm.createContext(ctx);
    return { ctx, warnings };
}

// Load a source module + the shared engine; sourceFile is repo-relative,
// e.g. 'assets/js/migration-haproxy.js'.
function loadAnalyzer(sourceFile) {
    const { ctx, warnings } = makeContext();
    for (const file of [sourceFile, 'assets/js/migration-core.js']) {
        const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
        vm.runInContext(code, ctx, { filename: file });
    }
    if (!ctx.MIGRATION_SOURCE) throw new Error(sourceFile + ' did not define window.MIGRATION_SOURCE');
    if (!ctx.MigrationTool) throw new Error('migration-core.js did not define window.MigrationTool');
    return { source: ctx.MIGRATION_SOURCE, tool: ctx.MigrationTool, warnings };
}

// Convenience: run one input through parseInput/buildPlan and flatten the
// plan's generated YAML (export parts) into one searchable string.
function analyze(source, yaml, strategy) {
    const parsed = source.analyzer.parseInput(yaml);
    const plan = source.analyzer.buildPlan(parsed, strategy);
    const text = plan.export ? plan.export.parts.join('\n---\n') : '';
    return { parsed, plan, text };
}

module.exports = { ROOT, loadAnalyzer, analyze };
