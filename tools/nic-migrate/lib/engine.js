'use strict';
/* engine.js — run the site's migration analyzer outside a browser.
   =========================================================================
   The mapping database (57 entries, ~130 community annotations), the value
   transforms and the CRD generators all live in assets/js/. Rather than copy
   any of that here, this reuses .github/test/lib/load.js — the loader the test
   suite already uses to boot the classic-script modules in a vm with a DOM
   stub. One loader, so the CLI cannot drift from the page.

   That is a deliberate dependency from tools/ onto .github/test/: if load.js
   changes signature the CLI breaks loudly at startup, which is preferable to a
   vendored copy that silently ages.

   Load-bearing detail inherited from the engine: buildPlan runs each CRD
   generator inside a try/catch that only console.warn()s on failure, so a
   broken generator DROPS ITS RESOURCE and the analysis still looks successful.
   A thrown exception is not the failure signal — a captured warning is. The
   loader collects them into one array for the process, so analyze() snapshots
   its length before each run and slices the delta to attribute warnings to the
   Ingress that produced them.
   ========================================================================= */

const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SOURCE_MODULE = 'assets/js/migration-ingress-nginx.js';

function createEngine() {
    let loaded;
    try {
        // eslint-disable-next-line global-require
        loaded = require(path.join(ROOT, '.github', 'test', 'lib', 'load.js'));
    } catch (err) {
        throw new Error(
            'could not load .github/test/lib/load.js (' + err.message + ')\n' +
            'nic-migrate must be run from inside a checkout of the ' +
            'kubernetes.nginx.org repository — it reads the analyzer out of assets/js/.'
        );
    }

    const { source, tool, warnings } = loaded.loadAnalyzer(SOURCE_MODULE);
    if (!source || !source.analyzer) throw new Error(SOURCE_MODULE + ' exposed no analyzer');

    return {
        source,
        tool,
        strategies: Object.keys((source.analyzer.strategies && source.analyzer.strategies.descriptions) || {}),
        defaultStrategy: (source.analyzer.strategies && source.analyzer.strategies.initial) || 'crd',

        /* Analyze ONE Ingress document. The web tool analyzes whatever is in the
           textarea as a single blob, which collapses a multi-document paste into
           one host/service/path context; feeding documents in one at a time is
           the main behavioural difference between this CLI and the page. */
        analyze(yamlText, strategy) {
            const before = warnings.length;
            let parsed;
            let plan;
            let error = null;
            try {
                parsed = source.analyzer.parseInput(yamlText);
                plan = source.analyzer.buildPlan(parsed, strategy);
            } catch (err) {
                error = err.message;
            }
            return {
                parsed: parsed || null,
                plan: plan || null,
                error,
                // Only the warnings this call produced.
                warnings: warnings.slice(before),
                yaml: plan && plan.export ? plan.export.parts.join('\n---\n') : '',
                parts: plan && plan.export ? plan.export.parts.slice() : []
            };
        }
    };
}

module.exports = { createEngine, ROOT, SOURCE_MODULE };
