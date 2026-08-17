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
const { splitDocuments, isIngress, kindOf, describe } = require('./lib/ingress');
const { detect, sortGaps } = require('./lib/gaps');
const { renderReport, toJson, fileHeader, makeStyle } = require('./lib/render');
const yaml = require('./lib/yaml');
const { toModel, convert } = require('./lib/convert');

const USAGE = `nic-migrate — ingress-nginx -> F5 NGINX Ingress Controller  (beta)

  node tools/nic-migrate/nic-migrate.js report [options]     what would change, and what the analyzer cannot do
  node tools/nic-migrate/nic-migrate.js convert [options]    merged, applyable manifests
  node tools/nic-migrate/nic-migrate.js checklist

Input (choose one; defaults to stdin)
  -f, --file <path>        YAML file, or a directory scanned for .yaml/.yml.
                           Repeatable.
  -k, --kubectl            Read live Ingresses with kubectl.
  -n, --namespace <ns>     Namespace for --kubectl (default: all namespaces).

Common
  -s, --strategy <name>    crd | annotation            (default: crd)
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

function readKubectl(namespace) {
    const args = ['get', 'ingress', '-o', 'yaml'];
    if (namespace) args.push('-n', namespace); else args.push('--all-namespaces');
    try {
        return execFileSync('kubectl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
        const stderr = (err.stderr || '').toString().trim();
        throw new Error('kubectl failed: ' + (stderr || err.message));
    }
}

/* `kubectl get -o yaml` over multiple objects returns a single List document
   rather than a multi-document stream. Split it back into items so each Ingress
   is analyzed on its own. */
function splitKubectlList(text) {
    if (!/^kind:\s*List\s*$/m.test(text)) return splitDocuments(text);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex((l) => /^items:\s*$/.test(l));
    if (start === -1) return splitDocuments(text);
    const docs = [];
    let cur = null;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        /* Item check first: a list entry begins "- " at column 0, which is also
           non-whitespace, so a top-level test placed ahead of this one ends the
           scan on the very first item. */
        if (/^- /.test(line)) {
            if (cur) docs.push(cur.join('\n'));
            cur = [line.replace(/^- /, '')];
        } else if (/^\S/.test(line) && line.trim() !== '') {
            break; // a sibling top-level key, e.g. the List's own trailing metadata:
        } else if (cur) {
            cur.push(line.replace(/^ {2}/, ''));
        }
    }
    if (cur) docs.push(cur.join('\n'));
    return docs.length ? docs : splitDocuments(text);
}

function loadChecklist() {
    const html = fs.readFileSync(path.join(ROOT, 'ingress-nginx-migration.html'), 'utf8');
    const block = html.match(/id="migrationChecklist"[\s\S]*?<\/ul>/);
    if (!block) throw new Error('could not find the checklist in ingress-nginx-migration.html');
    const items = [];
    const re = /<li\b[^>]*>\s*<span>([\s\S]*?)<\/span>/g;
    let m;
    while ((m = re.exec(block[0])) !== null) {
        items.push(m[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim());
    }
    return items;
}

/* Expand every input source into Ingress objects. Unlike report, this parses
   properly, so a kubectl List is just a document with an items array — no
   string surgery. */
function collectIngresses(sources) {
    const out = [];
    let skipped = 0;
    for (const src of sources) {
        let docs;
        try {
            docs = yaml.parseAll(src.text);
        } catch (err) {
            throw new Error(src.file + ': ' + err.message);
        }
        const flat = [];
        for (const doc of docs) {
            if (doc && doc.kind === 'List' && Array.isArray(doc.items)) flat.push(...doc.items);
            else flat.push(doc);
        }
        for (const doc of flat) {
            if (!doc || typeof doc !== 'object') continue;
            if (doc.kind !== 'Ingress') { if (doc.kind) skipped++; continue; }
            out.push({ doc, sourceFile: src.file });
        }
    }
    return { ingresses: out, skipped };
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

function runConvert(sources, engine, strategy, opts) {
    if (opts.target !== 'virtualserver' && opts.target !== 'ingress') {
        process.stderr.write('error: unknown target "' + opts.target + '" (expected: virtualserver, ingress)\n');
        return 2;
    }

    const { ingresses, skipped } = collectIngresses(sources);
    if (!ingresses.length) {
        process.stderr.write('error: no Ingress documents found' +
            (skipped ? ' (' + skipped + ' non-Ingress document' + (skipped !== 1 ? 's' : '') + ' skipped)' : '') + '\n');
        return 1;
    }

    const results = [];
    for (const { doc, sourceFile } of ingresses) {
        const model = toModel(doc);
        // Feed the engine canonical YAML re-emitted from the parsed document,
        // so what it analyzes is exactly what was parsed.
        const result = engine.analyze(yaml.stringify(doc), strategy);
        const converted = convert(model, result, opts);
        results.push({ model, sourceFile, converted, warnings: result.warnings });
    }

    const colour = opts.colour === false || process.env.NO_COLOR ? false : process.stderr.isTTY === true;
    const style = makeStyle(colour);

    if (opts.json) {
        process.stdout.write(JSON.stringify({
            tool: 'nic-migrate',
            mode: 'convert',
            target: opts.target,
            strategy,
            ingresses: results.map((r) => ({
                name: r.model.name,
                namespace: r.model.namespace,
                source: r.sourceFile,
                documents: r.converted.docs,
                notes: r.converted.notes,
                generatorWarnings: r.warnings
            }))
        }, null, 2) + '\n');
        return 0;
    }

    let exitCode = 0;
    if (opts.out) {
        fs.mkdirSync(opts.out, { recursive: true });
        for (const r of results) {
            const base = (r.model.namespace ? r.model.namespace + '-' : '') + r.model.name;
            const file = path.join(opts.out, base.replace(/[^A-Za-z0-9._-]/g, '_') + '.yaml');
            fs.writeFileSync(file, renderConverted(r, opts, false));
        }
        process.stderr.write('wrote ' + results.length + ' file' + (results.length !== 1 ? 's' : '') +
            ' to ' + opts.out + '\n');
    } else {
        process.stdout.write(results.map((r) => renderConverted(r, opts, false)).join('---\n'));
    }

    // Notes and warnings go to stderr so stdout stays pipeable into kubectl.
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

function renderConverted(r, opts, _colour) {
    const header = [
        '# Generated by nic-migrate convert --target ' + opts.target + '.',
        '# Source: ' + (r.model.namespace ? r.model.namespace + '/' : '') + r.model.name +
            (r.sourceFile ? '   from ' + r.sourceFile : '')
    ];
    for (const n of r.converted.notes) header.push('# NOTE: ' + n);
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
        const items = loadChecklist();
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
        sources.push({ file: 'kubectl', text: readKubectl(opts.namespace), isList: true });
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

    const engine = createEngine();
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

    if (opts.command === 'convert') return runConvert(sources, engine, strategy, opts);

    const items = [];
    let skipped = 0;
    for (const src of sources) {
        const docs = src.isList ? splitKubectlList(src.text) : splitDocuments(src.text);
        for (const doc of docs) {
            if (!isIngress(doc)) { if (kindOf(doc)) skipped++; continue; }
            const desc = describe(doc);
            const result = engine.analyze(doc, strategy);
            items.push({ desc, result, sourceFile: src.file, gaps: sortGaps(detect(desc, result)) });
        }
    }

    if (!items.length) {
        process.stderr.write('error: no Ingress documents found' +
            (skipped ? ' (' + skipped + ' non-Ingress document' + (skipped !== 1 ? 's' : '') + ' skipped)' : '') + '\n');
        return 1;
    }

    const colour = opts.colour === false || process.env.NO_COLOR ? false : process.stdout.isTTY === true;
    const renderOpts = { strategy, colour, wrap: true };

    if (opts.json) {
        process.stdout.write(JSON.stringify(toJson(items, renderOpts), null, 2) + '\n');
    } else {
        process.stdout.write(renderReport(items, renderOpts) + '\n');
        if (skipped) {
            process.stdout.write('\n' + skipped + ' non-Ingress document' +
                (skipped !== 1 ? 's' : '') + ' skipped.\n');
        }
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

module.exports = { main, loadChecklist, splitKubectlList, SOURCE_MODULE };
