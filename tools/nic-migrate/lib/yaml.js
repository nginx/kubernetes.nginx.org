'use strict';
/* yaml.js — a YAML subset parser and emitter for Kubernetes manifests.
   =========================================================================
   Stage 1 could get away with a line scanner because every value it read ended
   up in an advisory sentence. The converter has to round-trip values into
   manifests, so it parses properly.

   Zero dependencies is a rule here, not a preference — the repo has no package
   manager and the checks are dependency-free by design. Considered and
   rejected: shelling out to `kubectl create --dry-run=client -o json` to borrow
   kubectl's parser. It is the more correct parser, but it makes kubectl a hard
   requirement for reading a file off disk, and it cannot round-trip comments or
   emit, so an emitter would still have to be written.

   Supported: multi-document streams, block mappings and sequences, plain and
   quoted scalars, block scalars (|, |-, |+, >, >-, with explicit indentation
   indicators), comments, empty and simple flow collections, and the scalar
   coercions Kubernetes manifests actually use.

   NOT supported, because no Kubernetes manifest in the wild needs them and
   half-supporting them is worse than refusing: anchors and aliases (&x/*x),
   merge keys (<<), tags (!!str), and multi-line flow collections. parse()
   throws on an anchor or alias rather than silently dropping it.
   ========================================================================= */

/* ---------------------------------------------------------------- parsing */

function splitStream(text) {
    const normalised = String(text).replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    const lines = normalised.split('\n');
    const docs = [];
    let cur = [];
    for (const line of lines) {
        if (/^---\s*(#.*)?$/.test(line)) { docs.push(cur); cur = []; continue; }
        if (/^\.\.\.\s*$/.test(line)) { docs.push(cur); cur = []; continue; }
        cur.push(line);
    }
    docs.push(cur);
    return docs.filter((d) => d.some((l) => l.trim() !== '' && !/^\s*#/.test(l)));
}

/* Strip a trailing comment, respecting quotes. A '#' only starts a comment when
   preceded by whitespace or at the start — "a#b" is the scalar a#b. */
function stripComment(s) {
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === '\\' && quote === '"') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
    }
    return s;
}

function indentOf(line) {
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
}

function isBlank(line) {
    return line.trim() === '' || /^\s*#/.test(line);
}

class Reader {
    constructor(rawLines) {
        this.raw = rawLines.map((l) => l.replace(/\t/g, '    '));
        this.i = 0;
        // Structural view, rebuilt when a dash line is split in place.
        this.entries = this.raw.map((line) => ({
            indent: indentOf(line),
            content: stripComment(line).trim(),
            raw: line
        }));
    }

    skipBlank() {
        while (this.i < this.entries.length && isBlank(this.raw[this.i])) this.i++;
    }

    peek() {
        this.skipBlank();
        return this.i < this.entries.length ? this.entries[this.i] : null;
    }

    /* Re-home the current line at a deeper indent, for `- key: value` where the
       mapping conceptually starts after the dash. */
    respan(indent, content) {
        this.entries[this.i] = { indent, content, raw: this.raw[this.i] };
    }
}

const KEY_RE = /^((?:[^:#]|:(?=\S))+?)\s*:(\s+.*|\s*)$/;

/* Index of the closing quote of a scalar starting at position 0, or -1. */
function quoteEnd(s) {
    const q = s[0];
    for (let i = 1; i < s.length; i++) {
        if (q === '"' && s[i] === '\\') { i++; continue; }
        if (s[i] !== q) continue;
        if (q === "'" && s[i + 1] === "'") { i++; continue; } // '' is an escaped quote
        return i;
    }
    return -1;
}

/* A "key: value" line, or null when the line is a scalar.

   Quoted keys are resolved by scanning to the closing quote rather than by
   regex: the pattern backtracks into a quoted scalar, so `- "x: y"` was being
   read as the mapping {'"x': 'y"'} instead of the string `x: y`. A colon inside
   quotes is content, and only a colon *after* the closing quote opens a
   mapping. Found by fuzzing. */
function parseKeyLine(content) {
    if (content[0] === '"' || content[0] === "'") {
        const end = quoteEnd(content);
        if (end === -1) return null;
        const m = content.slice(end + 1).match(/^\s*:(\s+.*|\s*)$/);
        if (!m) return null;
        return { key: parseScalar(content.slice(0, end + 1)), rest: m[1].trim() };
    }
    const m = content.match(KEY_RE);
    if (!m) return null;
    return { key: parseScalar(m[1].trim()), rest: m[2].trim() };
}

function parseValue(reader, minIndent) {
    const line = reader.peek();
    if (!line || line.indent < minIndent) return null;
    if (/^-(\s|$)/.test(line.content)) return parseSequence(reader, line.indent);
    if (parseKeyLine(line.content)) return parseMapping(reader, line.indent);
    // A bare scalar document.
    reader.i++;
    return parseScalar(line.content);
}

function parseMapping(reader, indent) {
    const out = {};
    for (;;) {
        const line = reader.peek();
        if (!line || line.indent !== indent) break;
        const kv = parseKeyLine(line.content);
        if (!kv) break;
        const lineIndex = reader.i;
        reader.i++;
        out[kv.key] = readNodeValue(reader, kv.rest, indent, lineIndex);
    }
    return out;
}

function parseSequence(reader, indent) {
    const out = [];
    for (;;) {
        const line = reader.peek();
        if (!line || line.indent !== indent || !/^-(\s|$)/.test(line.content)) break;
        const rest = line.content.replace(/^-\s*/, '');
        const lineIndex = reader.i;
        if (rest === '') {
            reader.i++;
            out.push(parseValue(reader, indent + 1));
            continue;
        }
        // The dash line carries content. If it starts a mapping, the mapping's
        // indent is where that content begins, so nested keys on later lines
        // line up with it.
        const dashOffset = line.raw.indexOf('-', indent);
        const contentIndent = dashOffset + 1 + (line.raw.slice(dashOffset + 1).match(/^ */) || [''])[0].length;
        /* Nested sequence before mapping: the key pattern happily matches
           "- k0" out of "- - k0: v" and yields a key literally named "- k0".
           Found by fuzzing round-trips, not by reading. */
        if (/^-(\s|$)/.test(rest)) {
            reader.respan(contentIndent, rest);
            out.push(parseSequence(reader, contentIndent));
        } else if (parseKeyLine(rest)) {
            reader.respan(contentIndent, rest);
            out.push(parseMapping(reader, contentIndent));
        } else {
            reader.i++;
            out.push(readNodeValue(reader, rest, indent, lineIndex));
        }
    }
    return out;
}

/* The value for a key, which may be inline, a block scalar, or a nested block
   starting on the following line. */
function readNodeValue(reader, rest, parentIndent, lineIndex) {
    const block = rest.match(/^([|>])([-+]?)(\d*)([-+]?)\s*$/);
    if (block) return readBlockScalar(reader, block[1], (block[2] || block[4]), block[3], parentIndent);
    if (rest !== '') return parseScalar(rest);

    const next = reader.peek();
    if (!next) return null;
    if (next.indent > parentIndent) return parseValue(reader, next.indent);
    // A sequence may sit at the same indent as its key.
    if (next.indent === parentIndent && /^-(\s|$)/.test(next.content) && reader.i > lineIndex) {
        return parseSequence(reader, next.indent);
    }
    return null;
}

function readBlockScalar(reader, style, chomp, explicitIndent, parentIndent) {
    const lines = [];
    let contentIndent = explicitIndent ? parentIndent + Number(explicitIndent) : null;
    for (; reader.i < reader.entries.length; reader.i++) {
        const raw = reader.raw[reader.i];
        if (raw.trim() === '') { lines.push(''); continue; }
        const ind = indentOf(raw);
        if (contentIndent === null) {
            if (ind <= parentIndent) break;
            contentIndent = ind;
        }
        if (ind < contentIndent) break;
        lines.push(raw.slice(contentIndent));
    }
    /* Count the trailing blanks before dropping them: "keep" chomping (+) turns
       each one back into a newline, so stripping them first makes |+ and |
       indistinguishable. */
    let trailingBlanks = 0;
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); trailingBlanks++; }

    let body;
    if (style === '|') {
        body = lines.join('\n');
    } else {
        // Folded: a single newline between non-empty lines becomes a space.
        const parts = [];
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (l === '') { parts.push('\n'); continue; }
            if (i > 0 && lines[i - 1] !== '' && !/^\s/.test(l)) parts.push(' ');
            parts.push(l);
        }
        body = parts.join('').replace(/^\s+/, '');
    }
    if (chomp === '-') return body;
    if (chomp === '+') return body + '\n'.repeat(1 + trailingBlanks);
    return body === '' ? '' : body + '\n';
}

function parseScalar(s) {
    const t = String(s).trim();
    if (t === '') return null;
    if (t[0] === '&' || t[0] === '*') {
        throw new Error('anchors and aliases are not supported (found "' + t.split(/\s/)[0] + '")');
    }
    if (t === '<<') throw new Error('merge keys (<<) are not supported');
    if (t[0] === '"' && t[t.length - 1] === '"' && t.length > 1) {
        return t.slice(1, -1)
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\(["\\/nrtbf])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] || c));
    }
    if (t[0] === "'" && t[t.length - 1] === "'" && t.length > 1) {
        return t.slice(1, -1).replace(/''/g, "'");
    }
    if (t === '{}') return {};
    if (t === '[]') return [];
    if (t[0] === '{' && t[t.length - 1] === '}') return parseFlowMap(t);
    if (t[0] === '[' && t[t.length - 1] === ']') return parseFlowSeq(t);
    if (t === 'null' || t === 'Null' || t === 'NULL' || t === '~') return null;
    if (t === 'true' || t === 'True' || t === 'TRUE') return true;
    if (t === 'false' || t === 'False' || t === 'FALSE') return false;
    /* Numbers only when unambiguous. A leading zero stays a string, because
       "08" and "0755" are identifiers or modes in manifests, not integers. */
    if (/^-?(0|[1-9]\d*)$/.test(t)) return Number(t);
    if (/^-?(0|[1-9]\d*)\.\d+$/.test(t)) return Number(t);
    return t;
}

/* Split on a delimiter at flow depth 0, respecting quotes. */
function splitFlow(body, delim) {
    const out = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (quote) {
            cur += c;
            if (c === '\\' && quote === '"') { cur += body[++i] || ''; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; cur += c; continue; }
        if (c === '{' || c === '[') depth++;
        if (c === '}' || c === ']') depth--;
        if (c === delim && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim() !== '') out.push(cur);
    return out;
}

function parseFlowMap(t) {
    const out = {};
    for (const pair of splitFlow(t.slice(1, -1), ',')) {
        const idx = splitFlow(pair, ':');
        if (idx.length < 2) continue;
        out[parseScalar(idx[0].trim())] = parseScalar(idx.slice(1).join(':').trim());
    }
    return out;
}

function parseFlowSeq(t) {
    return splitFlow(t.slice(1, -1), ',').map((v) => parseScalar(v.trim()));
}

function parse(text) {
    const reader = new Reader(String(text).replace(/\r\n?/g, '\n').split('\n'));
    return parseValue(reader, 0);
}

function parseAll(text) {
    return splitStream(text).map((lines) => parseValue(new Reader(lines), 0)).filter((d) => d !== null);
}

/* --------------------------------------------------------------- emitting */

/* YAML indicator characters, which cannot open a plain scalar. */
const LEADING_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;
const RESERVED_WORD = /^(true|false|null|~|True|False|Null|TRUE|FALSE|NULL|y|Y|n|N|yes|no|on|off|Yes|No|On|Off|Yes|No)$/;

function needsQuotes(s) {
    if (s === '') return true;
    if (/[\n\r\t]/.test(s)) return true;
    if (/^\s|\s$/.test(s)) return true;
    if (LEADING_INDICATOR.test(s)) return true;
    if (RESERVED_WORD.test(s)) return true;
    // ": " opens a mapping and " #" opens a comment, anywhere in the scalar.
    if (/:\s/.test(s) || /\s#/.test(s) || /:$/.test(s)) return true;
    /* Quote anything that starts like a number. Under-quoting is a correctness
       bug and over-quoting is only cosmetic, so this is deliberately blunt:
       "0755" read by a YAML 1.1 parser — which is what Kubernetes uses — is the
       integer 493, and "1:30" is 90. Narrower rules have to enumerate octal,
       hex, exponent and sexagesimal forms, and miss one. */
    if (/^[-+.0-9]/.test(s)) return true;
    return false;
}

function quote(s) {
    if (!/["\\\n\t]/.test(s)) return '"' + s + '"';
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

function emitScalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    const s = String(v);
    if (s.includes('\n')) return null; // caller emits a block scalar
    return needsQuotes(s) ? quote(s) : s;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function emitNode(value, indent, lines) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
        if (value.length === 0) { lines[lines.length - 1] += ' []'; return; }
        for (const item of value) {
            if (isPlainObject(item) || Array.isArray(item)) {
                lines.push(pad + '-');
                const before = lines.length;
                emitNode(item, indent + 2, lines);
                // Fold the first child onto the dash line.
                if (lines.length > before) {
                    lines[before - 1] = pad + '- ' + lines[before].slice(indent + 2);
                    lines.splice(before, 1);
                }
            } else {
                const scalar = emitScalar(item);
                lines.push(pad + '- ' + (scalar === null ? quote(String(item)) : scalar));
            }
        }
        return;
    }
    if (isPlainObject(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) { lines[lines.length - 1] += ' {}'; return; }
        for (const key of keys) {
            const v = value[key];
            const k = needsQuotes(key) ? quote(key) : key;
            if (isPlainObject(v) || Array.isArray(v)) {
                const empty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
                lines.push(pad + k + ':');
                emitNode(v, indent + 2, lines);
                if (empty) continue;
            } else {
                const scalar = emitScalar(v);
                if (scalar === null) {
                    /* Chomping has to match the value or the round-trip loses a
                       newline: `|` keeps exactly one trailing newline and `|-`
                       keeps none. Emitting `|-` unconditionally silently
                       rewrites every snippet that ended in a newline — which is
                       most of them.

                       Two or more trailing newlines would need `|+`, and a `|+`
                       block at the end of a document is genuinely ambiguous with
                       the document's own final newline — it re-reads one line
                       longer than it was written. Quote those instead: ugly for
                       a snippet, but exact, and no Kubernetes annotation ends in
                       a blank line anyway. */
                    const s = String(v);
                    const trailing = (s.match(/\n*$/) || [''])[0].length;
                    if (trailing > 1) {
                        lines.push(pad + k + ': ' + quote(s));
                        continue;
                    }
                    /* A block scalar's content indent is inferred from its first
                       non-empty line. If that line is itself indented, every
                       following line looks under-indented and the scalar is
                       truncated at line two — so state the indent explicitly.
                       The indicator is relative to the parent node, hence 2. */
                    const body = s.replace(/\n+$/, '').split('\n');
                    const firstContent = body.find((l) => l !== '');
                    const explicit = firstContent && /^\s/.test(firstContent) ? '2' : '';
                    lines.push(pad + k + ': |' + explicit + (trailing === 0 ? '-' : ''));
                    for (const l of body) {
                        lines.push(l === '' ? '' : ' '.repeat(indent + 2) + l);
                    }
                } else {
                    lines.push(pad + k + ': ' + scalar);
                }
            }
        }
        return;
    }
    const scalar = emitScalar(value);
    lines.push(pad + (scalar === null ? quote(String(value)) : scalar));
}

function stringify(value) {
    const lines = [];
    emitNode(value, 0, lines);
    return lines.join('\n') + '\n';
}

function stringifyAll(docs) {
    return docs.map((d) => stringify(d)).join('---\n');
}

module.exports = { parse, parseAll, stringify, stringifyAll, splitStream, parseScalar };
