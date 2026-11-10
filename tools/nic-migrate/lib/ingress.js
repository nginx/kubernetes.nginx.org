'use strict';
/* ingress.js — read Ingress resources out of a YAML stream.
   =========================================================================
   Every input — a file, a kubectl List, an IngressList, `kubectl -o json` —
   goes through the site's own parser (lib/yaml.js, which hands over
   migration-core.js's), so `report` and `convert` read a manifest exactly as
   the page does. This used to be a line scanner that counted keys by
   indentation; a Deployment's probe path, a wrapped value or a saved List
   came out wrong in report and right in convert.
   ========================================================================= */

const yaml = require('./yaml');

const COMMUNITY_PREFIX = 'nginx.ingress.kubernetes.io/';

/* Every Ingress object in `text`: List and IngressList items expanded. Each
   document is parsed on its own, so one broken document is reported without
   hiding the rest. Returns { ingresses: [doc], skipped: {kind: n}, errors }.
   `kinds` widens the gate for a source that keeps settings elsewhere too:
   HAProxy also reads Service annotations, its controller ConfigMap and five
   CRs, so an Ingress-only gate would skip most of a real deployment. */
function readIngresses(text, kinds) {
    const want = kinds || ['Ingress'];
    const out = { ingresses: [], skipped: {}, errors: [] };
    const docs = [];
    for (const lines of yaml.splitStream(text)) {
        try {
            const d = yaml.parse(lines.join('\n'));
            if (d !== null) docs.push(d);
        } catch (err) {
            out.errors.push(err.message);
        }
    }
    for (const doc of docs) {
        const items = doc && Array.isArray(doc.items) && /List$/.test(String(doc.kind || '')) ? doc.items : [doc];
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (want.indexOf(item.kind) !== -1) out.ingresses.push(item);
            else { const k = item.kind || 'untyped document'; out.skipped[k] = (out.skipped[k] || 0) + 1; }
        }
    }
    return out;
}

/* What the gap checks and the report need from one parsed Ingress, or from
   another kind the source reads. `prefixes` are the source's annotation
   prefixes; a key under two of them (haproxy.org/ and ingress.kubernetes.io/)
   is one setting, so it is counted once. */
function describe(doc, prefixes) {
    const md = doc.metadata || {};
    const spec = doc.spec || {};
    const ann = md.annotations || {};
    const hosts = [];
    const services = [];
    let paths = 0;
    for (const rule of Array.isArray(spec.rules) ? spec.rules : []) {
        if (rule && rule.host && hosts.indexOf(rule.host) === -1) hosts.push(String(rule.host));
        for (const p of ((rule && rule.http && rule.http.paths) || [])) {
            paths++;
            const b = (p && p.backend) || {};
            const svc = (b.service && b.service.name) || b.serviceName;
            if (svc && services.indexOf(svc) === -1) services.push(String(svc));
        }
    }
    const tls = Array.isArray(spec.tls) ? spec.tls : [];
    const annotations = [];
    for (const k of Object.keys(ann)) {
        const p = (prefixes || [COMMUNITY_PREFIX]).find((x) => k.startsWith(x));
        if (p && annotations.indexOf(k.slice(p.length)) === -1) annotations.push(k.slice(p.length));
    }
    return {
        kind: doc.kind ? String(doc.kind) : 'Ingress',
        name: md.name ? String(md.name) : '(unnamed)',
        namespace: md.namespace ? String(md.namespace) : null,
        ingressClassName: spec.ingressClassName ? String(spec.ingressClassName) : null,
        classAnnotation: ann['kubernetes.io/ingress.class'] ? String(ann['kubernetes.io/ingress.class']) : null,
        hosts,
        paths,
        services,
        hasTls: tls.length > 0,
        tlsSecrets: tls.map((t) => t && t.secretName).filter(Boolean).map(String),
        annotations,
        // A canary Ingress shares its stable one's host by design. Only the
        // community controller has canary annotations.
        canary: /^true$/i.test(String(ann[COMMUNITY_PREFIX + 'canary'] || '').trim())
    };
}

module.exports = { readIngresses, describe, COMMUNITY_PREFIX };
