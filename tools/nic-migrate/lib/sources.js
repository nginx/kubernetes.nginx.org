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
    },
    traefik: {
        id: 'traefik',
        label: 'Traefik',
        module: 'assets/js/migration-traefik.js',
        page: 'traefik-migration.html',
        prefixes: ['traefik.ingress.kubernetes.io/'],
        /* Traefik is the opposite of HAProxy: one annotation prefix, but almost
           everything real lives in CRs rather than on the Ingress. The eleven
           kinds are the ones assets/js/migration-traefik.js switches on —
           routing (IngressRoute and its TCP/UDP siblings, TraefikService),
           behaviour (Middleware, MiddlewareTCP), TLS (TLSOption, TLSStore) and
           backend transport (ServersTransport, ServersTransportTCP).

           Traefik's static configuration is deliberately absent: it is CLI
           flags or a traefik.yml file, not a Kubernetes object, so there is no
           kind to gate on. The page documents it; the CLI cannot read it. */
        kinds: ['Ingress', 'IngressRoute', 'IngressRouteTCP', 'IngressRouteUDP',
                'Middleware', 'MiddlewareTCP', 'ServersTransport', 'ServersTransportTCP',
                'TLSOption', 'TLSStore', 'TraefikService', 'Service'],
        // The routing resources are migrated one by one; Middlewares,
        // TraefikServices, TLSOptions, ServersTransports and Services are the
        // run each is resolved against, as Traefik resolves a router's
        // references (service.* annotations live on the Service).
        units: ['Ingress', 'IngressRoute', 'IngressRouteTCP', 'IngressRouteUDP'],
        kubectl: ['ingress', 'service', 'ingressroutes.traefik.io', 'ingressroutetcps.traefik.io', 'ingressrouteudps.traefik.io',
            'middlewares.traefik.io', 'middlewaretcps.traefik.io', 'serverstransports.traefik.io', 'serverstransporttcps.traefik.io',
            'tlsoptions.traefik.io', 'tlsstores.traefik.io', 'traefikservices.traefik.io'],
        unit: 'resource'
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
