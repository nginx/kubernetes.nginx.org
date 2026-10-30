'use strict';
/* convert.js — applyable manifests for one Ingress.
   =========================================================================
   The assembly lives in the site's source module (migration-ingress-nginx.js):
   one VirtualServer per host under CRD-first, one migrated Ingress under
   annotation-first, every route, backend, TLS secret and Policy carried over.
   The page and this CLI call the same function, so they cannot disagree. This
   file used to rebuild resources from the page's single-feature illustrations;
   the page now emits complete resources, so the grafting is gone.

   What stays here is what only a CLI can do: read a Service's port from a live
   cluster for spec.defaultBackend, and report each note as a line on stderr.
   ========================================================================= */

/* The page's analyzer keeps a preferAnnotation mapping as an annotation under
   annotation-first; the targets pick the strategy, so nothing to override. */
function planOptions(opts) {
    return { ingressClass: opts.ingressClass || null, nameSuffix: opts.nameSuffix || '' };
}

/* A minimal model for naming and reporting: the assembler builds its own. */
function toModel(doc) {
    const md = (doc && doc.metadata) || {};
    const spec = (doc && doc.spec) || {};
    return {
        name: md.name || 'unnamed',
        namespace: md.namespace || null,
        ingressClassName: spec.ingressClassName || (md.annotations || {})['kubernetes.io/ingress.class'] || null,
        doc
    };
}

/* Fill spec.defaultBackend's port from the cluster when the community
   default-backend annotation named only a Service. */
function resolveDefaultBackend(docs, model, opts, notes) {
    if (!opts.resolveServicePort) return;
    for (const d of docs) {
        if (d.kind !== 'Ingress' || !d.spec || !d.spec.defaultBackend) continue;
        const svc = d.spec.defaultBackend.service || {};
        const port = (svc.port || {}).number;
        if (port !== 80 || !svc.name) continue;
        // The analyzer's 80 is a placeholder; the cluster knows the real one.
        // Both values come from cluster data, and neither may become a flag.
        if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(svc.name)) continue;
        const real = opts.resolveServicePort(model.namespace, svc.name);
        if (real) {
            svc.port = { number: real };
            notes.push('spec.defaultBackend port ' + real + ' read from Service ' + svc.name);
        }
    }
}

/* Flatten one assembled Ingress into docs and stderr notes. */
function format(model, out, opts) {
    const strategy = opts.strategy || (opts.target === 'ingress' ? 'annotation' : 'crd');
    const docs = JSON.parse(JSON.stringify(out.docs));
    const notes = [];
    for (const n of out.notes) {
        const v = model.doc.metadata && model.doc.metadata.annotations
            ? model.doc.metadata.annotations['nginx.ingress.kubernetes.io/' + n.annotation] : undefined;
        notes.push((v !== undefined ? n.annotation + ': ' + v + ' — ' : '') + n.message);
    }
    for (const t of out.todos) notes.push('unresolved placeholder at ' + t.path + ' — ' + t.message);
    for (const e of out.unsupported) notes.push(e.found.map((x) => x.annotation).join(', ') + ' — ' + e.mapping.nic);
    if (out.unrecognized.length) notes.push('not in the mapping database: ' + out.unrecognized.join(', '));
    if (strategy === 'crd' && docs.some((d) => /snippets/.test(JSON.stringify(d.spec || {}))) ||
        docs.some((d) => d.metadata && d.metadata.annotations && /snippets/.test(Object.keys(d.metadata.annotations).join(',')))) {
        notes.push('output uses snippets, which NGINX Ingress Controller rejects unless NGINX Ingress Controller runs with -enable-snippets (Helm: controller.enableSnippets=true)');
    }
    resolveDefaultBackend(docs, model, opts, notes);
    return {
        docs,
        warnings: out.warnings || [],
        notes: [...new Set(notes)],
        configMap: out.configMap,
        httpSnippets: out.httpSnippets,
        policies: docs.filter((d) => d.kind === 'Policy').length
    };
}

/* One Ingress on its own. */
function convert(model, engine, opts) {
    const strategy = opts.strategy || (opts.target === 'ingress' ? 'annotation' : 'crd');
    return format(model, engine.migrate(model.doc, strategy, planOptions(opts)), opts);
}

/* Every Ingress of a run together, as the page analyzes a paste: a canary
   Ingress folds into the VirtualServer of its stable one (same namespace,
   host and path) instead of claiming the host a second time. Each result
   carries `mergedInto` (the index it joined) or null. */
function convertAll(models, engine, opts) {
    const strategy = opts.strategy || (opts.target === 'ingress' ? 'annotation' : 'crd');
    const outs = engine.migrateMany(models.map((m) => m.doc), strategy, planOptions(opts));
    return outs.map((o, i) => Object.assign(format(models[i], o.out, opts), { mergedInto: o.mergedInto }));
}

/* The ConfigMap keys a run needs, merged across Ingresses. It is global, so it
   is emitted as its own document to merge into nginx-config, not applied. */
function configMapDoc(results) {
    const data = {};
    const conflicts = [];
    const http = [];
    for (const r of results) {
        for (const [k, v] of Object.entries((r.configMap && r.configMap.data) || {})) {
            if (data[k] !== undefined && data[k] !== v) conflicts.push(k + ' (' + data[k] + ' vs ' + v + ')');
            else data[k] = v;
        }
        for (const l of r.httpSnippets || []) if (!http.includes(l)) http.push(l);
    }
    if (http.length) data['http-snippets'] = (data['http-snippets'] || '') + http.join('\n') + '\n';
    if (!Object.keys(data).length) return null;
    return { doc: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nginx-config' }, data }, conflicts };
}

module.exports = { toModel, convert, convertAll, configMapDoc, planOptions };
