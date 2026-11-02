'use strict';
/* gaps.js — what a reader still has to do before applying the output.
   =========================================================================
   The engine now assembles complete resources (one VirtualServer per host, or
   the migrated Ingress), so most of what this file once reported — hosts,
   paths and backends past the first, two VirtualServers on one host, TLS
   dropped, Policies never referenced — cannot happen any more. These checks
   still compare the source Ingress with the generated resources, so if the
   assembler regresses they fail loudly instead of trusting it.

   Severity: 'blocking' would be rejected or lose traffic if applied as-is,
   'review' needs a human decision, 'note' is informational.
   ========================================================================= */

function countMatches(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
}

/* Generated resources, with the host each one claims. */
function generatedResources(parts) {
    const out = [];
    for (const part of parts) {
        const kind = (part.match(/^kind:\s*(\S+)\s*$/m) || [])[1];
        if (!kind) continue;
        out.push({
            kind,
            name: (part.match(/^\s{2}name:\s*(\S+)\s*$/m) || [])[1] || null,
            host: ((part.match(/^\s{2}host:\s*(\S+)/m) || [])[1] || '').replace(/^"|"$/g, '') || null,
            hasPolicies: /^\s*policies:/m.test(part) || /nginx\.org\/policies:/.test(part),
            hasTls: /^\s{2}tls:/m.test(part) || /^\s{2}tls:\s*$/m.test(part) || /secretName:/.test(part),
            hasClass: /ingressClassName:\s*\S/.test(part),
            text: part
        });
    }
    return out;
}

function detect(desc, result) {
    const gaps = [];
    const add = (id, severity, message) => gaps.push({ id, severity, message });
    const parts = result.parts || [];
    const yaml = result.yaml || '';
    const resources = generatedResources(parts);
    const routable = resources.filter((r) => r.kind === 'VirtualServer' || r.kind === 'TransportServer' || r.kind === 'Ingress');

    /* 1. A translator that threw was swallowed and its fragment is missing. */
    for (const w of result.warnings || []) {
        add('generator-warning', 'blocking', 'A translator failed and part of the output is missing: ' + w);
    }

    if (!desc.annotations.length) return gaps;

    /* 2. Every source host has a resource. */
    const covered = new Set(routable.map((r) => r.host).filter(Boolean));
    const ingressOut = routable.some((r) => r.kind === 'Ingress');
    const missing = ingressOut ? [] : desc.hosts.filter((h) => !covered.has(h));
    if (missing.length && routable.length) {
        add('hosts-dropped', 'blocking', 'No generated resource serves ' + missing.join(', ') + '.');
    }

    /* 3. Every source backend is referenced. */
    const services = desc.services.filter((s) => !new RegExp('(service: |name: )' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(yaml));
    if (services.length && routable.length) {
        add('backends-dropped', 'blocking', 'Backends missing from the generated resources: ' + services.join(', ') + '.');
    }

    /* 4. Two resources may not claim one host (NIC accepts the oldest). */
    const byHost = new Map();
    for (const r of routable) {
        if (!r.host) continue;
        if (!byHost.has(r.host)) byHost.set(r.host, []);
        byHost.get(r.host).push(r);
    }
    for (const [host, rs] of byHost) {
        if (rs.length > 1) {
            add('host-conflict', 'blocking', rs.length + ' resources claim host ' + host + ' (' +
                rs.map((r) => r.kind + '/' + r.name).join(', ') + '); NGINX Ingress Controller serves the oldest and rejects the rest.');
        }
    }

    /* 5. Policies are referenced. */
    const policies = resources.filter((r) => r.kind === 'Policy');
    if (policies.length && !routable.some((r) => r.hasPolicies)) {
        add('policy-unwired', 'blocking', policies.map((p) => p.name).join(', ') + ' generated but referenced by nothing.');
    }

    /* 6. TLS and class carried over. */
    if (desc.hasTls && routable.length && !routable.some((r) => r.hasTls)) {
        add('tls-dropped', 'blocking', 'Source terminates TLS (' + (desc.tlsSecrets.join(', ') || 'unnamed') + ') but no generated resource does.');
    }
    if ((desc.ingressClassName || desc.classAnnotation) && routable.length && !routable.some((r) => r.hasClass)) {
        add('class-dropped', 'review', 'Source selects controller "' + (desc.ingressClassName || desc.classAnnotation) +
            '"; the generated resources set no ingressClassName. Pass --class with your NGINX Ingress Controller class.');
    }

    /* 7. Placeholders and warnings the engine raised. */
    const plan = result.plan || {};
    const todos = (plan.infoNotes || []).filter((n) => /TODO/.test(n.code)).length + countMatches(yaml, /#\s*TODO:/g);
    if (todos > 0) {
        add('todo-placeholders', 'review', todos + ' placeholder' + (todos !== 1 ? 's' : '') + ' to fill in — the analyzer could not infer these values.');
    }
    for (const n of plan.infoNotes || []) {
        if (n.severity === 'warning' && !/TODO|^snippets$/.test(n.code)) add('needs-attention', 'review', n.code + ' — ' + n.message);
    }

    /* 8. Recognised with no migration path, and never-seen annotations. */
    if (plan.unsupported && plan.unsupported.cards) {
        for (const c of plan.unsupported.cards) add('unsupported', 'review', c.code + ' — ' + c.title + ': ' + c.desc);
    }
    if (plan.unrecognized && plan.unrecognized.items) {
        const names = plan.unrecognized.items
            .map((i) => (i.yaml.match(/nginx\.ingress\.kubernetes\.io\/([^:"]+)/) || [])[1])
            .filter(Boolean);
        if (names.length) add('unrecognized', 'note', 'Not in the mapping database (custom, deprecated, or not yet mapped): ' + names.join(', ') + '.');
    }

    /* 9. Snippets: NIC rejects the resource unless snippets are enabled. */
    if (/location-snippets|server-snippets/.test(yaml)) {
        add('snippet-passthrough', 'blocking', 'Output uses snippets. NGINX Ingress Controller ships with snippets DISABLED and rejects the resource ' +
            '("snippet specified but snippets feature is not enabled") — install with helm --set controller.enableSnippets=true. ' +
            'Directives from community-only modules (more_set_headers, Lua) fail the reload.');
    }
    return gaps;
}

const RANK = { blocking: 0, review: 1, note: 2 };

function sortGaps(gaps) {
    return gaps.slice().sort((a, b) => (RANK[a.severity] - RANK[b.severity]) || a.id.localeCompare(b.id));
}

module.exports = { detect, sortGaps, generatedResources, RANK };
