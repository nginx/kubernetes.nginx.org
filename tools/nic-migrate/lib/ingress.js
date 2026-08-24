'use strict';
/* ingress.js — split a YAML stream into documents and describe the Ingresses.
   =========================================================================
   This is a SCANNER, not a YAML parser. It reads indentation and a handful of
   known keys, and it exists for one purpose: counting what an Ingress contains
   so the report can say which parts the analyzer's single-context model left
   behind. Nothing it produces reaches generated output — every value here ends
   up in an advisory message.

   That boundary is why a hand-rolled scanner is acceptable at this stage and
   will not be at the next: the converter has to round-trip values, so it parses
   properly (see README, "Stage 2").

   Known limits, all of which degrade to under-reporting rather than wrong
   output: no flow mappings ({a: b}), no anchors/aliases, no block scalars
   containing a line that looks like a key.
   ========================================================================= */

const COMMUNITY_PREFIX = 'nginx.ingress.kubernetes.io/';

/* Split on a document separator at column 0. Also normalises CRLF/CR so the
   line scanning below never trips on a trailing \r. */
function splitDocuments(text) {
    return String(text)
        .replace(/\r\n?/g, '\n')
        .split(/^---[ \t]*$/m)
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
}

function indentOf(line) {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
}

/* True for a line that is inside a block scalar opened at `parentIndent`.
   Prevents snippet bodies (configuration-snippet: |) from being read as keys. */
function scanLines(doc) {
    const lines = doc.split('\n');
    const out = [];
    let blockIndent = -1;
    for (const raw of lines) {
        const line = raw.replace(/\t/g, '    ');
        if (blockIndent >= 0) {
            if (line.trim() === '' || indentOf(line) > blockIndent) {
                out.push({ line, indent: indentOf(line), inBlock: true });
                continue;
            }
            blockIndent = -1;
        }
        const isComment = /^\s*#/.test(line);
        const opensBlock = /:\s*[|>][-+0-9]*\s*(#.*)?$/.test(line);
        out.push({ line, indent: indentOf(line), inBlock: false, isComment });
        if (opensBlock && !isComment) blockIndent = indentOf(line);
    }
    return out;
}

function kindOf(doc) {
    const m = doc.match(/^kind:\s*["']?([A-Za-z]+)["']?\s*$/m);
    return m ? m[1] : null;
}

function isIngress(doc) {
    return kindOf(doc) === 'Ingress';
}

/* Pull the scalar for a top-level-ish key at a given indent, e.g. name under
   metadata:. Returns null when absent. */
function valueAt(scanned, key, indent) {
    const re = new RegExp('^\\s{' + indent + '}' + key + ':\\s*(.*)$');
    for (const s of scanned) {
        if (s.inBlock || s.isComment) continue;
        const m = s.line.match(re);
        if (m) return unquote(m[1]);
    }
    return null;
}

function unquote(v) {
    if (v == null) return null;
    const t = String(v).trim().replace(/\s+#.*$/, '').trim();
    if (t === '') return null;
    return t.replace(/^(["'])([\s\S]*)\1$/, '$2');
}

/* Describe one Ingress document: everything the gap checks need. */
function describe(doc) {
    const scanned = scanLines(doc);
    const body = scanned.filter((s) => !s.inBlock && !s.isComment);

    const hosts = [];
    const tlsSecrets = [];
    const services = [];
    let paths = 0;
    let hasTls = false;
    let inTls = false;
    let tlsIndent = -1;

    for (const s of body) {
        const t = s.line.trim();

        if (/^tls:\s*$/.test(t)) { hasTls = true; inTls = true; tlsIndent = s.indent; continue; }
        if (inTls && s.indent <= tlsIndent && t !== '') inTls = false;

        // rules[].host — singular. tls[].hosts is a plural list and is skipped.
        let m = t.match(/^-?\s*host:\s*(.+)$/);
        if (m && !inTls) {
            const h = unquote(m[1]);
            if (h && hosts.indexOf(h) === -1) hosts.push(h);
            continue;
        }
        m = t.match(/^-?\s*secretName:\s*(.+)$/);
        if (m) {
            const sec = unquote(m[1]);
            if (sec && tlsSecrets.indexOf(sec) === -1) tlsSecrets.push(sec);
            continue;
        }
        if (/^-?\s*path:\s*/.test(t)) { paths += 1; continue; }
        // service.name lives one level under `service:`; count distinct names.
        m = t.match(/^-?\s*name:\s*(.+)$/);
        if (m) {
            const idx = body.indexOf(s);
            const prev = body.slice(Math.max(0, idx - 3), idx).map((p) => p.line.trim());
            if (prev.some((p) => /^-?\s*service:\s*$/.test(p))) {
                const svc = unquote(m[1]);
                if (svc && services.indexOf(svc) === -1) services.push(svc);
            }
        }
    }

    const annotations = [];
    const re = new RegExp('^\\s*(?:' + COMMUNITY_PREFIX.replace(/[.\/]/g, '\\$&') + ')([A-Za-z0-9._-]+):');
    for (const s of scanned) {
        if (s.inBlock || s.isComment) continue;
        const m = s.line.match(re);
        if (m && annotations.indexOf(m[1]) === -1) annotations.push(m[1]);
    }

    return {
        name: valueAt(scanned, 'name', 2) || '(unnamed)',
        namespace: valueAt(scanned, 'namespace', 2),
        ingressClassName: valueAt(scanned, 'ingressClassName', 2),
        // The pre-1.18 way of selecting a controller; still common in the wild.
        classAnnotation: (doc.match(/kubernetes\.io\/ingress\.class:\s*(.+)/) || [])[1]
            ? unquote((doc.match(/kubernetes\.io\/ingress\.class:\s*(.+)/) || [])[1])
            : null,
        hosts,
        paths,
        services,
        hasTls,
        tlsSecrets,
        annotations
    };
}

module.exports = { splitDocuments, isIngress, kindOf, describe, COMMUNITY_PREFIX };
