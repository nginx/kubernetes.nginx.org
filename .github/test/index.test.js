'use strict';
/* index.html ↔ index.js wiring. The landing page is the site's front door and
   had no mechanical coverage at all: test-analyzer.js never opens it,
   check-classes.py reads it only for class names, and wiring.test.js iterates
   migration pages. Everything here is static analysis over the shipped files —
   no DOM, no dependencies. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib/load.js');

const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'assets/js/index.js'), 'utf8');

// PAGE_NAMES is the SPA's view registry: every navigable id must be a key, and
// every key must have a pane. index.js:179 builds document.title from
// PAGE_NAMES[id] with no guard, so an id that is not a key renders the string
// "undefined — NGINX - Networking for Kubernetes" in the browser tab.
const pageNamesBlock = js.match(/let PAGE_NAMES = \{([\s\S]*?)\n {8}\};/);
const pageNames = new Set(
    [...(pageNamesBlock ? pageNamesBlock[1] : '').matchAll(/'([\w-]+)'\s*:/g)].map((m) => m[1]));

test('PAGE_NAMES parsed', () => {
    assert.ok(pageNames.size > 0, 'could not parse PAGE_NAMES out of index.js');
});

test('every PAGE_NAMES key except home has a pane in the page', () => {
    const missing = [...pageNames]
        .filter((k) => k !== 'home')
        .filter((k) => !page.includes(`id="page-${k}"`));
    assert.deepEqual(missing, []);
});

test('every pane in the page is a PAGE_NAMES key', () => {
    const panes = [...page.matchAll(/id="page-([\w-]+)"/g)].map((m) => m[1]);
    const unknown = panes.filter((p) => !pageNames.has(p) && p !== 'announce');
    assert.deepEqual(unknown, []);
});

test('every navigation target resolves to a PAGE_NAMES key', () => {
    const targets = new Set([
        ...[...page.matchAll(/data-product="([\w-]+)"/g)].map((m) => m[1]),
        ...[...page.matchAll(/data-navigate="([\w-]+)"/g)].map((m) => m[1]),
    ]);
    const unknown = [...targets].filter((t) => !pageNames.has(t));
    assert.deepEqual(unknown, []);
});

test('every data-version binding names a real VERSION_CONFIG field', () => {
    const cfg = js.match(/let VERSION_CONFIG = \{([\s\S]*?)\n {8}\};/);
    assert.ok(cfg, 'could not parse VERSION_CONFIG');
    const products = {};
    for (const [, name, body] of cfg[1].matchAll(/(\w+):\s*\{([\s\S]*?)\}\s*\}/g)) {
        products[name] = new Set([...body.matchAll(/(\w+):\s*'/g)].map((m) => m[1]));
    }
    const bad = [];
    for (const [, product, field] of page.matchAll(/data-version="(\w+)\.(\w+)"/g)) {
        if (!products[product] || !products[product].has(field)) {
            bad.push(`${product}.${field}`);
        }
    }
    assert.deepEqual([...new Set(bad)], []);
});

test('every element id index.js queries by literal exists in the page', () => {
    const ids = [...new Set([
        ...[...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
        ...[...js.matchAll(/querySelector\(\s*'#([A-Za-z][\w-]*)'\s*\)/g)].map((m) => m[1]),
    ])].filter((id) => !id.endsWith('-'));
    const missing = ids.filter((id) => !page.includes(`id="${id}"`));
    assert.deepEqual(missing, []);
});

test('no duplicate element ids', () => {
    const ids = [...page.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    assert.deepEqual(dupes, []);
});

test('page loads shared.js before index.js, and nothing else', () => {
    const scripts = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['assets/js/shared.js', 'assets/js/index.js']);
});
