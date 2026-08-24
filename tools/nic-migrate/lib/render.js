'use strict';
/* render.js — turn analyses into a terminal report, a JSON object, or a file
   header. Presentation only; no analysis happens here. */

const { generatedResources, sortGaps } = require('./gaps');

const SEV_LABEL = { blocking: 'blocking', review: 'review  ', note: 'note    ' };

function makeStyle(useColour) {
    const wrap = (code) => (s) => (useColour ? '[' + code + 'm' + s + '[0m' : s);
    return {
        bold: wrap('1'),
        dim: wrap('2'),
        red: wrap('31'),
        yellow: wrap('33'),
        cyan: wrap('36'),
        green: wrap('32'),
        sev(severity, text) {
            if (severity === 'blocking') return this.red(text);
            if (severity === 'review') return this.yellow(text);
            return this.dim(text);
        }
    };
}

/* The annotation-swap YAML the engine produced, dug out of the presentation
   model. steps[].blocks[] of type 'comparison' hold the before/after pair. */
function swapYaml(plan) {
    const out = [];
    for (const step of (plan && plan.steps) || []) {
        for (const block of step.blocks || []) {
            if (block.type === 'comparison' && block.new && block.new.yaml) out.push(block.new.yaml);
        }
    }
    return out.join('\n');
}

function indent(text, pad) {
    return String(text).split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

function renderOne(item, style, opts) {
    const { desc, result, gaps } = item;
    const lines = [];
    const title = (desc.namespace ? desc.namespace + '/' : '') + desc.name;
    const hostText = desc.hosts.length ? '  ' + style.dim('(' + desc.hosts.join(', ') + ')') : '';
    lines.push(style.bold(title) + hostText);

    if (result.error) {
        lines.push('  ' + style.red('analysis failed: ' + result.error));
        return lines.join('\n');
    }

    const banner = result.plan && result.plan.banner;
    const summary = (result.plan && result.plan.pills ? result.plan.pills.map((p) => p.text) : []);
    if (banner && banner.complexity) summary.push('complexity ' + banner.complexity);
    lines.push('  ' + style.dim(summary.join(' · ') || 'no community annotations found'));

    if (!desc.annotations.length) return lines.join('\n');

    const swaps = swapYaml(result.plan);
    if (swaps) {
        lines.push('');
        lines.push('  ' + style.cyan('Annotation swaps'));
        lines.push(indent(swaps, '    '));
    }

    const resources = generatedResources(result.parts).filter((r) => r.kind !== 'ConfigMap');
    if (resources.length) {
        lines.push('');
        lines.push('  ' + style.cyan('CRD resources') + style.dim('  (illustrative — see gaps)'));
        for (const r of resources) {
            lines.push('    ' + r.kind + '/' + (r.name || '?') + (r.host ? style.dim('  host ' + r.host) : ''));
        }
    }

    const cm = generatedResources(result.parts).filter((r) => r.kind === 'ConfigMap');
    if (cm.length) {
        lines.push('');
        lines.push('  ' + style.cyan('ConfigMap changes'));
        for (const r of cm) lines.push(indent(r.text.replace(/^#.*\n/, ''), '    '));
    }

    for (const note of (result.plan && result.plan.infoNotes) || []) {
        lines.push('  ' + style.dim('note: ' + note.code + ' — ' + note.message));
    }

    if (gaps.length) {
        lines.push('');
        lines.push('  ' + style.cyan('Gaps') + style.dim('  (' + gaps.length + ')'));
        for (const g of gaps) {
            const label = style.sev(g.severity, '[' + (SEV_LABEL[g.severity] || g.severity) + ']');
            const body = opts.wrap ? wrapText(g.message, 76) : [g.message];
            lines.push('    ' + label + ' ' + style.bold(g.id));
            for (const b of body) lines.push('      ' + b);
        }
    }
    return lines.join('\n');
}

function wrapText(text, width) {
    const words = String(text).split(/\s+/);
    const out = [];
    let line = '';
    for (const w of words) {
        if (line && (line + ' ' + w).length > width) { out.push(line); line = w; } else {
            line = line ? line + ' ' + w : w;
        }
    }
    if (line) out.push(line);
    return out;
}

function renderReport(items, opts) {
    const style = makeStyle(opts.colour);
    const chunks = [];
    chunks.push(style.dim('nic-migrate — advisory report · strategy: ' + opts.strategy));
    chunks.push('');

    for (const item of items) {
        chunks.push(renderOne(item, style, opts));
        chunks.push('');
    }

    const totals = { blocking: 0, review: 0, note: 0 };
    for (const item of items) for (const g of item.gaps) totals[g.severity] = (totals[g.severity] || 0) + 1;
    const withAnn = items.filter((i) => i.desc.annotations.length > 0).length;

    chunks.push(style.dim('─'.repeat(60)));
    chunks.push(
        items.length + ' Ingress' + (items.length !== 1 ? 'es' : '') + ' · ' +
        withAnn + ' with community annotations · ' +
        style.sev('blocking', totals.blocking + ' blocking') + ' · ' +
        style.sev('review', totals.review + ' review') + ' · ' +
        style.dim(totals.note + ' note')
    );
    chunks.push(style.yellow(
        'Generated YAML is ADVISORY. Each CRD is a single-feature illustration, not an applyable\n' +
        'manifest set — resolve every blocking gap before you apply anything.'
    ));
    return chunks.join('\n');
}

function toJson(items, opts) {
    return {
        tool: 'nic-migrate',
        mode: 'report',
        advisory: true,
        strategy: opts.strategy,
        ingresses: items.map((item) => ({
            name: item.desc.name,
            namespace: item.desc.namespace,
            source: item.sourceFile || null,
            hosts: item.desc.hosts,
            paths: item.desc.paths,
            services: item.desc.services,
            tlsSecrets: item.desc.tlsSecrets,
            ingressClassName: item.desc.ingressClassName || item.desc.classAnnotation,
            communityAnnotations: item.desc.annotations,
            complexity: (item.result.plan && item.result.plan.banner && item.result.plan.banner.complexity) || null,
            error: item.result.error || null,
            generated: generatedResources(item.result.parts).map((r) => ({
                kind: r.kind, name: r.name, host: r.host
            })),
            yaml: item.result.yaml || null,
            gaps: item.gaps
        }))
    };
}

/* Header written above the generated YAML in -o output. Provenance plus the
   gaps, so the file is self-describing once it leaves the terminal. */
function fileHeader(item) {
    const desc = item.desc;
    const lines = [
        '# Generated by nic-migrate (report mode) — ADVISORY OUTPUT, DO NOT APPLY UNREVIEWED.',
        '#',
        '# Source Ingress: ' + (desc.namespace ? desc.namespace + '/' : '') + desc.name +
            (item.sourceFile ? '   from ' + item.sourceFile : ''),
        '# Hosts: ' + (desc.hosts.join(', ') || '(none)'),
        '#',
        '# Each resource below illustrates ONE migrated feature against a single',
        '# host/service/path. Resources are not merged and Policies are not wired in.'
    ];
    if (item.gaps.length) {
        lines.push('#');
        lines.push('# Gaps to resolve before applying:');
        for (const g of sortGaps(item.gaps)) {
            lines.push('#   [' + g.severity + '] ' + g.id);
            for (const l of wrapText(g.message, 72)) lines.push('#       ' + l);
        }
    }
    lines.push('');
    return lines.join('\n');
}

module.exports = { renderReport, toJson, fileHeader, makeStyle };
