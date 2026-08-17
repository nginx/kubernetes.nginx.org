'use strict';
/* gaps.js — where the analyzer's output is not the whole migration.
   =========================================================================
   The engine was written for a paste box: it teaches one annotation at a time,
   against a single example host/service/path, and each CRD generator emits a
   self-contained illustration. That is right for the page and wrong for a file
   you would apply. These checks name the difference, so the advisory output can
   be honest about what a human still has to do.

   Every gap here was observed by running the real engine, not inferred:
   a two-path Ingress yields a context holding only the first service, and a
   rewrite-target + affinity pair yields two VirtualServers that both claim the
   same host.

   Severity: 'blocking' would be rejected or lose traffic if applied as-is,
   'review' needs a human decision, 'note' is informational.
   ========================================================================= */

function countMatches(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
}

/* Generated resources, grouped by kind, with the host each one claims. */
function generatedResources(parts) {
    const out = [];
    for (const part of parts) {
        const kind = (part.match(/^kind:\s*(\S+)\s*$/m) || [])[1];
        if (!kind) continue;
        out.push({
            kind,
            name: (part.match(/^\s{2}name:\s*(\S+)\s*$/m) || [])[1] || null,
            host: (part.match(/^\s{2}host:\s*(\S+)\s*$/m) || [])[1] || null,
            hasPolicies: /^\s*policies:\s*$/m.test(part),
            hasTls: /^\s{2}tls:\s*$/m.test(part),
            hasNamespace: /^\s{2}namespace:\s*\S+/m.test(part),
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
    const crds = resources.filter((r) => r.kind !== 'ConfigMap');
    const routable = crds.filter((r) => r.kind === 'VirtualServer' || r.kind === 'TransportServer');

    /* 1. A generator that threw was swallowed by buildPlan's try/catch and its
       resource is simply missing. This is the only signal. */
    for (const w of result.warnings || []) {
        add('generator-warning', 'blocking',
            'A CRD generator failed and its resource was dropped from the output: ' + w);
    }

    /* 2. parseInput keeps ONE host/service/path. Anything beyond the first is
       absent from every generated CRD. */
    const ctx = (result.parsed && result.parsed.context) || {};
    if (desc.hosts.length > 1 && crds.length > 0) {
        add('hosts-dropped', 'blocking',
            'Ingress defines ' + desc.hosts.length + ' hosts (' + desc.hosts.join(', ') + ') but the ' +
            'generated resources cover only ' + (ctx.host || desc.hosts[0]) + '. The rest have no output.');
    }
    if (desc.paths > 1 && crds.length > 0) {
        add('paths-dropped', 'blocking',
            'Ingress defines ' + desc.paths + ' paths but the generated resources cover only ' +
            (ctx.path || 'the first') + '. Add the remaining routes by hand.');
    }
    if (desc.services.length > 1 && crds.length > 0) {
        add('backends-dropped', 'blocking',
            'Ingress routes to ' + desc.services.length + ' services (' + desc.services.join(', ') + ') but ' +
            'the generated upstreams reference only ' + (ctx.serviceName || desc.services[0]) + '.');
    }

    /* 3. Each generator emits its own VirtualServer. Two claiming one host is
       not a mergeable pair — NIC accepts one and rejects the other. */
    const byHost = new Map();
    for (const r of routable) {
        if (!r.host) continue;
        if (!byHost.has(r.host)) byHost.set(r.host, []);
        byHost.get(r.host).push(r);
    }
    for (const [host, rs] of byHost) {
        if (rs.length > 1) {
            add('host-conflict', 'blocking',
                rs.length + ' resources claim host ' + host + ' (' +
                rs.map((r) => r.kind + '/' + r.name).join(', ') + '). They are separate illustrations of ' +
                'single features — merge them into one resource before applying.');
        }
    }

    /* 4. Policies are generated but the reference is only ever a comment. */
    const policies = crds.filter((r) => r.kind === 'Policy');
    if (policies.length > 0 && !routable.some((r) => r.hasPolicies)) {
        add('policy-unwired', 'blocking',
            policies.length + ' Policy resource' + (policies.length !== 1 ? 's' : '') + ' (' +
            policies.map((p) => p.name).join(', ') + ') ' + (policies.length !== 1 ? 'are' : 'is') +
            ' generated but never referenced. Add nginx.org/policies on the Ingress, or spec.policies ' +
            'on the VirtualServer.');
    }

    /* 5-7. Facts present in the source that no generator carries over. */
    if (desc.namespace && crds.length > 0 && !crds.some((r) => r.hasNamespace)) {
        add('namespace-dropped', 'review',
            'Source Ingress is in namespace "' + desc.namespace + '"; generated resources carry no ' +
            'namespace and would apply to the current context. Policy references are namespace-scoped.');
    }
    if (desc.hasTls && crds.length > 0 && !routable.some((r) => r.hasTls)) {
        add('tls-dropped', 'review',
            'Source Ingress terminates TLS (secret' + (desc.tlsSecrets.length !== 1 ? 's' : '') + ': ' +
            (desc.tlsSecrets.join(', ') || 'unnamed') + ') but no generated VirtualServer has a tls block.');
    }
    if ((desc.ingressClassName || desc.classAnnotation) && crds.length > 0) {
        add('class-dropped', 'review',
            'Source selects controller "' + (desc.ingressClassName || desc.classAnnotation) + '"; generated ' +
            'resources set no ingressClassName. Set it explicitly while both controllers run side by side.');
    }

    /* 8. Placeholders the generators emit deliberately. */
    const todos = countMatches(yaml, /#\s*TODO:/g);
    if (todos > 0) {
        add('todo-placeholders', 'review',
            todos + ' TODO placeholder' + (todos !== 1 ? 's' : '') + ' in the generated YAML must be ' +
            'filled in — the analyzer could not infer these values from the Ingress.');
    }

    /* 9. Recognised but with no migration path, and never-seen annotations. */
    const plan = result.plan || {};
    if (plan.unsupported && plan.unsupported.cards) {
        for (const c of plan.unsupported.cards) {
            add('unsupported', 'review', c.code + ' — ' + c.title + ': ' + c.desc);
        }
    }
    if (plan.unrecognized && plan.unrecognized.items) {
        const names = plan.unrecognized.items
            .map((i) => (i.yaml.match(/nginx\.ingress\.kubernetes\.io\/([^:]+):/) || [])[1])
            .filter(Boolean);
        if (names.length > 0) {
            add('unrecognized', 'note',
                'Not in the mapping database (custom, deprecated, or not yet mapped): ' + names.join(', ') + '.');
        }
    }

    /* 10. Snippets migrate as text; nothing validates the NGINX inside them. */
    if (/nginx\.org\/(server|location)-snippets:/.test(yaml)) {
        add('snippet-passthrough', 'blocking',
            'Output uses snippet annotations. NIC ships with snippets DISABLED and rejects the whole ' +
            'Ingress ("snippet specified but snippets feature is not enabled") rather than ignoring ' +
            'them — install with helm --set controller.enableSnippets=true. Contents are also carried ' +
            'across verbatim and never validated, so directives valid in the community controller may ' +
            'not be valid in this context under NIC.');
    }

    return gaps;
}

const RANK = { blocking: 0, review: 1, note: 2 };

function sortGaps(gaps) {
    return gaps.slice().sort((a, b) => (RANK[a.severity] - RANK[b.severity]) || a.id.localeCompare(b.id));
}

module.exports = { detect, sortGaps, generatedResources, RANK };
