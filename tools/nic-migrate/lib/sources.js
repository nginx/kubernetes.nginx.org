'use strict';
/* sources.js — the one table that knows which migration source is which.
   =========================================================================
   The CLI runs whichever source module the site ships, and the modules differ
   in two ways the CLI cannot infer from `window.MIGRATION_SOURCE`:

     prefixes  which annotation keys belong to the source controller. The
               scanner needs this to count what an object carries.
     page      the source's migration page, which the checklist is read from.
     kinds     which Kubernetes kinds are worth handing to the analyzer.
               ingress-nginx keeps every setting on the Ingress, so anything
               else is noise. HAProxy spreads the same job across annotated
               Ingress AND Service objects, its controller ConfigMap, and five
               CRs — so an Ingress-only gate would silently skip most of a real
               deployment and then report "no documents found".
     units     which of those kinds the commands migrate one by one; the
               rest are the run the source resolves each unit against.
     kubectl   the resource names --kubectl reads, one `kubectl get` each, so
               a CRD that is not installed skips its kind instead of failing.

   Deliberately here rather than in the source modules: those are page
   contracts loaded in a browser, and input-gathering is a CLI concern. Adding
   a field the page never reads would invite it to drift unnoticed.

   Adding a source is this table plus a module in assets/js/. Nothing else in
   the CLI hardcodes a source name.
   ========================================================================= */

const SOURCES = {
    'ingress-nginx': {
        id: 'ingress-nginx',
        label: 'ingress-nginx',
        module: 'assets/js/migration-ingress-nginx.js',
        page: 'ingress-nginx-migration.html',
        prefixes: ['nginx.ingress.kubernetes.io/'],
        kinds: ['Ingress'],
        units: ['Ingress'],
        kubectl: ['ingress'],
        // What the report calls the unit it iterates over.
        unit: 'Ingress'
    },
    haproxy: {
        id: 'haproxy',
        label: 'HAProxy',
        module: 'assets/js/migration-haproxy.js',
        page: 'haproxy-migration.html',
        // All three are accepted by the controller and by the analyzer; see
        // HAPROXY_PREFIXES in assets/js/migration-haproxy.js.
        prefixes: ['haproxy.org/', 'haproxy.com/', 'ingress.kubernetes.io/'],
        // Ingress and Service carry annotations; ConfigMap is the controller
        // ConfigMap or the legacy tcp-services map; the five CRs are the
        // ingress.v3.haproxy.org (and superseded v1) group.
        kinds: ['Ingress', 'Service', 'ConfigMap', 'Global', 'Defaults', 'Backend', 'Frontend', 'TCP', 'ValidationRules'],
        // HAProxy resolves each Ingress against the Services it routes to,
        // the controller ConfigMap and the CRs (Service > Ingress > ConfigMap).
        units: ['Ingress'],
        kubectl: ['ingress', 'service', 'configmap',
            'globals.ingress.v3.haproxy.org', 'defaults.ingress.v3.haproxy.org', 'backends.ingress.v3.haproxy.org',
            'frontends.ingress.v3.haproxy.org', 'tcps.ingress.v3.haproxy.org', 'validationrules.ingress.v3.haproxy.org',
            'globals.ingress.v1.haproxy.org', 'defaults.ingress.v1.haproxy.org', 'backends.ingress.v1.haproxy.org', 'tcps.ingress.v1.haproxy.org'],
        unit: 'Ingress'
    }
};

const DEFAULT_SOURCE = 'ingress-nginx';

function resolveSource(id) {
    const key = String(id || DEFAULT_SOURCE);
    const found = SOURCES[key];
    if (!found) {
        throw new Error('unknown source "' + key + '" (expected: ' + Object.keys(SOURCES).join(', ') + ')');
    }
    return found;
}

module.exports = { SOURCES, DEFAULT_SOURCE, resolveSource };
