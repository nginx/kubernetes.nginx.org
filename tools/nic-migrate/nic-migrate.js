#!/usr/bin/env node
'use strict';
/* nic-migrate — batch the site's migration analyzer over real Ingress manifests.
   =========================================================================
   Stage 1 (this file) is deliberately ADVISORY. It runs the same engine the web
   tool runs, one Ingress document at a time instead of one textarea at a time,
   and adds the thing a paste box cannot: a per-Ingress account of what the
   engine's single-context model left behind. It does not produce manifests you
   should apply unreviewed, and it says so in every output mode.

   Zero dependencies, matching the rest of the repo's tooling. Run it from a
   checkout — it reads the mapping database out of assets/js/ rather than
   vendoring a copy, so it cannot drift from the published page.

   Usage:  node tools/nic-migrate/nic-migrate.js report --help
   ========================================================================= */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createEngine, ROOT, SOURCE_MODULE } = require('./lib/engine');
const { DEFAULT_SOURCE, resolveSource } = require('./lib/sources');
const { readIngresses, describe } = require('./lib/ingress');
const { detect, sortGaps, sharedHosts } = require('./lib/gaps');
const { renderReport, toJson, fileHeader, makeStyle } = require('./lib/render');
const yaml = require('./lib/yaml');
const { toModel, convertAll, configMapDoc } = require('./lib/convert');

const USAGE = `nic-migrate — Ingress-NGINX | HAProxy -> NGINX Ingress Controller  (beta)

  node tools/nic-migrate/nic-migrate.js report [options]     what would change, and what the analyzer cannot do
  node tools/nic-migrate/nic-migrate.js convert [options]    merged, applyable manifests
  node tools/nic-migrate/nic-migrate.js checklist

Input (choose one; defaults to stdin)
  -f, --file <path>        YAML file, or a directory scanned for .yaml/.yml.
                           Repeatable.
  -k, --kubectl            Read the live cluster with kubectl (for HAProxy,
                           its Services, ConfigMaps and CRs too).
  -n, --namespace <ns>     Namespace for --kubectl (default: all namespaces).

Common
  -s, --strategy <name>    crd | annotation            (default: crd)
      --source <name>      ingress-nginx | haproxy | traefik  (default: ingress-nginx)
                           Which migration tool's analyzer to run. HAProxy also
                           reads the Services an Ingress routes to, the
                           controller ConfigMap and its CRs, and applies them
                           as HAProxy does (Service > Ingress > ConfigMap).
                           convert supports ingress-nginx and haproxy.
      --whole-input        Analyze all input as one unit instead of per
                           document, so cross-document references resolve
                           (Traefik IngressRoute -> Middleware). report only.
  -o, --out <dir>          Write per-Ingress YAML files instead of stdout.
      --json               Emit JSON instead of the text report.
      --no-color           Disable ANSI colour (also honours NO_COLOR).
  -h, --help               This text.

report
      --strict             Exit 1 if any blocking gap was found.

convert
  -t, --target <kind>      virtualserver | ingress     (default: virtualserver)
                           virtualserver: one merged VirtualServer per host.
                           ingress: keep the Ingress, rewrite its annotations.
      --class <name>       Set ingressClassName on the output (default: keep
                           the source's). Use a distinct class to run both
                           controllers side by side.
      --name-suffix <s>    Append to the generated resource names. With
                           --target ingress the output otherwise reuses the
                           source's name, so applying it REPLACES the Ingress
                           being migrated — right for a cutover, wrong for
                           running both side by side.
      --validate           Check the output with kubectl apply --dry-run.

report is advisory: it shows the analyzer's single-feature illustrations and
names what they leave out. convert merges those into manifests you can apply —
read its notes, and always --validate before you trust it.

Beta: flags and generated output may still change. Review before you apply.`;

function parseArgs(argv) {
    const opts = {
        command: null, files: [], kubectl: false, namespace: null, strategy: null,
        source: DEFAULT_SOURCE, wholeInput: false,
        out: null, json: false, colour: null, strict: false, help: false,
        target: 'virtualserver', ingressClass: null, validate: false, nameSuffix: ''
    };
    let i = 0;
    if (argv[i] && !argv[i].startsWith('-')) opts.command = argv[i++];
    for (; i < argv.length; i++) {
        const a = argv[i];
        const need = (name) => {
            const v = argv[++i];
            if (v === undefined) throw new Error(name + ' needs a value');
            return v;
        };
        if (a === '-f' || a === '--file') opts.files.push(need(a));
        else if (a === '-k' || a === '--kubectl') opts.kubectl = true;
        else if (a === '-n' || a === '--namespace') opts.namespace = need(a);
        else if (a === '-s' || a === '--strategy') opts.strategy = need(a);
        else if (a === '--source') opts.source = need(a);
        else if (a === '--whole-input') opts.wholeInput = true;
        else if (a === '-o' || a === '--out') opts.out = need(a);
        else if (a === '--json') opts.json = true;
        else if (a === '--no-color' || a === '--no-colour') opts.colour = false;
        else if (a === '--strict') opts.strict = true;
        else if (a === '-t' || a === '--target') opts.target = need(a);
        else if (a === '--class') opts.ingressClass = need(a);
        else if (a === '--name-suffix') opts.nameSuffix = need(a);
        else if (a === '--validate') opts.validate = true;
        else if (a === '-h' || a === '--help') opts.help = true;
        else throw new Error('unknown option: ' + a);
    }
    /* Resolve here, not at engine construction: main() reads stdin before it
       builds the engine, so a bad --source would block on a pipe that never
       closes instead of failing. resolveSource throws with the valid names. */
    resolveSource(opts.source);
    return opts;
}

function collectFiles(target) {
    const st = fs.statSync(target);
    if (st.isFile()) return [target];
    const out = [];
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const p = path.join(target, entry.name);
        if (entry.isDirectory()) out.push(...collectFiles(p));
        else if (/\.ya?ml$/i.test(entry.name)) out.push(p);
    }
    return out.sort();
}

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

/* Every resource the source reads, one `kubectl get` each: a CRD that is not
   installed (no HAProxy v1 group, say) skips its kind with a note instead of
   failing the read. The Ingress read is the one that must succeed. */
function readKubectl(namespace, resources) {
    const texts = [];
    for (const res of resources || ['ingress']) {
        const args = ['get', res, '-o', 'yaml'];
        if (namespace) args.push('-n', namespace); else args.push('--all-namespaces');
        try {
            texts.push(execFileSync('kubectl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
        } catch (err) {
            const stderr = (err.stderr || '').toString().trim();
            if (res !== 'ingress' && /the server doesn't have a resource type|could not find the requested resource/i.test(stderr)) {
                process.stderr.write('note: kubectl has no ' + res + ' in this cluster; skipped\n');
                continue;
            }
            throw new Error('kubectl failed: ' + (stderr || err.message));
        }
    }
    return texts.join('\n---\n');
}

function loadChecklist(page) {
    const file = page || 'ingress-nginx-migration.html';
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const block = html.match(/id="migrationChecklist"[\s\S]*?<\/ul>/);
    if (!block) throw new Error('could not find the checklist in ' + file);
    const items = [];
    const re = /<li\b[^>]*>\s*<span>([\s\S]*?)<\/span>/g;
    let m;
    while ((m = re.exec(block[0])) !== null) {
        items.push(m[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&rarr;/g, '→')
            .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim());
    }
    return items;
}

/* Every Ingress in every input source, through the site's own parser: a
   kubectl List or IngressList is a document with items, JSON is YAML. A
   document that does not parse is reported by line and skipped. `kinds` is
   the source's: HAProxy keeps settings on Services, a ConfigMap and CRs too. */
function collectIngresses(sources, kinds, units) {
    const ingresses = [];
    const run = [];
    const skipped = {};
    const isUnit = (doc) => (units || ['Ingress']).indexOf(doc.kind) !== -1;
    for (const src of sources) {
        const read = readIngresses(src.text, kinds);
        for (const e of read.errors) process.stderr.write('warning: ' + src.file + ': ' + e + ' — document skipped\n');
        for (const doc of read.ingresses) {
            run.push(doc);
            if (isUnit(doc)) ingresses.push({ doc, sourceFile: src.file });
        }
        for (const k of Object.keys(read.skipped)) skipped[k] = (skipped[k] || 0) + read.skipped[k];
    }
    // `run` is every document read, units included: what the source resolves
    // each unit against (HAProxy: the Services, ConfigMap and CRs).
    return { ingresses, run, skipped };
}

function skippedText(skipped) {
    const kinds = Object.keys(skipped);
    return kinds.length ? ' (' + kinds.map((k) => skipped[k] + ' ' + k).join(', ') + ' skipped)' : '';
}

/* An unreachable or non-discoverable cluster, as distinct from a manifest the
   cluster rejected. Getting this wrong in either direction is bad: treat a
   connectivity error as a validation failure and the tool cries wolf; treat a
   real rejection as connectivity and it silently downgrades to a check that
   would not have caught it. */
const NO_CLUSTER = /connection refused|no configuration has been provided|couldn't get current server|Unauthorized|dial tcp|failed to download openapi|could not find the requested resource|context deadline exceeded|no such host|i\/o timeout|The connection to the server .* was refused/i;

function runKubectl(args, input) {
    try {
        return { ok: true, output: execFileSync('kubectl', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() };
    } catch (err) {
        if (err.code === 'ENOENT') return { ok: false, missing: true, output: 'kubectl is not on PATH' };
        return { ok: false, output: (((err.stderr || '') + '').trim() || err.message) };
    }
}

/* What can be checked with no cluster at all. Deliberately weak — it is here so
   an offline run reports something true, not so it can stand in for the real
   thing. */
function structuralCheck(docs) {
    const problems = [];
    docs.forEach((doc, i) => {
        const at = 'document ' + (i + 1) + (doc && doc.kind ? ' (' + doc.kind + ')' : '');
        if (!doc || typeof doc !== 'object') { problems.push(at + ': not an object'); return; }
        if (!doc.apiVersion) problems.push(at + ': no apiVersion');
        if (!doc.kind) problems.push(at + ': no kind');
        if (!doc.metadata || !doc.metadata.name) problems.push(at + ': no metadata.name');
    });
    return problems;
}

/* Server-side dry-run is the real check — it is the one that catches a CRD that
   is not installed, which is the most common failure here.

   With no cluster there is no weaker kubectl mode to fall back to: even
   --dry-run=client needs server discovery to recognise a kind, so it fails on
   every VirtualServer. So an unreachable cluster is reported as validation NOT
   HAVING RUN rather than as a pass. --validate means "check this against a
   cluster"; if that cannot happen, saying "ok" would be the exact failure the
   repo's checks are written to avoid. */
function validateWithKubectl(text, docs) {
    const server = runKubectl(['apply', '--dry-run=server', '-f', '-'], text);
    if (server.ok) return { ok: true, mode: 'server', output: server.output };
    if (server.missing) return { ok: false, mode: 'unavailable', reason: server.output, problems: structuralCheck(docs) };
    if (!NO_CLUSTER.test(server.output)) return { ok: false, mode: 'server', output: server.output };
    return {
        ok: false,
        mode: 'unavailable',
        reason: 'kubectl could not reach a cluster',
        detail: server.output.split('\n').slice(-2).join('\n'),
        problems: structuralCheck(docs)
    };
}

function runConvert(sources, engine, strategy, opts, srcInfo) {
    if (opts.target !== 'virtualserver' && opts.target !== 'ingress') {
        process.stderr.write('error: unknown target "' + opts.target + '" (expected: virtualserver, ingress)\n');
        return 2;
    }

    /* convert runs the source module's own whole-Ingress assembler, the one
       its page calls. A source without one has nothing to convert with, and
       a partial answer here would be applied, so refuse it by name. */
    if (typeof engine.source.analyzer.migrateMany !== 'function') {
        process.stderr.write('error: convert does not support --source ' + srcInfo.id +
            ' yet; run `report --source ' + srcInfo.id + '` for its analysis\n');
        return 2;
    }

    const { ingresses, run, skipped } = collectIngresses(sources, srcInfo.kinds, srcInfo.units);
    if (!ingresses.length) {
        process.stderr.write('error: no Ingress documents found' + skippedText(skipped) + '\n');
        return 1;
    }

    /* With --kubectl the cluster is the source, so it can answer what a
       manifest cannot: a Service's first port, which is what the community
       controller used for a default-backend Service. */
    const ports = new Map();
    const resolveServicePort = !opts.kubectl ? null : (namespace, name) => {
        const key = (namespace || '') + '/' + name;
        // Both come from cluster data; neither may become a kubectl flag.
        if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || (namespace && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace))) return null;
        if (!ports.has(key)) {
            const args = ['get', 'service', name, '-o', 'jsonpath={.spec.ports[0].port}'];
            if (namespace) args.push('-n', namespace);
            const r = runKubectl(args);
            ports.set(key, r.ok && /^\d+$/.test(r.output) ? Number(r.output) : null);
        }
        return ports.get(key);
    };

    const models = ingresses.map(({ doc }) => toModel(doc));
    const converted = convertAll(models, engine, Object.assign({ resolveServicePort, strategy }, opts), run);
    const all = converted.map((c, i) => ({ model: models[i], sourceFile: ingresses[i].sourceFile, converted: c, warnings: c.warnings || [] }));
    // What the source returned for the controller as a whole (HAProxy: the
    // GlobalConfiguration and TransportServers its ConfigMap and CRs need).
    const controller = converted.controller && (converted.controller.docs.length || converted.controller.notes.length)
        ? { model: { name: 'controller', namespace: null }, sourceFile: null, converted: converted.controller, warnings: [] } : null;
    // A canary folded into its stable Ingress's VirtualServer emits nothing of
    // its own; its notes are still reported. An Ingress the source controller
    // refused emits nothing either, and is reported as an error.
    const refused = all.filter((r) => r.converted.refused);
    const results = all.filter((r) => !r.converted.refused && (r.converted.mergedInto === null || r.converted.mergedInto === undefined));
    for (const r of all) {
        if (r.converted.mergedInto !== null && r.converted.mergedInto !== undefined) {
            const into = all[r.converted.mergedInto];
            // The source says why it merged (a Traefik host shared by several
            // IngressRoutes); otherwise it was a canary Ingress.
            into.converted.notes.push(r.converted.mergeNote || ('canary Ingress ' + r.model.name + ' merged into this VirtualServer'));
            into.converted.notes.push(...r.converted.notes.map((n) => r.model.name + ': ' + n));
        }
    }
    const cm = configMapDoc(converted.concat(controller ? [controller.converted] : []));
    if (controller) results.push(controller);

    const colour = opts.colour === false || process.env.NO_COLOR ? false : process.stderr.isTTY === true;
    const style = makeStyle(colour);

    if (opts.json) {
        process.stdout.write(JSON.stringify({
            tool: 'nic-migrate',
            mode: 'convert',
            target: opts.target,
            strategy,
            configMap: cm ? { merge: cm.doc, conflicts: cm.conflicts } : null,
            ingresses: results.map((r) => ({
                name: r.model.name,
                namespace: r.model.namespace,
                source: r.sourceFile,
                documents: r.converted.docs,
                mergedCanaries: all.filter((x) => x.converted.mergedInto === all.indexOf(r)).map((x) => x.model.name),
                notes: r.converted.notes,
                generatorWarnings: r.warnings
            })),
            refused: refused.map((r) => ({ name: r.model.name, namespace: r.model.namespace, source: r.sourceFile, error: r.converted.refused }))
        }, null, 2) + '\n');
        // A translator that failed means part of the output is missing, and a
        // refused Ingress means all of that one is.
        return results.some((r) => r.warnings.length) || refused.length ? 1 : 0;
    }

    let exitCode = 0;
    if (opts.out) {
        fs.mkdirSync(opts.out, { recursive: true });
        for (const r of results) {
            const base = (r.model.namespace ? r.model.namespace + '-' : '') + r.model.name;
            const file = path.join(opts.out, base.replace(/[^A-Za-z0-9._-]/g, '_') + '.yaml');
            fs.writeFileSync(file, renderConverted(r, opts, false));
        }
        if (cm) fs.writeFileSync(path.join(opts.out, 'nginx-config.merge.yaml'), renderConfigMap(cm));
        process.stderr.write('wrote ' + results.length + ' file' + (results.length !== 1 ? 's' : '') +
            (cm ? ' and nginx-config.merge.yaml' : '') + ' to ' + opts.out + '\n');
    } else {
        process.stdout.write(results.map((r) => renderConverted(r, opts, false)).join('---\n'));
        if (cm) process.stdout.write('---\n' + renderConfigMap(cm));
    }

    // Notes and warnings go to stderr so stdout stays pipeable into kubectl.
    for (const r of refused) {
        const e = r.converted.refused;
        process.stderr.write(style.red('✗ ' + e.title + ' — ' + e.message) + '\n');
        for (const x of e.items) process.stderr.write(style.red('    ' + x.code + ' — ' + x.message) + '\n');
        exitCode = 1;
    }
    for (const r of results) {
        const label = (r.model.namespace ? r.model.namespace + '/' : '') + r.model.name;
        for (const w of r.warnings) {
            process.stderr.write(style.red('! ' + label + ': generator failed, a resource is missing — ' + w) + '\n');
            exitCode = 1;
        }
        for (const n of r.converted.notes) {
            process.stderr.write(style.yellow('· ' + label + ': ' + n) + '\n');
        }
    }

    if (opts.validate) {
        const allDocs = results.flatMap((r) => r.converted.docs);
        const v = validateWithKubectl(yaml.stringifyAll(allDocs), allDocs);
        if (v.ok) {
            process.stderr.write(style.green('\nkubectl apply --dry-run=server: ok (' + allDocs.length + ' documents)') + '\n');
        } else if (v.mode === 'unavailable') {
            process.stderr.write(style.yellow('\nvalidation DID NOT RUN — ' + v.reason + '.') + '\n');
            if (v.detail) process.stderr.write(style.dim('  ' + v.detail.replace(/\n/g, '\n  ')) + '\n');
            if (v.problems.length) {
                process.stderr.write(style.red('  local structural check found ' + v.problems.length + ' problem(s):') + '\n');
                for (const p of v.problems) process.stderr.write('    ' + p + '\n');
            } else {
                process.stderr.write(style.dim('  local structural check passed (' + allDocs.length +
                    ' documents have apiVersion, kind and metadata.name) — schemas and CRDs unverified.') + '\n');
            }
            exitCode = 1;
        } else {
            process.stderr.write(style.red('\nkubectl apply --dry-run=server rejected the output:') + '\n' + v.output + '\n');
            exitCode = 1;
        }
    }
    return exitCode;
}

/* A header entry as comment lines. A note can quote a multi-line annotation
   value (a snippet): written raw, its second line was YAML and the file no
   longer parsed. Continuation lines are indented under the label. */
function commentLines(label, text) {
    const pad = '#' + ' '.repeat(label.length + 1);
    return String(text).replace(/\n+$/, '').split('\n').map((l, i) => (i ? pad + l : '# ' + label + l).replace(/\s+$/, ''));
}

/* The ConfigMap keys the run needs. nginx-config is global and already
   exists, so this is a set of keys to merge, not a resource to apply as-is. */
function renderConfigMap(cm) {
    const header = [
        '# Merge these keys into the existing nginx-config ConfigMap — it is global, so',
        '# they affect every Ingress and VirtualServer. Do not apply this file over it.'
    ];
    for (const c of cm.conflicts) header.push(...commentLines('NOTE: ', 'Ingresses disagree on ' + c + '; the first value is kept.'));
    return header.join('\n') + '\n' + yaml.stringify(cm.doc);
}

function renderConverted(r, opts, _colour) {
    const header = [
        '# Generated by nic-migrate convert --target ' + opts.target + '.',
        ...commentLines('Source: ', (r.model.namespace ? r.model.namespace + '/' : '') + r.model.name +
            (r.sourceFile ? '   from ' + r.sourceFile : ''))
    ];
    for (const n of r.converted.notes) header.push(...commentLines('NOTE: ', n));
    header.push('');
    return header.join('\n') + yaml.stringifyAll(r.converted.docs);
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write('error: ' + err.message + '\n\n' + USAGE + '\n');
        return 2;
    }
    if (opts.help || !opts.command) {
        process.stdout.write(USAGE + '\n');
        return opts.help ? 0 : 2;
    }

    if (opts.command === 'checklist') {
        const items = loadChecklist(resolveSource(opts.source).page);
        process.stdout.write('Migration checklist (' + items.length + ' items, from the published page)\n\n');
        items.forEach((t, i) => process.stdout.write('  ' + String(i + 1).padStart(2) + '. [ ] ' + t + '\n'));
        return 0;
    }
    if (opts.command !== 'report' && opts.command !== 'convert') {
        process.stderr.write('error: unknown command "' + opts.command + '"\n\n' + USAGE + '\n');
        return 2;
    }

    // Gather input.
    const sources = [];
    if (opts.kubectl) {
        sources.push({ file: 'kubectl', text: readKubectl(opts.namespace, resolveSource(opts.source).kubectl) });
    } else if (opts.files.length) {
        for (const target of opts.files) {
            for (const file of collectFiles(target)) {
                sources.push({ file: path.relative(process.cwd(), file), text: fs.readFileSync(file, 'utf8') });
            }
        }
    } else {
        const text = readStdin();
        if (!text.trim()) {
            process.stderr.write('error: no input (pass -f/--file, --kubectl, or pipe YAML on stdin)\n');
            return 2;
        }
        sources.push({ file: '(stdin)', text });
    }

    const engine = createEngine(opts.source);
    const srcInfo = engine.sourceInfo;
    /* Target and strategy are coupled: asking for an Ingress and then running
       the CRD-first strategy produces CRD fragments the Ingress target cannot
       carry, and every one becomes a note about something missing. The
       annotation strategy is what "keep the Ingress" means. An explicit
       --strategy still wins. */
    const strategy = opts.strategy
        || (opts.command === 'convert' && opts.target === 'ingress' ? 'annotation' : engine.defaultStrategy);
    if (engine.strategies.length && engine.strategies.indexOf(strategy) === -1) {
        process.stderr.write('error: unknown strategy "' + strategy + '" (expected: ' +
            engine.strategies.join(', ') + ')\n');
        return 2;
    }

    if (opts.command === 'convert') return runConvert(sources, engine, strategy, opts, srcInfo);

    const { ingresses, run, skipped } = collectIngresses(sources, srcInfo.kinds, srcInfo.units);
    let items;
    if (opts.wholeInput) {
        /* One analysis over everything, the way the web tool treats a paste.
           A Traefik IngressRoute references Middlewares that are separate
           documents by design; analyzed alone, every one of those references
           reports as unresolved. HAProxy needs no flag: each Ingress is
           already analyzed with the Services, ConfigMap and CRs of the run. */
        items = [];
        if (ingresses.length) {
            // A synthesised description: the union of what every document carries.
            const descs = ingresses.map(({ doc }) => describe(doc, srcInfo.prefixes));
            const union = (key) => [...new Set(descs.flatMap((d) => d[key] || []))];
            const desc = {
                kind: 'Input',
                name: '(whole input, ' + ingresses.length + ' document' + (ingresses.length !== 1 ? 's' : '') + ')',
                namespace: null,
                ingressClassName: descs.map((d) => d.ingressClassName).find(Boolean) || null,
                classAnnotation: null,
                hosts: union('hosts'),
                paths: descs.reduce((n, d) => n + (d.paths || 0), 0),
                services: union('services'),
                hasTls: descs.some((d) => d.hasTls),
                tlsSecrets: union('tlsSecrets'),
                annotations: union('annotations')
            };
            const result = engine.analyze(yaml.stringifyAll(run), strategy);
            items.push({ desc, result, sourceFile: sources.map((src) => src.file).join(', '),
                         gaps: sortGaps(detect(desc, result, srcInfo)) });
        }
    } else {
        // The run's other documents, analyzed with each unit: HAProxy reads an
        // Ingress's settings from the Services it routes to and the controller
        // ConfigMap and CRs too. ingress-nginx reads the Ingress alone.
        const context = run.filter((d) => (srcInfo.units || ['Ingress']).indexOf(d.kind) === -1);
        // Per Ingress: the Services it routes to and the controller ConfigMap /
        // CRs, so its entry shows what HAProxy applied to it and not the rest of
        // the run. The global part is reported once, after the Ingresses.
        const servicesOf = (doc) => {
            const names = new Set();
            const spec = (doc && doc.spec) || {};
            const add = (b) => { const n = b && ((b.service && b.service.name) || b.serviceName); if (n) names.add(String(n)); };
            add(spec.defaultBackend || spec.backend);
            for (const r of spec.rules || []) for (const p of ((r && r.http && r.http.paths) || [])) add(p && p.backend);
            return names;
        };
        const ns = (d) => (d.metadata && d.metadata.namespace) || null;
        items = ingresses.map(({ doc, sourceFile }) => {
            const desc = describe(doc, srcInfo.prefixes);
            const svcs = servicesOf(doc);
            const own = context.filter((d) => d.kind !== 'Service' || (svcs.has(String(d.metadata && d.metadata.name)) && (ns(d) === ns(doc) || !ns(d) || !ns(doc))));
            // The engine analyzes the parsed object, re-emitted: what it reads is
            // exactly what was parsed, whatever the input's form.
            const result = engine.analyze(yaml.stringifyAll([doc].concat(own)), strategy);
            return { desc, result, sourceFile, gaps: detect(desc, result, srcInfo) };
        });
        // Across the run: a host several Ingresses route (report reads each alone).
        sharedHosts(items);
        for (const item of items) item.gaps = sortGaps(item.gaps);
        // A run with no unit but global settings (a ConfigMap or CRs alone) is
        // still reported, as the page reports it.
        if (!items.length && context.length) {
            const result = engine.analyze(yaml.stringifyAll(context), strategy);
            const desc = { kind: 'controller', name: 'controller settings', namespace: null, ingressClassName: null, classAnnotation: null, hosts: [], paths: 0, services: [], hasTls: false, tlsSecrets: [], annotations: context.map((d) => d.kind) };
            items.push({ desc, result, sourceFile: null, gaps: sortGaps(detect(desc, result, srcInfo)) });
        }
    }

    if (!items.length) {
        process.stderr.write('error: no ' + srcInfo.unit + ' documents found' + skippedText(skipped) + '\n');
        return 1;
    }

    const colour = opts.colour === false || process.env.NO_COLOR ? false : process.stdout.isTTY === true;
    const renderOpts = {
        strategy, colour, wrap: true,
        unit: srcInfo.unit,
        annotationLabel: srcInfo.id === 'ingress-nginx' ? 'community annotations' : srcInfo.label + ' annotations'
    };

    if (opts.json) {
        process.stdout.write(JSON.stringify(toJson(items, renderOpts), null, 2) + '\n');
    } else {
        process.stdout.write(renderReport(items, renderOpts) + '\n');
        if (Object.keys(skipped).length) process.stdout.write('\nNot read, skipped:' + skippedText(skipped).replace(/^ \(|\)$/g, ' ') + '\n');
    }

    if (opts.out) {
        fs.mkdirSync(opts.out, { recursive: true });
        let written = 0;
        for (const item of items) {
            if (!item.result.yaml) continue;
            const base = (item.desc.namespace ? item.desc.namespace + '-' : '') + item.desc.name;
            const file = path.join(opts.out, base.replace(/[^A-Za-z0-9._-]/g, '_') + '.yaml');
            fs.writeFileSync(file, fileHeader(item) + item.result.yaml + '\n');
            written++;
        }
        process.stderr.write('\nwrote ' + written + ' advisory file' + (written !== 1 ? 's' : '') +
            ' to ' + opts.out + '\n');
    }

    // A translator that failed means part of the output is missing: never 0.
    if (items.some((i) => i.result.error || (i.result.warnings || []).length)) return 1;
    const blocking = items.reduce((n, i) => n + i.gaps.filter((g) => g.severity === 'blocking').length, 0);
    return opts.strict && blocking > 0 ? 1 : 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (err) {
        process.stderr.write('error: ' + err.message + '\n');
        process.exitCode = 1;
    }
}

module.exports = { main, loadChecklist, collectIngresses, SOURCE_MODULE };
