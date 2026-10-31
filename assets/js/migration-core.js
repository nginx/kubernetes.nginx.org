    /* migration-core.js — the source-agnostic engine behind the migration tool
       pages: YAML analyzer orchestration + rendering, reference-table filtering,
       page navigation, checklist persistence, and the shared MigrationTool.NIC
       target-version constants. Everything source-specific (mapping data,
       parsers, generators, strings) lives in the page's SOURCE module
       (e.g. migration-ingress-nginx.js), which defines
       window.MIGRATION_SOURCE and must load BEFORE this file:
       shared.js → migration-<source>.js → migration-core.js.
       Shared behavior (dark mode, sidebar drawer, copy-to-clipboard, copyright
       year) lives in shared.js, which loads first and exposes those globals. */
    (function() {
        'use strict';
        // Single source of truth for the NGINX Ingress Controller (the migration
        // TARGET) versions the tool pages are documented against. Bump these when
        // updating the Version Reference (see .claude/skills/release-update/SKILL.md;
        // also update the version pills/install URLs in index.html). The source
        // controller's version lives at the top of its migration-<source>.js.
        const NIC = {
            VERSION: 'v5.7.0',
            HELM_VERSION: '2.8.0'
        };
        NIC.CRD_INSTALL_CMD = 'kubectl apply -f https://raw.githubusercontent.com/nginx/kubernetes-ingress/' + NIC.VERSION + '/deploy/crds.yaml';
        NIC.HELM_INSTALL_CMD = 'helm install nginx-ingress oci://ghcr.io/nginx/charts/nginx-ingress --version ' + NIC.HELM_VERSION + ' --set controller.enableCustomResources=true';
        NIC.RELEASE_URL = 'https://github.com/nginx/kubernetes-ingress/releases/tag/' + NIC.VERSION;

        // Index of the '#' that begins a trailing inline comment, or -1. A '#'
        // only starts a comment at the start of the value or after whitespace,
        // and never inside quotes. `requireLeadingSpace` makes position 0
        // ineligible, which is what the highlighter needs: a line that is
        // entirely a comment is matched earlier, so a '#' in column 0 of a
        // *value* is literal.
        // One scanner for all three callers — stripInlineComment below and both
        // arms of highlightYaml, which each carried their own copy and had
        // quietly drifted on whether a tab counts as the preceding whitespace.
        function findInlineCommentStart(s, requireLeadingSpace) {
            let inQuote = false, quoteChar = '';
            for (let i = 0; i < s.length; i++) {
                let c = s[i];
                if (inQuote) { if (c === quoteChar) inQuote = false; }
                else if (c === '"' || c === "'") { inQuote = true; quoteChar = c; }
                else if (c === '#') {
                    if (i === 0) { if (!requireLeadingSpace) return 0; }
                    else if (/\s/.test(s[i - 1])) return i;
                }
            }
            return -1;
        }

        // Strip a trailing inline "# comment" from a YAML scalar, honoring quotes.
        function stripInlineComment(s) {
            let i = findInlineCommentStart(s, false);
            return i === -1 ? s : s.slice(0, i);
        }

        // Values interpolated into generated nginx directives come straight from
        // the pasted YAML — neutralize characters that could terminate or extend
        // the directive (newlines, ';', '{', '}', a quote-breaking '"', and a
        // trailing backslash that would eat the closing quote). Legitimate values
        // for these directives use none of them.
        function sanitizeSnippetValue(value) {
            return String(value).replace(/[\r\n;{}]+/g, ' ').replace(/"/g, '\\"').replace(/\\+$/, '').trim();
        }

        function formatYamlKV(indent, key, value) {
            if (value == null) value = '';
            // Drop an optional leading "|\n" block-scalar marker that callers prepend.
            let body = value.indexOf('|\\n') === 0 ? value.substring(3) : value;
            // Treat both the literal "\n" marker and real newline characters as line
            // breaks, so multi-line snippet values always render as a valid, indented
            // YAML block scalar (single-line values stay quoted).
            let lines = body.split(/\\n|\n/);
            if (value.indexOf('|\\n') === 0 || lines.length > 1) {
                return indent + key + ': |\n' + lines.map(function(l) { return indent + '  ' + l.trim(); }).join('\n');
            }
            let escaped = body ? body.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : body;
            return indent + key + ': "' + escaped + '"';
        }

        // Normalize CRLF/CR and split a manifest into YAML documents. The
        // separator may carry a trailing comment — `helm template` emits
        // `--- # Source: chart/templates/x.yaml`. An indented `---` is
        // content, not a separator, which the ^ anchor already handles.
        function splitDocuments(yamlText) {
            return yamlText.replace(/\r\n?/g, '\n').split(/^---(?:\s+#.*)?\s*$/m);
        }

        // Detect syntax we don't fully parse and surface it to the user, so confusing
        // "no findings" results have a clear cause. Source-specific checks (e.g.
        // multiple Ingress hosts) live in the source module's parseInput.
        function detectGenericSyntaxWarnings(yamlText) {
            let warnings = [];
            // Kustomize manifests (commonAnnotations is applied at build time, not inline)
            if (/^kind:\s*Kustomization\b/m.test(yamlText) || /^commonAnnotations:\s*$/m.test(yamlText)) {
                warnings.push({
                    title: 'Kustomize manifest detected',
                    message: 'This tool reads inline annotations on Ingress resources. Run `kustomize build` first and paste the rendered Ingress output.'
                });
            }
            // YAML anchors / aliases — we don't expand them, so referenced annotations
            // get silently dropped.
            if (/(^|\s)&[A-Za-z0-9_-]+/m.test(yamlText) || /(:\s|^\s*-\s*)\*[A-Za-z0-9_-]+/m.test(yamlText)) {
                warnings.push({
                    title: 'YAML anchors or aliases detected',
                    message: 'The analyzer does not expand `&anchor` / `*alias` references. Resolve them (or paste the rendered manifest) for accurate results.'
                });
            }
            // Helm template syntax — also pre-render
            if (/\{\{[^}]+\}\}/.test(yamlText)) {
                warnings.push({
                    title: 'Helm template syntax detected',
                    message: '`{{ ... }}` placeholders are not evaluated. Run `helm template` and paste the rendered output.'
                });
            }
            return warnings;
        }


        // --- YAML ------------------------------------------------------------
        // A Kubernetes-manifest subset of YAML, shared by the page and by
        // nic-migrate (which used to carry its own copy). The analyzer once read
        // manifests with line regexes; that truncated kubectl's wrapped values,
        // kept escape sequences literal and took a Deployment's probe path for a
        // route. One parser, so both tools read a manifest the same way.
        //
        // Supported: multi-document streams, block mappings and sequences, plain
        // and quoted scalars (folded across lines, as kubectl wraps anything past
        // ~80 columns), block scalars with chomping and indentation indicators,
        // comments, flow collections on one line, and the scalar types manifests
        // use. Refused rather than half-read: anchors and aliases, merge keys,
        // tags other than the standard !!str/!!int/!!bool/!!null, and any line
        // the parser does not consume. Every error names its line.

        function yamlError(message, line) {
            let err = new Error(line ? 'line ' + line + ': ' + message : message);
            err.yamlLine = line || null;
            return err;
        }

        // Index of a trailing comment's '#', honouring both quote styles and
        // their escapes, or -1. A '#' opens a comment only at the start or after
        // whitespace.
        function yamlCommentStart(s) {
            let quote = null;
            let prev = '';
            for (let i = 0; i < s.length; i++) {
                let c = s[i];
                if (quote) {
                    if (quote === '"' && c === '\\') { i++; continue; }
                    if (c === quote) {
                        if (quote === "'" && s[i + 1] === "'") { i++; continue; }
                        quote = null;
                        prev = c;
                    }
                    continue;
                }
                // A quote opens a scalar only where one can start: a plain
                // scalar such as `it's` or `say "hi"` keeps its quotes literal.
                if ((c === '"' || c === "'") && (prev === '' || /[\[{,]/.test(prev) || (/[:?-]/.test(prev) && /\s/.test(s[i - 1])))) { quote = c; continue; }
                if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return i;
                if (!/\s/.test(c)) prev = c;
            }
            return -1;
        }

        function yamlStripComment(s) {
            let i = yamlCommentStart(s);
            return i === -1 ? s : s.slice(0, i);
        }

        function yamlIndent(line) {
            let n = 0;
            while (n < line.length && line[n] === ' ') n++;
            return n;
        }

        // Split a stream into documents of raw lines, normalising CRLF/CR and a
        // BOM. `---` may carry a comment (`--- # Source: …` from helm template)
        // or content after it; `...` ends a document.
        function yamlSplitStream(text) {
            let lines = String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
            // A final newline ends the last line; it does not open another. Without
            // one, a block scalar ending the stream has no final line break.
            let finalNewline = lines.length > 1 && lines[lines.length - 1] === '';
            if (finalNewline) lines.pop();
            let docs = [];
            let cur = { lines: [], start: 1 };
            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];
                let m = line.match(/^---(?:\s+(.*))?\s*$/);
                if (m || /^---\s/.test(line)) {
                    docs.push(cur);
                    cur = { lines: [], start: i + 2 };
                    let rest = line.slice(3).trim();
                    if (rest && rest[0] !== '#') { cur.lines.push(rest); cur.start = i + 1; }
                    continue;
                }
                if (/^\.\.\.\s*$/.test(line)) { docs.push(cur); cur = { lines: [], start: i + 2 }; continue; }
                cur.lines.push(line);
            }
            cur.noFinalNewline = !finalNewline;
            docs.push(cur);
            return docs.filter(function(d) { return d.lines.some(function(l) { return l.trim() !== '' && !/^\s*#/.test(l); }); });
        }

        // Index of the quote closing a scalar that opens at s[0], or -1.
        function yamlQuoteEnd(s) {
            let q = s[0];
            for (let i = 1; i < s.length; i++) {
                if (q === '"' && s[i] === '\\') { i++; continue; }
                if (s[i] !== q) continue;
                if (q === "'" && s[i + 1] === "'") { i++; continue; }
                return i;
            }
            return -1;
        }

        let YAML_ESCAPES = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };

        function yamlUnescapeDouble(body, line) {
            return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, function(_, e) {
                if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
                if (Object.prototype.hasOwnProperty.call(YAML_ESCAPES, e)) return YAML_ESCAPES[e];
                throw yamlError('unknown escape \\' + e + ' in a double-quoted string', line);
            });
        }

        // A YAML 1.2 core-schema scalar, as Kubernetes reads one. Quoted scalars
        // are always strings; plain ones resolve to null, booleans and decimal
        // numbers, and stay strings otherwise (0755 and 1:30 included — callers
        // that care about YAML 1.1's readings quote on output, see yamlNeedsQuotes).
        function yamlScalar(raw, line) {
            let t = String(raw).trim();
            if (t === '') return null;
            if (t[0] === '&' || t[0] === '*') throw yamlError('anchors and aliases are not supported (found "' + t.split(/\s/)[0] + '")', line);
            if (t === '<<') throw yamlError('merge keys (<<) are not supported', line);
            if (t[0] === '!') {
                let tag = t.match(/^(!\S*)\s*([\s\S]*)$/);
                let value = tag[2];
                if (tag[1] === '!!str') { let s = yamlScalar(value, line); return s === null ? '' : String(s); }
                if (tag[1] === '!!int' || tag[1] === '!!float' || tag[1] === '!!bool' || tag[1] === '!!null') return yamlScalar(value, line);
                throw yamlError('the tag ' + tag[1] + ' is not supported', line);
            }
            if (t[0] === '"') {
                if (yamlQuoteEnd(t) !== t.length - 1) throw yamlError('unterminated or malformed double-quoted string', line);
                return yamlUnescapeDouble(t.slice(1, -1), line);
            }
            if (t[0] === "'") {
                if (yamlQuoteEnd(t) !== t.length - 1) throw yamlError('unterminated or malformed single-quoted string', line);
                return t.slice(1, -1).replace(/''/g, "'");
            }
            if (t[0] === '{' || t[0] === '[') return yamlFlow(t, line);
            if (/^(null|Null|NULL|~)$/.test(t)) return null;
            if (/^(true|True|TRUE)$/.test(t)) return true;
            if (/^(false|False|FALSE)$/.test(t)) return false;
            if (/^[-+]?(0|[1-9][0-9]*)$/.test(t)) return Number(t);
            if (/^[-+]?(0|[1-9][0-9]*)\.[0-9]+([eE][-+]?[0-9]+)?$/.test(t)) return Number(t);
            return t;
        }

        // Split at `sep` on flow depth 0, outside quotes.
        function yamlSplitFlow(body, sep) {
            let out = [], depth = 0, quote = null, cur = '';
            for (let i = 0; i < body.length; i++) {
                let c = body[i];
                if (quote) {
                    cur += c;
                    if (quote === '"' && c === '\\') { cur += body[++i] || ''; continue; }
                    if (c === quote) {
                        if (quote === "'" && body[i + 1] === "'") { cur += body[++i]; continue; }
                        quote = null;
                    }
                    continue;
                }
                if ((c === '"' || c === "'") && /(^|[\[{,:?])\s*$/.test(cur)) { quote = c; cur += c; continue; }
                if (c === '{' || c === '[') depth++;
                if (c === '}' || c === ']') depth--;
                if (depth < 0) return null;
                if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
                cur += c;
            }
            if (depth !== 0 || quote) return null;
            if (cur.trim() !== '') out.push(cur);
            return out;
        }

        // A flow mapping key ends at the first ': ' (or a ':' before the end)
        // outside quotes. Unquoted values never swallow the next key — `{a: b,
        // c: d}` is two pairs — which is how inline annotations used to merge.
        function yamlFlow(t, line) {
            let open = t[0], close = open === '{' ? '}' : ']';
            if (t[t.length - 1] !== close) throw yamlError('unterminated flow collection', line);
            let parts = yamlSplitFlow(t.slice(1, -1), ',');
            if (parts === null) throw yamlError('unbalanced brackets or quotes in a flow collection', line);
            if (open === '[') return parts.map(function(p) { return yamlScalar(p, line); });
            let out = {};
            parts.forEach(function(pair) {
                let p = pair.trim();
                if (p === '') return;
                let key, rest;
                if (p[0] === '"' || p[0] === "'") {
                    let end = yamlQuoteEnd(p);
                    if (end === -1) throw yamlError('unterminated quoted key in a flow mapping', line);
                    key = yamlScalar(p.slice(0, end + 1), line);
                    rest = p.slice(end + 1).replace(/^\s*:/, '');
                } else {
                    let m = p.match(/^([^:]*?)\s*:(?:\s+|$)([\s\S]*)$/);
                    if (!m) throw yamlError('flow mapping entry "' + p + '" has no "key: value" form', line);
                    key = yamlScalar(m[1], line);
                    rest = m[2];
                }
                out[String(key)] = yamlScalar(rest, line);
            });
            return out;
        }

        // Fold a multi-line plain or quoted scalar the way YAML does: a single
        // line break between two non-empty lines is a space, each empty line a
        // newline. kubectl wraps long annotation values onto such lines.
        function yamlFold(lines, quote) {
            let out = lines[0].replace(/[ \t]+$/, '');
            let breaks = 0;
            for (let i = 1; i < lines.length; i++) {
                let t = lines[i].trim();
                if (t === '') { breaks++; continue; }
                // Inside double quotes a trailing backslash escapes the line break.
                if (quote === '"' && !breaks && /(^|[^\\])(\\\\)*\\$/.test(out)) { out = out.slice(0, -1) + t; continue; }
                out += breaks ? '\n'.repeat(breaks) : ' ';
                breaks = 0;
                out += t;
            }
            return out;
        }

        function YamlReader(lines, firstLine, noFinalNewline) {
            this.noFinalNewline = !!noFinalNewline;
            this.raw = lines.map(function(l) { return l; });
            this.first = firstLine || 1;
            this.i = 0;
            this.entries = this.raw.map(function(l, idx) {
                // A tab may not indent YAML structure; inside a block scalar it is content.
                return { indent: yamlIndent(l), content: yamlStripComment(l).trim(), raw: l };
            });
        }
        YamlReader.prototype.lineNo = function(i) { return this.first + (i === undefined ? this.i : i); };
        YamlReader.prototype.blank = function(i) { let r = this.raw[i]; return r.trim() === '' || /^\s*#/.test(r); };
        YamlReader.prototype.peek = function() {
            while (this.i < this.raw.length && this.blank(this.i)) this.i++;
            if (this.i >= this.raw.length) return null;
            if (/^ *\t/.test(this.raw[this.i])) throw yamlError('a tab is used for indentation', this.lineNo());
            return this.entries[this.i];
        };
        YamlReader.prototype.respan = function(indent, content) {
            this.entries[this.i] = { indent: indent, content: content, raw: this.raw[this.i] };
        };

        let YAML_KEY = /^((?:[^:]|:(?=\S))+?)\s*:(\s+[\s\S]*|\s*)$/;

        // `key: rest` from a line, or null when the line is a scalar.
        function yamlKeyLine(content, line) {
            if (content[0] === '"' || content[0] === "'") {
                let end = yamlQuoteEnd(content);
                if (end === -1) return null;
                let m = content.slice(end + 1).match(/^\s*:(\s+[\s\S]*|\s*)$/);
                if (!m) return null;
                return { key: String(yamlScalar(content.slice(0, end + 1), line)), rest: m[1].trim() };
            }
            if (content[0] === '[' || content[0] === '{' || content[0] === '-' && /^-(\s|$)/.test(content)) return null;
            let m = content.match(YAML_KEY);
            if (!m) return null;
            let key = yamlScalar(m[1].trim(), line);
            return { key: key === null ? '' : String(key), rest: m[2].trim() };
        }

        function yamlValue(r, minIndent) {
            let e = r.peek();
            if (!e || e.indent < minIndent) return null;
            if (/^-(\s|$)/.test(e.content)) return yamlSequence(r, e.indent);
            if (yamlKeyLine(e.content, r.lineNo())) return yamlMapping(r, e.indent);
            return yamlMultiScalar(r, e.indent - 1);
        }

        // A scalar that starts on its own line and may continue on more-indented
        // lines (a bare document, or a sequence item's wrapped value).
        function yamlMultiScalar(r, parentIndent) {
            let startIdx = r.i;
            let first = r.entries[r.i].content;
            r.i++;
            return yamlContinue(r, first, parentIndent, startIdx);
        }

        // Read continuation lines for a plain or quoted scalar that began with
        // `first` on line `startIdx`. Continuation lines are anything indented
        // deeper than the parent; a quoted scalar continues until its quote closes.
        function yamlContinue(r, first, parentIndent, startIdx) {
            let parts = [first];
            let quote = (first[0] === '"' || first[0] === "'") ? first[0] : null;
            let closed = quote ? yamlQuoteEnd(first) !== -1 : true;
            if (quote && closed) return yamlScalar(first, r.lineNo(startIdx));
            if (!quote && /^[\[{]/.test(first)) {
                // A flow collection may wrap too; join until brackets balance.
                while (yamlSplitFlow(parts.join(' ').slice(1, -1), ',') === null || !/[\]}]\s*$/.test(parts.join(' '))) {
                    if (r.i >= r.raw.length) throw yamlError('unterminated flow collection', r.lineNo(startIdx));
                    parts.push(r.raw[r.i].trim());
                    r.i++;
                }
                return yamlScalar(parts.join(' '), r.lineNo(startIdx));
            }
            while (r.i < r.raw.length) {
                let raw = r.raw[r.i];
                if (raw.trim() === '') { parts.push(''); r.i++; continue; }
                if (quote) {
                    parts.push(raw);
                    r.i++;
                    if (yamlQuoteEnd(parts.map(function(p, k) { return k === 0 ? p : p.trim(); }).join(' ')) !== -1) {
                        closed = true;
                        break;
                    }
                    continue;
                }
                if (/^\s*#/.test(raw)) break;
                if (yamlIndent(raw) <= parentIndent) break;
                let content = yamlStripComment(raw).trim();
                // A plain scalar cannot hold ": " — a deeper line that does is
                // mis-indented structure, and folding it in would hide that.
                if (/:(\s|$)/.test(content) || /^-(\s|$)/.test(content)) throw yamlError('mapping or sequence entry inside a value — check the indentation', r.lineNo());
                parts.push(content);
                r.i++;
                if (yamlCommentStart(raw) !== -1) break;
            }
            while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
            if (quote) {
                if (!closed) throw yamlError('unterminated ' + (quote === '"' ? 'double' : 'single') + '-quoted string', r.lineNo(startIdx));
                // Fold inside the quotes, then hand the single-line form to the scalar parser.
                let joined = yamlFold(parts, quote);
                let end = yamlQuoteEnd(joined);
                let after = yamlStripComment(joined.slice(end + 1)).trim();
                if (after !== '') throw yamlError('unexpected text after a quoted string: ' + after, r.lineNo(startIdx));
                return yamlScalar(joined.slice(0, end + 1), r.lineNo(startIdx));
            }
            if (parts.length === 1) return yamlScalar(parts[0], r.lineNo(startIdx));
            return yamlFold(parts);
        }

        function yamlMapping(r, indent) {
            let out = {};
            for (;;) {
                let e = r.peek();
                if (!e || e.indent < indent) break;
                if (e.indent > indent) throw yamlError('unexpected indentation', r.lineNo());
                let kv = yamlKeyLine(e.content, r.lineNo());
                if (!kv) {
                    if (/^-(\s|$)/.test(e.content)) break;
                    throw yamlError('expected "key: value", found "' + e.content.slice(0, 40) + '"', r.lineNo());
                }
                if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw yamlError('duplicate key "' + kv.key + '"', r.lineNo());
                let idx = r.i;
                r.i++;
                out[kv.key] = yamlNodeValue(r, kv.rest, indent, idx);
            }
            return out;
        }

        function yamlSequence(r, indent) {
            let out = [];
            for (;;) {
                let e = r.peek();
                if (!e || e.indent < indent) break;
                if (e.indent > indent) throw yamlError('unexpected indentation', r.lineNo());
                if (!/^-(\s|$)/.test(e.content)) break;
                let rest = e.content.replace(/^-\s*/, '');
                let idx = r.i;
                if (rest === '') {
                    r.i++;
                    let next = r.peek();
                    out.push(next && next.indent > indent ? yamlValue(r, indent + 1) : null);
                    continue;
                }
                let dash = e.raw.indexOf('-', indent);
                let contentIndent = dash + 1 + (e.raw.slice(dash + 1).match(/^ */) || [''])[0].length;
                if (/^-(\s|$)/.test(rest)) {
                    r.respan(contentIndent, rest);
                    out.push(yamlSequence(r, contentIndent));
                } else if (yamlKeyLine(rest, r.lineNo())) {
                    r.respan(contentIndent, rest);
                    out.push(yamlMapping(r, contentIndent));
                } else {
                    r.i++;
                    out.push(yamlNodeValue(r, rest, indent, idx));
                }
            }
            return out;
        }

        function yamlNodeValue(r, rest, parentIndent, lineIdx) {
            let block = rest.match(/^([|>])([-+]?)([1-9]?)([-+]?)$/);
            if (block) return yamlBlockScalar(r, block[1], block[2] || block[4], block[3], parentIndent);
            if (/^[|>]/.test(rest)) throw yamlError('malformed block scalar header "' + rest + '"', r.lineNo(lineIdx));
            if (rest !== '') return yamlContinue(r, rest, parentIndent, lineIdx);
            let next = r.peek();
            if (!next) return null;
            if (next.indent > parentIndent) return yamlValue(r, next.indent);
            // A sequence may sit at its key's own indent.
            if (next.indent === parentIndent && /^-(\s|$)/.test(next.content)) return yamlSequence(r, next.indent);
            return null;
        }

        function yamlBlockScalar(r, style, chomp, explicit, parentIndent) {
            let lines = [];
            let contentIndent = explicit ? parentIndent + Number(explicit) : null;
            for (; r.i < r.raw.length; r.i++) {
                let raw = r.raw[r.i];
                if (raw.trim() === '') { lines.push(raw.length > (contentIndent || 0) ? raw.slice(contentIndent || 0) : ''); continue; }
                let ind = yamlIndent(raw);
                if (contentIndent === null) {
                    if (ind <= parentIndent) break;
                    contentIndent = ind;
                }
                if (ind < contentIndent) break;
                lines.push(raw.slice(contentIndent));
            }
            if (contentIndent === null && lines.every(function(l) { return l === ''; })) lines = lines.map(function() { return ''; });
            let trailing = 0;
            while (lines.length && lines[lines.length - 1].trim() === '') { lines.pop(); trailing++; }
            // Line breaks after the last content line: one per trailing blank
            // line, plus the content line's own unless it ends the stream bare.
            let breaks = trailing + (r.i >= r.raw.length && r.noFinalNewline ? 0 : 1);
            let body;
            if (style === '|') {
                body = lines.join('\n');
            } else {
                // Folded: a break between two plain lines is a space, each empty
                // line a newline, and breaks around more-indented lines stay.
                let lead = 0;
                while (lead < lines.length && lines[lead] === '') lead++;
                body = '\n'.repeat(lead) + (lead < lines.length ? lines[lead] : '');
                for (let i = lead + 1; i < lines.length; i++) {
                    let empties = 0;
                    while (lines[i] === '') { empties++; i++; }
                    let more = /^\s/.test(lines[i]) || /^\s/.test(lines[i - 1 - empties]);
                    body += empties ? '\n'.repeat(empties + (more ? 1 : 0)) : (more ? '\n' : ' ');
                    body += lines[i];
                }
            }
            if (chomp === '-') return body;
            if (chomp === '+') return body + '\n'.repeat(lines.length ? breaks : trailing);
            return body === '' || breaks === 0 ? body : body + '\n';
        }

        // Parse one document's lines; throws on anything not consumed.
        function yamlParseLines(lines, firstLine, noFinalNewline) {
            let r = new YamlReader(lines, firstLine, noFinalNewline);
            let value = yamlValue(r, 0);
            let left = r.peek();
            if (left) throw yamlError('could not parse "' + left.content.slice(0, 40) + '"', r.lineNo());
            return value;
        }

        function yamlParse(text) {
            let docs = yamlSplitStream(text);
            if (docs.length === 0) return null;
            if (docs.length > 1) throw yamlError('expected one document, found ' + docs.length);
            return yamlParseLines(docs[0].lines, docs[0].start, docs[0].noFinalNewline);
        }

        function yamlParseAll(text) {
            return yamlSplitStream(text).map(function(d) { return yamlParseLines(d.lines, d.start, d.noFinalNewline); }).filter(function(d) { return d !== null; });
        }

        // --- emitting ---

        let YAML_RESERVED = /^(true|false|null|~|yes|no|on|off|y|n)$/i;

        // Quote anything a YAML 1.1 or 1.2 reader would not read back as this
        // string. Kubernetes reads YAML 1.1 in places, where 0755 is 493 and
        // 1:30 is 90, so anything starting like a number is quoted: over-quoting
        // is cosmetic, under-quoting is a wrong value.
        function yamlNeedsQuotes(s) {
            if (s === '') return true;
            if (/[\n\r\t\x00-\x08\x0b\x0c\x0e-\x1f\u0085\u2028\u2029]/.test(s)) return true;
            if (/^\s|\s$/.test(s)) return true;
            if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
            if (YAML_RESERVED.test(s)) return true;
            if (/:\s|\s#|:$/.test(s)) return true;
            if (/^[-+.0-9]/.test(s)) return true;
            return false;
        }

        function yamlQuote(s) {
            return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
                .replace(/\r/g, '\\r').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, function(c) { return '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'); }) + '"';
        }

        // One-line form of a scalar for `key: <here>`, or null when the value
        // needs a block scalar. `opts.quote` forces quotes on any string.
        function yamlFormatScalar(v, quoteAlways) {
            if (v === null || v === undefined) return 'null';
            if (typeof v === 'boolean' || typeof v === 'number') return String(v);
            let s = String(v);
            if (s.indexOf('\n') !== -1) return yamlBlockSafe(s) ? null : yamlQuote(s);
            return quoteAlways || yamlNeedsQuotes(s) ? yamlQuote(s) : s;
        }

        // A literal block reads back exactly when the text has content, ends in
        // at most one newline, has no whitespace-only line and no control
        // characters. Anything else is double-quoted: uglier, never wrong.
        function yamlBlockSafe(s) {
            let body = s.replace(/\n$/, '');
            if (/\n$/.test(body) || body === '' || /^\n/.test(body)) return false;
            if (/[\x00-\x08\x0b-\x1f\x7f\u0085\u2028\u2029]/.test(s.replace(/\n/g, ''))) return false;
            return body.split('\n').every(function(l) { return l === '' || l.trim() !== ''; });
        }

        // Lines for a block scalar holding `s`, indented by `pad`. Chomping and
        // the indentation indicator are chosen so the value reads back exactly.
        function yamlBlockLines(s, pad) {
            let keep = /\n$/.test(s);
            let body = s.replace(/\n$/, '').split('\n');
            let indicator = /^\s/.test(body[0]) ? '2' : '';
            return { header: '|' + indicator + (keep ? '' : '-'), lines: body.map(function(l) { return l === '' ? '' : pad + l; }) };
        }

        function yamlIsMap(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

        // Emit `value` at `indent`. `comments` maps a dotted path ('spec.host',
        // 'spec.routes.0.path') to a trailing comment, which is how each
        // generated line names the community annotation it came from.
        function yamlEmitNode(value, indent, lines, path, comments, opts) {
            let pad = ' '.repeat(indent);
            let note = function(p) { return comments && comments[p] ? '  # ' + comments[p] : ''; };
            if (Array.isArray(value)) {
                value.forEach(function(item, i) {
                    let p = path + '.' + i;
                    if (yamlIsMap(item) || Array.isArray(item)) {
                        if ((yamlIsMap(item) && Object.keys(item).length === 0) || (Array.isArray(item) && item.length === 0)) {
                            lines.push(pad + '- ' + (Array.isArray(item) ? '[]' : '{}') + note(p));
                            return;
                        }
                        let before = lines.length;
                        yamlEmitNode(item, indent + 2, lines, p, comments, opts);
                        lines[before] = pad + '- ' + lines[before].slice(indent + 2);
                    } else {
                        let one = yamlFormatScalar(item);
                        if (one === null) {
                            let b = yamlBlockLines(String(item), pad + '  ');
                            lines.push(pad + '- ' + b.header + note(p));
                            b.lines.forEach(function(l) { lines.push(l); });
                        } else {
                            lines.push(pad + '- ' + one + note(p));
                        }
                    }
                });
                return;
            }
            if (yamlIsMap(value)) {
                Object.keys(value).forEach(function(key) {
                    let v = value[key];
                    let p = path ? path + '.' + key : key;
                    let k = yamlNeedsQuotes(key) ? yamlQuote(key) : key;
                    if (yamlIsMap(v) || Array.isArray(v)) {
                        let empty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
                        if (empty) { lines.push(pad + k + ': ' + (Array.isArray(v) ? '[]' : '{}') + note(p)); return; }
                        lines.push(pad + k + ':' + note(p));
                        yamlEmitNode(v, indent + 2, lines, p, comments, opts);
                        return;
                    }
                    let one = yamlFormatScalar(v, opts && opts.quote && opts.quote(p));
                    if (one === null) {
                        let b = yamlBlockLines(String(v), pad + '  ');
                        lines.push(pad + k + ': ' + b.header + note(p));
                        b.lines.forEach(function(l) { lines.push(l); });
                    } else {
                        lines.push(pad + k + ': ' + one + note(p));
                    }
                });
                return;
            }
            let one = yamlFormatScalar(value);
            lines.push(pad + (one === null ? yamlQuote(String(value)) : one));
        }

        // `comments` maps a dotted path to a trailing comment; `opts.quote(path)`
        // forces quotes on a string (annotation values read better quoted).
        function yamlStringify(value, comments, opts) {
            let lines = [];
            yamlEmitNode(value, 0, lines, '', comments, opts);
            return lines.join('\n') + '\n';
        }

        function yamlStringifyAll(docs) {
            return docs.map(function(d) { return yamlStringify(d); }).join('---\n');
        }

        let YAML = {
            parse: yamlParse,
            parseAll: yamlParseAll,
            parseDocuments: function(text) {
                // Each document parsed on its own, so one broken document does not
                // hide the others: [{ value, error, start }].
                return yamlSplitStream(text).map(function(d) {
                    try { return { value: yamlParseLines(d.lines, d.start, d.noFinalNewline), error: null, start: d.start }; }
                    catch (e) { return { value: null, error: e.message, start: d.start }; }
                });
            },
            stringify: yamlStringify,
            stringifyAll: yamlStringifyAll,
            scalar: yamlFormatScalar,
            needsQuotes: yamlNeedsQuotes,
            quote: yamlQuote,
            splitStream: yamlSplitStream
        };

        // Shared utilities the SOURCE modules call (call-time only — they load first).
        window.MigrationTool = {
            NIC: NIC,
            util: {
                splitDocuments: splitDocuments,
                stripInlineComment: stripInlineComment,
                sanitizeSnippetValue: sanitizeSnippetValue,
                formatYamlKV: formatYamlKV,
                detectGenericSyntaxWarnings: detectGenericSyntaxWarnings
            },
            yaml: YAML
        };

        // The page's source module (loaded before this file) supplies all
        // source-specific data and hooks. Without it nothing below can work.
        var SOURCE = window.MIGRATION_SOURCE;
        if (!SOURCE) {
            console.error('migration-core.js: window.MIGRATION_SOURCE is not defined — load the migration-<source>.js module before migration-core.js.');
            return;
        }

        function toggleRow(row) {
            const exampleRow = row.nextElementSibling;
            if (exampleRow && exampleRow.classList.contains('example-row')) {
                row.classList.toggle('expanded');
                exampleRow.classList.toggle('visible');
                let isExpanded = row.classList.contains('expanded');
                row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
                exampleRow.setAttribute('aria-hidden', isExpanded ? 'false' : 'true');
                // Highlighting is lazy — cover this row immediately in case the idle
                // queue hasn't reached it yet (cheap no-op once highlighted).
                if (isExpanded) highlightStaticExamples(exampleRow);
            }
        }

        // Add keyboard accessibility to expandable rows and approach tabs
        document.addEventListener('DOMContentLoaded', function() {
            // Populate version-reference markers from the single source of truth
            // (MigrationTool.NIC for the target, SOURCE.versionBindings for the source controller)
            document.querySelectorAll('[data-nic-version]').forEach(function(el) { el.textContent = NIC.VERSION; });
            document.querySelectorAll('[data-nic-release-link]').forEach(function(el) { el.href = NIC.RELEASE_URL; });
            document.querySelectorAll('[data-nic-crd-install]').forEach(function(el) { el.textContent = NIC.CRD_INSTALL_CMD; });
            document.querySelectorAll('[data-nic-helm-install]').forEach(function(el) { el.textContent = NIC.HELM_INSTALL_CMD; });
            (SOURCE.versionBindings || []).forEach(function(binding) {
                document.querySelectorAll('[' + binding.attr + ']').forEach(function(el) {
                    if (binding.text) el.textContent = binding.text;
                    if (binding.href) el.href = binding.href;
                });
            });

            // Populate category filter dropdowns
            function populateCategoryFilter(filterId, sectionId) {
                let filter = document.getElementById(filterId);
                let section = document.getElementById(sectionId);
                if (filter && section) {
                    section.querySelectorAll('h3[id]').forEach(function(h3) {
                        let opt = document.createElement('option');
                        opt.value = h3.id;
                        opt.textContent = h3.textContent;
                        filter.appendChild(opt);
                    });
                }
            }
            SOURCE.reference.sections.forEach(function(s) { populateCategoryFilter(s.category, s.id); });

            // Delegated event dispatcher — replaces all inline onclick/onkeydown/etc.
            // Behaviour: any element with [data-action="..."] is dispatched on click; non-button
            // elements also activate on Enter/Space (so menuitem divs and links behave like buttons).
            // Argument values are read from sibling data-* attributes (data-approach, data-strategy, …).
            let ACTIONS = {
                switchApproach: function(el) { switchApproach(el, el.getAttribute('data-approach')); },
                expandAllExamples: function(el) { expandAllExamples(el); },
                collapseAllExamples: function(el) { collapseAllExamples(el); },
                toggleSampleDropdown: function(el, e) { toggleSampleDropdown(e); },
                // showPage's logic lives in a separate IIFE — trigger it by clicking the
                // matching sidebar link so we don't have to expose the function on window.
                showPage: function(el) {
                    let page = el.getAttribute('data-page');
                    let link = document.querySelector('.sidebar-link[data-page="' + page + '"]');
                    if (link) link.click();
                },
                setStrategy: function(el) { setStrategy(el.getAttribute('data-strategy'), el); },
                loadSampleYaml: function(el) { loadSampleYaml(el.getAttribute('data-preset')); },
                clearAnalyzer: function() { clearAnalyzer(); },
                analyzeYaml: function() { analyzeYaml(); }
            };

            function dispatchAction(el, e) {
                let name = el.getAttribute('data-action');
                let fn = ACTIONS[name];
                if (!fn) return;
                if (el.tagName === 'A') e.preventDefault();
                fn(el, e);
            }

            document.addEventListener('click', function(e) {
                let el = e.target.closest('[data-action]');
                if (el) dispatchAction(el, e);
            });
            document.addEventListener('keydown', function(e) {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                let el = e.target.closest('[data-action]');
                if (!el) return;
                // Native buttons already activate on Enter/Space; only synthesise for other elements.
                if (el.tagName === 'BUTTON') return;
                e.preventDefault();
                dispatchAction(el, e);
            });

            // Filter inputs/selects — both text input and select-change funnel through filterTable.
            // Typing is debounced: one keystroke re-walks every mapping row in
            // all three sections, which is enough work to drop frames at 300+
            // rows. A <select> fires once per choice, so it runs immediately.
            let filterTimer = null;
            document.querySelectorAll('[data-filter-source]').forEach(function(el) {
                let isSelect = el.tagName === 'SELECT';
                el.addEventListener(isSelect ? 'change' : 'input', function() {
                    let source = el.getAttribute('data-filter-source');
                    if (isSelect) { filterTable(source); return; }
                    clearTimeout(filterTimer);
                    filterTimer = setTimeout(function() { filterTable(source); }, 120);
                });
            });

            // Expandable rows — add full ARIA wiring (button semantics + control linkage to
            // the example row that toggles in/out alongside the trigger) and click/keyboard
            // handlers (replaces former inline onclick="toggleRow(this)").
            document.querySelectorAll('.expandable').forEach(function(row, i) {
                row.setAttribute('tabindex', '0');
                // No role="button" here — it would strip the row/cell table semantics.
                // The row stays a focusable, keyboard-operable disclosure (aria-expanded
                // + the keydown handler below), and the <td> annotation columns keep their
                // cell semantics for screen readers.
                row.setAttribute('aria-expanded', 'false');
                let exampleRow = row.nextElementSibling;
                if (exampleRow && exampleRow.classList.contains('example-row')) {
                    if (!exampleRow.id) exampleRow.id = 'example-row-' + i;
                    row.setAttribute('aria-controls', exampleRow.id);
                    exampleRow.setAttribute('aria-hidden', 'true');
                }
                row.addEventListener('click', function(e) {
                    // Don't collapse the row when a click hits an interactive element inside
                    // the trigger row (anchors, copy buttons via approach-tabs, etc.).
                    if (e.target.closest('button, a, input, select, textarea, .approach-tab')) return;
                    toggleRow(this);
                });
                row.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleRow(this);
                    }
                });
            });

            // Approach tabs ARIA enhancement with arrow key navigation
            document.querySelectorAll('.approach-tabs').forEach(function(tabList, i) {
                tabList.setAttribute('role', 'tablist');
                let tabs = tabList.querySelectorAll('.approach-tab');
                tabs.forEach(function(tab) {
                    // Derive the type from the tab's own data-approach so its id/aria-controls
                    // match its panel exactly — the old text heuristic collapsed distinct
                    // tabs (e.g. two "Policy + …" tabs) into duplicate ids.
                    let type = tab.getAttribute('data-approach') || (tab.textContent.toLowerCase().includes('annotation') ? 'annotation' : 'crd');
                    let panelId = 'panel-' + i + '-' + type;
                    let active = tab.classList.contains('active');
                    tab.setAttribute('role', 'tab');
                    tab.setAttribute('aria-selected', active ? 'true' : 'false');
                    tab.setAttribute('tabindex', active ? '0' : '-1');
                    tab.setAttribute('aria-controls', panelId);
                    tab.id = 'tab-' + i + '-' + type;
                });
                // Arrow key navigation per WAI-ARIA tabs pattern
                tabList.addEventListener('keydown', function(e) {
                    let tabsArr = Array.from(tabs);
                    let idx = tabsArr.indexOf(document.activeElement);
                    if (idx < 0) return;
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        let next = tabsArr[(idx + 1) % tabsArr.length];
                        next.focus();
                        next.click();
                    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        let prev = tabsArr[(idx - 1 + tabsArr.length) % tabsArr.length];
                        prev.focus();
                        prev.click();
                    }
                });
                let container = tabList.closest('.example-content, .release-notes');
                if (container) {
                    container.querySelectorAll('.approach-content').forEach(function(panel) {
                        let type = panel.getAttribute('data-approach');
                        panel.setAttribute('role', 'tabpanel');
                        panel.id = 'panel-' + i + '-' + type;
                        panel.setAttribute('aria-labelledby', 'tab-' + i + '-' + type);
                        panel.setAttribute('aria-hidden', panel.classList.contains('active') ? 'false' : 'true');
                    });
                }
            });
            // Add copy buttons to comparison blocks. The button is the block's
            // child, beside the <h4> rather than inside it: inside, its label
            // became part of the heading's accessible name, so ~350 headings
            // read "… Copy code snippet". And every one of those buttons had
            // that same name; each now says which row, side and approach it
            // copies, e.g. "Copy: proxy-body-size, CRD Approach, NGINX
            // Ingress Controller".
            document.querySelectorAll('.comparison-block').forEach(function(block) {
                let h5 = block.querySelector('h4');
                let pre = block.querySelector('pre');
                if (!h5 || !pre) return;
                let exampleRow = block.closest('tr.example-row');
                let trigger = exampleRow && exampleRow.previousElementSibling;
                let rowName = '';
                if (trigger) {
                    let first = trigger.querySelector('td code') || trigger.querySelector('td');
                    rowName = (first ? first.textContent : '').replace(/^nginx\.ingress\.kubernetes\.io\//, '').replace(/\s+/g, ' ').trim();
                }
                let panel = block.closest('.approach-content');
                let tab = panel && exampleRow && exampleRow.querySelector('.approach-tab[data-approach="' + panel.getAttribute('data-approach') + '"]');
                let parts = [rowName, tab ? tab.textContent.replace(/\s+/g, ' ').trim() : '', h5.textContent.replace(/\s+/g, ' ').trim()];
                let btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'comparison-copy-btn';
                btn.textContent = 'Copy';
                btn.setAttribute('aria-label', 'Copy: ' + parts.filter(Boolean).join(', '));
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    // Shared helper handles the fallback path, button feedback, and
                    // the screen-reader announcement via #page-announce.
                    copyToClipboard(pre.textContent, btn);
                });
                block.insertBefore(btn, h5.nextSibling);
            });
            // Syntax-highlight static YAML examples: the visible page immediately,
            // the ~300 blocks inside hidden pages and collapsed rows during idle
            // time — building 10k+ DOM nodes up front blocked first interaction.
            highlightStaticExamples(document.querySelector('.tool-page.active') || document);
            deferredHighlightRemaining();
        });

        function highlightBlock(block) {
            if (block.dataset.highlighted) return;
            try {
                let frag = highlightYaml(block.textContent);
                block.textContent = '';
                block.appendChild(frag);
                block.dataset.highlighted = '1';
            } catch (e) { /* skip block on error */ }
        }

        // Applies the existing highlightYaml() DOM-based highlighter to all static pre>code blocks
        function highlightStaticExamples(root) {
            (root || document).querySelectorAll('pre > code').forEach(highlightBlock);
        }

        // Chunk the remaining (hidden) blocks through idle callbacks; a print
        // request force-expands every example row, so flush the queue then.
        function deferredHighlightRemaining() {
            let blocks = Array.prototype.filter.call(document.querySelectorAll('pre > code'), function(b) { return !b.dataset.highlighted; });
            function chunk(deadline) {
                let count = 0;
                while (blocks.length && (count < 8 || (deadline && deadline.timeRemaining && deadline.timeRemaining() > 4))) {
                    highlightBlock(blocks.shift());
                    count++;
                }
                if (blocks.length) schedule();
            }
            function schedule() {
                if (window.requestIdleCallback) requestIdleCallback(chunk);
                else setTimeout(chunk, 50);
            }
            if (blocks.length) schedule();
            window.addEventListener('beforeprint', function() {
                while (blocks.length) highlightBlock(blocks.shift());
            });
        }

        // Set every expandable row in a scope to the same state. One body for
        // both directions — they differed only in add/remove and true/false.
        function setExamplesExpanded(btn, expanded) {
            let scope = (btn && btn.closest('section')) || document;
            // Highlighting is lazy — cover the whole scope before revealing rows
            // so none of them flash as plain text while the idle queue catches up.
            if (expanded) highlightStaticExamples(scope);
            scope.querySelectorAll('.expandable').forEach(row => {
                row.classList.toggle('expanded', expanded);
                row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                const exampleRow = row.nextElementSibling;
                if (exampleRow && exampleRow.classList.contains('example-row')) {
                    exampleRow.classList.toggle('visible', expanded);
                    exampleRow.setAttribute('aria-hidden', expanded ? 'false' : 'true');
                }
            });
        }
        function expandAllExamples(btn) { setExamplesExpanded(btn, true); }
        function collapseAllExamples(btn) { setExamplesExpanded(btn, false); }
        let _savedExpanded = [];
        let _migrationStrategy = (SOURCE.analyzer.strategies && SOURCE.analyzer.strategies.initial) || 'crd'; // 'annotation' or 'crd'

        function setStrategy(strategy, btn) {
            if (_migrationStrategy === strategy) return;
            _migrationStrategy = strategy;
            document.querySelectorAll('.strategy-option').forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');
            let desc = document.getElementById('strategyDesc');
            if (desc && SOURCE.analyzer.strategies) {
                desc.textContent = SOURCE.analyzer.strategies.descriptions[strategy] || '';
            }
            // Results on screen were generated under the previous strategy —
            // re-run the analysis so they match the toggle.
            let results = document.getElementById('analyzerResults');
            if (results && results.querySelector('.analyzer-step, .analyzer-success-banner') && document.getElementById('yamlInput').value.trim()) {
                analyzeYaml();
            }
        }

        // row.textContent re-serializes the row's whole subtree, and the filter
        // did it for every row on every keystroke. The reference tables are
        // static markup, so the lowercased form is cached for the page's life.
        let _rowSearchText = new WeakMap();
        function rowSearchText(row) {
            let cached = _rowSearchText.get(row);
            if (cached === undefined) {
                cached = row.textContent.toLowerCase();
                _rowSearchText.set(row, cached);
            }
            return cached;
        }

        let _searchAnnounceTimer = null;

        // A visible line where the tables were, when a search or category
        // leaves a section with nothing to show. Before this the section went
        // silently empty under its filter bar; only the small counter changed.
        function setEmptyState(s, own, othersVisible) {
            let section = document.getElementById(s.id);
            let controls = section && section.querySelector('.controls');
            if (!controls) return;
            let empty = section.querySelector('.search-empty');
            let show = own.total > 0 && own.visible === 0;
            if (!show) { if (empty) empty.hidden = true; return; }
            if (!empty) {
                empty = document.createElement('p');
                empty.className = 'search-empty';
                controls.parentNode.insertBefore(empty, controls.nextSibling);
            }
            empty.textContent = 'No rows in this section match.' +
                (othersVisible > 0 ? ' ' + othersVisible + ' match' + (othersVisible !== 1 ? 'es' : '') + ' in other sections.' : ' Try a shorter term or another category.');
            empty.hidden = false;
        }

        function filterTable(source) {
            let sections = SOURCE.reference.sections;
            let inputs = {};
            let catFilters = {};
            sections.forEach(function(s) {
                inputs[s.filterSource] = document.getElementById(s.search);
                catFilters[s.filterSource] = document.getElementById(s.category);
            });
            let primary = inputs[sections[0].filterSource];
            if (!primary) return;
            // Sync search inputs (but not category filters — each section has its own).
            // Whichever input the user typed in becomes the canonical value, then mirror to the others.
            let sourceInput = inputs[source];
            if (sourceInput && sourceInput !== primary) primary.value = sourceInput.value;
            sections.forEach(function(s) {
                let inp = inputs[s.filterSource];
                if (inp && inp !== primary) inp.value = primary.value;
            });
            // Trimmed: a pasted "  proxy-body-size  " matched nothing, because
            // the padding was searched for as part of the term.
            let term = primary.value.trim().toLowerCase();
            let categoryBySection = {};
            let anyCategory = false;
            sections.forEach(function(s) {
                let cf = catFilters[s.filterSource];
                categoryBySection[s.id] = cf ? cf.value : '';
                if (categoryBySection[s.id]) anyCategory = true;
            });
            // Save expanded state when filtering begins
            if ((term || anyCategory) && _savedExpanded.length === 0) {
                document.querySelectorAll('.expandable.expanded').forEach(function(r) { _savedExpanded.push(r); });
            }
            let sectionCounts = {};
            sections.forEach(function(s) { sectionCounts[s.id] = { visible: 0, total: 0 }; });
            document.querySelectorAll('.mapping-table').forEach(function(table) {
                let visibleCount = 0;
                let wrapper = table.closest('.table-wrapper');
                // Walk back past any info-boxes sitting between the heading and
                // the table. The heading is normally inside its .heading-row
                // (the permalink wrapper); `h3` is whichever of the two is the
                // table's sibling, so hiding it hides the permalink as well.
                let h3 = wrapper ? wrapper.previousElementSibling : null;
                while (h3 && h3.tagName !== 'H3' && !(h3.classList && h3.classList.contains('heading-row'))) h3 = h3.previousElementSibling;
                let heading = h3 && (h3.tagName === 'H3' ? h3 : h3.querySelector('h3'));
                let tableCategory = (heading && heading.id) ? heading.id : '';
                // Determine which category filter applies based on parent section
                let parentSection = table.closest('section[id]');
                let sectionId = parentSection ? parentSection.id : '';
                let category = categoryBySection[sectionId] || '';
                let categoryMatch = !category || tableCategory === category;
                let counts = sectionCounts[sectionId];
                table.querySelectorAll('tbody tr').forEach(function(row) {
                    if (row.classList.contains('example-row')) {
                        if (term || category) {
                            row.classList.remove('visible');
                            row.setAttribute('aria-hidden', 'true');
                            let prev = row.previousElementSibling;
                            if (prev) { prev.classList.remove('expanded'); prev.setAttribute('aria-expanded', 'false'); }
                        }
                        return;
                    }
                    if (counts) counts.total++;
                    let textMatch = !term || rowSearchText(row).includes(term);
                    let match = textMatch && categoryMatch;
                    // Only touch the style when it actually changes — an
                    // unconditional write invalidates layout for every row.
                    let hide = match ? '' : 'none';
                    if (row.style.display !== hide) row.style.display = hide;
                    if (match) visibleCount++;
                });
                if (counts) counts.visible += visibleCount;
                if (!wrapper) return;
                let hidden = (term || category) && visibleCount === 0;
                wrapper.style.display = hidden ? 'none' : '';
                if (h3) h3.style.display = hidden ? 'none' : '';
                // Hide any info-boxes between this table's heading and the table, plus a trailing note.
                if (h3) {
                    let sib = wrapper.previousElementSibling;
                    while (sib && sib !== h3 && sib.classList && sib.classList.contains('info-box')) {
                        sib.style.display = hidden ? 'none' : '';
                        sib = sib.previousElementSibling;
                    }
                }
                let infoBox = wrapper.nextElementSibling;
                if (infoBox && infoBox.classList && infoBox.classList.contains('info-box')) infoBox.style.display = hidden ? 'none' : '';
            });
            // Update result counts — each section shows its own tally, so an empty
            // section with matches elsewhere doesn't read as "3 of 306 rows" while
            // everything visible is thousands of pixels away in another section.
            function setCount(el, own, othersVisible) {
                if (!el) return;
                let text = '';
                let noResults = false;
                if (term) {
                    text = own.visible + ' of ' + own.total + ' rows';
                    noResults = own.visible === 0;
                    if (noResults && othersVisible > 0) {
                        text += ' — ' + othersVisible + ' match' + (othersVisible !== 1 ? 'es' : '') + ' in other sections';
                    }
                }
                el.textContent = text;
                el.className = 'search-count' + (noResults ? ' no-results' : '');
            }
            sections.forEach(function(s) {
                let own = sectionCounts[s.id];
                let othersVisible = 0;
                sections.forEach(function(o) { if (o !== s) othersVisible += sectionCounts[o.id].visible; });
                setCount(document.getElementById(s.count), own, othersVisible);
                setEmptyState(s, own, othersVisible);
            });
            // One announcement per search, for the section being typed in. The
            // three counters used to be aria-live themselves, and the inputs are
            // mirrored, so every keystroke queued three announcements at once.
            let typedIn = sections.filter(function(s) { return s.filterSource === source; })[0] || sections[0];
            let typedCount = document.getElementById(typedIn.count);
            clearTimeout(_searchAnnounceTimer);
            _searchAnnounceTimer = setTimeout(function() {
                if (typedCount && typedCount.textContent) announce(typedCount.textContent);
            }, 600);
            // Restore expanded state when filters are cleared
            if (!term && !anyCategory && _savedExpanded.length > 0) {
                _savedExpanded.forEach(function(r) {
                    r.classList.add('expanded');
                    r.setAttribute('aria-expanded', 'true');
                    let ex = r.nextElementSibling;
                    if (ex && ex.classList.contains('example-row')) {
                        ex.classList.add('visible');
                        ex.setAttribute('aria-hidden', 'false');
                    }
                });
                _savedExpanded = [];
            }
        }

        // Approach tabs switch an example's panels; the same tabs switch the
        // release notes' panels, one per NGINX Ingress Controller release.
        function switchApproach(btn, type) {
            const container = btn.closest('.example-content, .release-notes');
            container.querySelectorAll('.approach-tab').forEach(function(t) {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
                t.setAttribute('tabindex', '-1');
            });
            container.querySelectorAll('.approach-content').forEach(function(c) {
                c.classList.remove('active');
                c.setAttribute('aria-hidden', 'true');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            btn.setAttribute('tabindex', '0');
            let panel = container.querySelector('.approach-content[data-approach="' + type + '"]');
            panel.classList.add('active');
            panel.setAttribute('aria-hidden', 'false');
            // Highlight any code blocks that weren't highlighted on initial load
            highlightStaticExamples(panel);
        }
        // Permalinks go BESIDE their heading, in a .heading-row wrapper, not
        // inside it. Inside, "Permalink: <heading>" was part of the heading's
        // accessible name — and of the name of every table that points at the
        // heading with aria-labelledby: 50 headings and 50 tables read it.
        // Headings inside a .install-box or .feature-card are left alone: they
        // carry no id and get no anchor, as before.
        document.querySelectorAll('h2[id], h3[id]').forEach(heading => {
            const anchor = document.createElement('a');
            anchor.className = 'heading-anchor';
            // For h2 headings inside sections, prefer the section ID for consistency with sidebar navigation
            let anchorId = heading.id;
            if (heading.tagName === 'H2') {
                let parentSection = heading.parentElement;
                if (parentSection && parentSection.tagName === 'SECTION' && parentSection.id) anchorId = parentSection.id;
            }
            anchor.href = '#' + anchorId;
            anchor.addEventListener('click', function(e) {
                e.preventDefault();
                history.replaceState(null, '', '#' + anchorId);
                jumpTo(document.getElementById(anchorId), true);
            });
            anchor.setAttribute('aria-label', 'Permalink: ' + heading.textContent.trim());
            anchor.appendChild(makeSvg(
                { width: '16', height: '16', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
                [['path', { d: 'm7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z' }]]
            ));
            let row = document.createElement('div');
            // Whole literals, not 'heading-row ' + tagName: a composed name is
            // invisible to check-classes.py, which then calls the rule dead.
            row.className = heading.tagName === 'H2' ? 'heading-row heading-row-h2' : 'heading-row heading-row-h3';
            heading.parentNode.insertBefore(row, heading);
            row.appendChild(heading);
            row.appendChild(anchor);
        });

        // Respect the user's reduced-motion preference for programmatic scrolling.
        function scrollBehavior() {
            return (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth';
        }

        // Current fixed header height (banner + top bar) read from the rendered layout,
        // so scroll math shares a single source of truth with the CSS --fixed-top-h var.
        function fixedTopHeight() {
            let tb = document.querySelector('.topbar');
            return tb ? Math.round(tb.getBoundingClientRect().bottom) : (document.body.classList.contains('has-banner') ? 87 : 52);
        }

        // Scroll offset for an anchor target: the fixed header plus, on desktop,
        // the sticky search/filter bar when the target sits below it inside a
        // mapping section (the bar would otherwise cover the scrolled-to heading).
        function scrollOffsetFor(target) {
            // 16px clearance, --space-2x (12px is not on the spacing scale).
            let offset = fixedTopHeight() + 16;
            let section = target.closest('section');
            let controls = section && section.querySelector('.controls');
            if (controls && window.matchMedia('(min-width: 901px)').matches &&
                (controls.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                offset += controls.offsetHeight + 4;
            }
            return offset;
        }

        // Scroll an element to just below the fixed header. `smooth` is opt-in:
        // a jump is correct right after a page switch, where the browser has
        // only just laid the target out and an animation from an arbitrary
        // scroll position reads as a glitch.
        function scrollToAnchor(target, smooth) {
            if (!target) return;
            let y = target.getBoundingClientRect().top + window.pageYOffset - scrollOffsetFor(target);
            window.scrollTo(smooth ? { top: y, behavior: scrollBehavior() } : { top: y });
        }

        // The element a reader should land on for an anchor: a section's own
        // heading rather than the section box, so focus announces a name.
        function headingFor(target) {
            if (!target) return null;
            if (/^H[1-6]$/.test(target.tagName)) return target;
            return target.querySelector('h2, h3, h4') || target;
        }

        // An in-tool jump that moves the reader, not just the viewport: scroll
        // the target below the fixed bars and put focus on it. Scrolling alone
        // used to leave focus on the triggering link or pill — or, when the
        // jump switched pages, on the whole page container, so screen readers
        // announced the end-of-maintenance banner and the next Tab restarted
        // at the top of the page.
        function jumpTo(target, smooth) {
            if (!target) return;
            scrollToAnchor(target, smooth);
            focusTarget(headingFor(target));
        }

        // Go to an anchor anywhere in the tool: through its sidebar link when
        // it has one (which switches page, updates the hash and the nav state),
        // otherwise by revealing the owning page; then, once that page is laid
        // out, jump to the anchor itself and focus it.
        function goToAnchor(anchorId, sidebarSection) {
            let target = document.getElementById(anchorId);
            if (!target) return;
            let link = document.querySelector('.sidebar-link[data-section="' + (sidebarSection || anchorId) + '"]');
            if (link) {
                link.click();
            } else {
                let page = target.closest('.tool-page');
                let pageBtn = page && !page.classList.contains('active') &&
                    document.querySelector('.sidebar-link[data-page="' + page.id.replace('page-', '') + '"]');
                if (pageBtn) pageBtn.click();
            }
            requestAnimationFrame(function() { jumpTo(target, false); });
        }

        function copyAnalyzerBlock(btn) {
            let pre = btn.parentElement;
            if (!pre) return;
            let text = pre.getAttribute('data-raw') || pre.textContent.replace(/^Copy$|^Copied!$/m, '').trim();
            copyToClipboard(text, btn);
        }


        function renderParserWarnings(container, warnings) {
            warnings.forEach(function(w) {
                let card = document.createElement('div');
                card.className = 'info-box warning analyzer-parser-warning';
                let strong = document.createElement('strong');
                strong.textContent = w.title + ': ';
                card.appendChild(strong);
                card.appendChild(document.createTextNode(w.message));
                container.appendChild(card);
            });
        }

        function showAnalyzerLoading(container) {
            container.textContent = '';
            let wrap = document.createElement('div');
            wrap.className = 'analyzer-loading';
            let spinner = document.createElement('span');
            spinner.className = 'analyzer-loading-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            wrap.appendChild(spinner);
            wrap.appendChild(document.createTextNode('Analyzing your YAML…'));
            container.appendChild(wrap);
            // A freshly inserted, already-populated live node isn't announced by most
            // screen readers — write to the pre-existing live region instead.
            let liveStatus = document.getElementById('analyzerLiveStatus');
            if (liveStatus) liveStatus.textContent = 'Analyzing your YAML…';
        }

        function analyzeYaml() {
            let yamlText = document.getElementById('yamlInput').value.trim();
            let resultsDiv = document.getElementById('analyzerResults');
            if (!yamlText) {
                showAnalyzerMessage(resultsDiv, 'error', SOURCE.strings.analyzeEmpty.title, SOURCE.strings.analyzeEmpty.message);
                return;
            }
            // Paint a spinner immediately, then defer the heavy work to the next animation
            // frame so the user sees feedback even on multi-hundred-line inputs.
            showAnalyzerLoading(resultsDiv);
            requestAnimationFrame(function() { setTimeout(runAnalyzeYaml, 0); });
        }

        function runAnalyzeYaml() {
            let yamlText = document.getElementById('yamlInput').value.trim();
            let resultsDiv = document.getElementById('analyzerResults');
            if (!yamlText) return;
            try {
            let warnings = detectGenericSyntaxWarnings(yamlText);
            let parsed = SOURCE.analyzer.parseInput(yamlText);
            warnings = warnings.concat(parsed.warnings || []);
            // A source can say why nothing is analyzable (a parse error, no
            // Ingress in the paste) through parsed.empty; and a source that
            // can migrate an input with no findings (an Ingress with no
            // community annotations still needs a new class) leaves it unset.
            let empty = parsed.empty || ((!parsed.findings || parsed.findings.length === 0) && !(parsed.ingresses && parsed.ingresses.length) ? SOURCE.strings.noFindings : null);
            if (empty) {
                resultsDiv.textContent = '';
                renderParserWarnings(resultsDiv, warnings);
                showAnalyzerMessage(resultsDiv, 'info', empty.title, empty.message, { append: true });
                return;
            }
            let plan = SOURCE.analyzer.buildPlan(parsed, _migrationStrategy);
            renderPlan(resultsDiv, plan);
            // Prepend any parser/plan warnings inside the renderer's now-populated container.
            let allWarnings = warnings.concat(plan.warnings || []);
            if (allWarnings.length > 0) {
                let firstChild = resultsDiv.firstChild;
                let warningHolder = document.createDocumentFragment();
                renderParserWarnings(warningHolder, allWarnings);
                resultsDiv.insertBefore(warningHolder, firstChild);
            }
            // Smooth scroll to results, and take focus with it: left on the
            // Analyze button, focus sat scrolled up under the top bar and the
            // next Tab went back into the editor controls. A re-run from the
            // strategy toggle keeps focus on the toggle the reader just used.
            setTimeout(function() {
                resultsDiv.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
                let active = document.activeElement;
                if (!(active && active.closest && active.closest('.strategy-toggle'))) focusTarget(resultsDiv);
            }, 100);
            } catch (err) {
                showAnalyzerMessage(resultsDiv, 'error', 'Analysis failed.', 'There was an error parsing the YAML. Please check the format and try again.');
            }
        }

        function showAnalyzerMessage(container, type, title, message, opts) {
            opts = opts || {};
            let div = document.createElement('div');
            div.className = type === 'error' ? 'analyzer-error' : 'analyzer-info';
            let strong = document.createElement('strong');
            strong.textContent = title;
            div.appendChild(strong);
            div.appendChild(document.createTextNode(' ' + message));
            if (!opts.append) container.textContent = '';
            container.appendChild(div);
            // #analyzerResults is a plain region — mirror error/info messages into
            // the pre-existing live region so screen readers hear them too.
            let liveStatus = document.getElementById('analyzerLiveStatus');
            if (liveStatus) liveStatus.textContent = title + ' ' + message;
        }

        function highlightYaml(text) {
            let frag = document.createDocumentFragment();
            let lines = text.split('\n');
            lines.forEach(function(line, i) {
                if (i > 0) frag.appendChild(document.createTextNode('\n'));
                // Comment lines
                let trimmed = line.trimStart();
                if (trimmed.startsWith('#')) {
                    let indent = document.createTextNode(line.substring(0, line.length - trimmed.length));
                    frag.appendChild(indent);
                    let commentSpan = document.createElement('span');
                    commentSpan.className = 'yaml-comment';
                    commentSpan.textContent = trimmed;
                    frag.appendChild(commentSpan);
                    return;
                }
                // Document separator
                if (trimmed === '---') {
                    let sepSpan = document.createElement('span');
                    sepSpan.className = 'yaml-separator';
                    sepSpan.textContent = line;
                    frag.appendChild(sepSpan);
                    return;
                }
                // Key: value pairs
                let kvMatch = line.match(/^(\s*)([-]?\s*)([^\s:#\n]+)(\s*:\s*)(.*)?$/);
                if (kvMatch) {
                    frag.appendChild(document.createTextNode(kvMatch[1]));
                    if (kvMatch[2]) frag.appendChild(document.createTextNode(kvMatch[2]));
                    let keySpan = document.createElement('span');
                    keySpan.className = 'yaml-key';
                    keySpan.textContent = kvMatch[3];
                    frag.appendChild(keySpan);
                    let colonSpan = document.createElement('span');
                    colonSpan.className = 'yaml-separator';
                    colonSpan.textContent = kvMatch[4];
                    frag.appendChild(colonSpan);
                    if (kvMatch[5] !== undefined && kvMatch[5] !== '') {
                        let fullVal = kvMatch[5];
                        // Split trailing inline comment (# preceded by whitespace, outside quotes)
                        let commentStart = findInlineCommentStart(fullVal, true);
                        let val = commentStart >= 0 ? fullVal.substring(0, commentStart) : fullVal;
                        let inlineComment = commentStart >= 0 ? fullVal.substring(commentStart) : '';
                        let valSpan = document.createElement('span');
                        // Color-code specific value types
                        if (/^(apiVersion|kind|metadata|spec|data)$/.test(kvMatch[3].trim())) {
                            keySpan.className = 'yaml-keyword';
                        }
                        let valTrimmed = val.trim();
                        if (/^["']?(true|false|yes|no|on|off)["']?$/i.test(valTrimmed)) {
                            valSpan.className = 'yaml-bool';
                        } else if (/^["']?\d+(\.\d+)?[smhkMG]?["']?$/.test(valTrimmed)) {
                            valSpan.className = 'yaml-number';
                        } else if (valTrimmed.startsWith('#')) {
                            valSpan.className = 'yaml-comment';
                        } else {
                            valSpan.className = 'yaml-value';
                        }
                        valSpan.textContent = val;
                        frag.appendChild(valSpan);
                        if (inlineComment) {
                            let cmSpan = document.createElement('span');
                            cmSpan.className = 'yaml-comment';
                            cmSpan.textContent = inlineComment;
                            frag.appendChild(cmSpan);
                        }
                    }
                    return;
                }
                // List items (- value)
                let listMatch = line.match(/^(\s*)(- )(.*)$/);
                if (listMatch) {
                    frag.appendChild(document.createTextNode(listMatch[1]));
                    let dashSpan = document.createElement('span');
                    dashSpan.className = 'yaml-separator';
                    dashSpan.textContent = listMatch[2];
                    frag.appendChild(dashSpan);
                    let itemSpan = document.createElement('span');
                    itemSpan.className = 'yaml-value';
                    itemSpan.textContent = listMatch[3];
                    frag.appendChild(itemSpan);
                    return;
                }
                // Fallback — detect inline comments (e.g. snippet content with trailing # comment)
                let fbComment = findInlineCommentStart(line, true);
                if (fbComment >= 0) {
                    frag.appendChild(document.createTextNode(line.substring(0, fbComment)));
                    let fbCmSpan = document.createElement('span');
                    fbCmSpan.className = 'yaml-comment';
                    fbCmSpan.textContent = line.substring(fbComment);
                    frag.appendChild(fbCmSpan);
                } else {
                    frag.appendChild(document.createTextNode(line));
                }
            });
            return frag;
        }

        // Build an inline SVG icon: makeSvg({attrs}, [['path', {d}], …]).
        // No default attributes on purpose — these icons are a mix of stroked
        // and filled, and silently defaulting a stroke onto a filled path
        // repaints it. Every caller states what it needs.
        function makeSvg(attrs, children) {
            let ns = 'http://www.w3.org/2000/svg';
            function apply(el, a) {
                Object.keys(a).forEach(function(k) { el.setAttribute(k, a[k]); });
                return el;
            }
            let svg = apply(document.createElementNS(ns, 'svg'), attrs);
            (children || []).forEach(function(c) {
                svg.appendChild(apply(document.createElementNS(ns, c[0]), c[1]));
            });
            return svg;
        }

        // `label` names the block for assistive technology. Every Copy button
        // used to have the same accessible name, "Copy", so a screen reader
        // listing buttons heard a column of identical entries.
        let _yamlBlockSeq = 0;
        function buildYamlBlock(text, collapsible, label) {
            let pre = document.createElement('div');
            pre.className = 'analyzer-yaml-output';
            pre.id = 'analyzer-yaml-' + (++_yamlBlockSeq);
            let copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'analyzer-copy-btn';
            copyBtn.textContent = 'Copy';
            if (label) copyBtn.setAttribute('aria-label', 'Copy YAML: ' + label);
            copyBtn.addEventListener('click', function() { copyAnalyzerBlock(copyBtn); });
            pre.appendChild(copyBtn);
            pre.appendChild(highlightYaml(text));
            pre.setAttribute('data-raw', text);
            let lineCount = text.split('\n').length;
            if (collapsible && lineCount > 12) {
                pre.classList.add('collapsed');
                let wrapper = document.createDocumentFragment();
                wrapper.appendChild(pre);
                let expandBtn = document.createElement('button');
                expandBtn.type = 'button';
                expandBtn.className = 'analyzer-yaml-expand';
                expandBtn.setAttribute('aria-controls', pre.id);
                let setExpanded = function(expanded) {
                    pre.classList.toggle('collapsed', !expanded);
                    expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                    expandBtn.textContent = expanded ? 'Collapse' : 'Show Full YAML (' + lineCount + ' lines)';
                };
                setExpanded(false);
                expandBtn.addEventListener('click', function() {
                    setExpanded(pre.classList.contains('collapsed'));
                });
                wrapper.appendChild(expandBtn);
                return wrapper;
            }
            return pre;
        }

        // --- MigrationPlan rendering ---
        // renderPlan turns the pure-data MigrationPlan a source's buildPlan returns
        // into DOM. It has no source-specific branches: every string it shows comes
        // from the plan; unknown block types are skipped with a console warning.

        // `context` is what this comparison is about (the step or the CRD
        // category); with the side's own heading it makes each Copy button's
        // accessible name unique.
        function renderComparisonBlock(block, context) {
            let comp = document.createElement('div');
            comp.className = 'analyzer-comparison';
            [{ side: block.old, cls: 'old' }, { side: block.new, cls: 'new' }].forEach(function(pair) {
                let sideBlock = document.createElement('div');
                sideBlock.className = 'analyzer-comparison-block ' + pair.cls;
                let h5 = document.createElement('h4');
                h5.textContent = pair.side.title;
                if (pair.side.badge) {
                    let badge = document.createElement('span');
                    badge.className = 'analyzer-comparison-badge';
                    badge.textContent = pair.side.badge;
                    h5.appendChild(badge);
                }
                sideBlock.appendChild(h5);
                let side = (pair.side.title + (pair.side.badge ? ' (' + pair.side.badge + ')' : '')).replace(/\s+/g, ' ').trim();
                sideBlock.appendChild(buildYamlBlock(pair.side.yaml, pair.side.collapsible, context ? context + ', ' + side : side));
                comp.appendChild(sideBlock);
            });
            return comp;
        }

        // Link to Installing CRDs section instead of showing inline command
        function renderCrdInstallNote() {
            let installNote = document.createElement('div');
            installNote.className = 'info-box note analyzer-install-note';
            let noteStrong = document.createElement('strong');
            noteStrong.textContent = 'Note:';
            installNote.appendChild(noteStrong);
            installNote.appendChild(document.createTextNode(' These features require CRDs. See '));
            let installLink = document.createElement('a');
            installLink.href = '#installation';
            installLink.textContent = 'Installing CRDs';
            installLink.addEventListener('click', function(e) {
                e.preventDefault();
                goToAnchor('installation');
            });
            installNote.appendChild(installLink);
            installNote.appendChild(document.createTextNode(' for Helm and manifest installation instructions.'));
            return installNote;
        }

        function renderCrdGroup(block) {
            let groupDiv = document.createElement('div');
            groupDiv.className = 'analyzer-crd-group';
            let groupTitle = document.createElement('div');
            groupTitle.className = 'analyzer-crd-group-title';
            // Map CRD kind to badge class
            let kindBadgeMap = { 'Policy': 'policy', 'VirtualServer': 'virtualserver', 'VirtualServerRoute': 'virtualserverroute', 'TransportServer': 'transportserver', 'GlobalConfiguration': 'globalconfiguration' };
            let badgeClass = kindBadgeMap[block.kind] || 'virtualserver';
            let kindBadge = document.createElement('span');
            kindBadge.className = 'badge badge-' + badgeClass + ' analyzer-crd-kind-badge';
            kindBadge.textContent = block.kind + ' CRD';
            groupTitle.appendChild(kindBadge);
            groupTitle.appendChild(document.createTextNode(block.countText));
            groupDiv.appendChild(groupTitle);

            block.items.forEach(function(item, idx) {
                if (idx > 0) {
                    let spacer = document.createElement('hr');
                    spacer.className = 'analyzer-step-separator';
                    groupDiv.appendChild(spacer);
                }
                let catLabel = document.createElement('div');
                catLabel.className = 'analyzer-crd-category';
                catLabel.appendChild(document.createTextNode(item.category));
                if (item.plusRequired) {
                    let plusBadge = document.createElement('span');
                    plusBadge.className = 'plus-indicator';
                    plusBadge.textContent = 'Plus required';
                    catLabel.appendChild(plusBadge);
                }
                if (item.dualSuffix) catLabel.appendChild(document.createTextNode(item.dualSuffix));
                groupDiv.appendChild(catLabel);
                groupDiv.appendChild(renderComparisonBlock({ old: item.old, new: item.new }, item.category + ' ' + block.kind));
            });
            return groupDiv;
        }

        // One builder for all three step headers — the numbered steps, the
        // informational notes and the unsupported findings differed only in the
        // marker text and two optional modifier classes.
        function buildStep(opts) {
            let step = document.createElement('div');
            step.className = 'analyzer-step';
            step.id = opts.id;
            let header = document.createElement('div');
            header.className = 'analyzer-step-header';
            let num = document.createElement('span');
            num.className = 'analyzer-step-number' + (opts.markerCls ? ' ' + opts.markerCls : '');
            num.textContent = opts.marker;
            let title = document.createElement('h3');
            title.className = 'analyzer-step-title';
            title.textContent = opts.title;
            let count = document.createElement('span');
            count.className = 'analyzer-step-count' + (opts.countCls ? ' ' + opts.countCls : '');
            count.textContent = opts.countText;
            header.appendChild(num);
            header.appendChild(title);
            header.appendChild(count);
            step.appendChild(header);
            if (opts.desc) {
                let desc = document.createElement('div');
                desc.className = 'analyzer-step-desc';
                desc.textContent = opts.desc;
                step.appendChild(desc);
            }
            return step;
        }

        // One builder for the informational-note and unsupported-finding cards:
        // same shape, differing only in sentiment and an optional title.
        // Spacing comes from .analyzer-note-card / .analyzer-note-body in
        // migration.css — these used to carry inline `margin: 10px 0` and
        // `margin-top: 6px`, neither of which is on the 4px grid.
        function buildNoteCard(variant, opts) {
            let card = document.createElement('div');
            card.className = 'info-box ' + variant + ' analyzer-note-card';
            if (opts.title) {
                let strong = document.createElement('strong');
                strong.textContent = opts.title;
                card.appendChild(strong);
                card.appendChild(document.createTextNode(' — '));
            }
            let code = document.createElement('code');
            code.textContent = opts.code;
            card.appendChild(code);
            let body = document.createElement('div');
            body.className = 'analyzer-note-body';
            body.textContent = opts.text;
            card.appendChild(body);
            return card;
        }

        function renderPlan(container, plan) {
            container.textContent = '';

            // Summary pills
            let summary = document.createElement('div');
            summary.className = 'analyzer-summary';
            plan.pills.forEach(function(p) {
                // Scrollable pills are real buttons so keyboard users can operate them.
                let pill = document.createElement(p.scrollTo ? 'button' : 'span');
                pill.className = 'analyzer-pill ' + p.cls;
                pill.textContent = p.text;
                if (p.scrollTo) {
                    pill.type = 'button';
                    pill.setAttribute('data-scroll', p.scrollTo);
                    pill.setAttribute('title', 'Click to jump to this section');
                    // Focus goes with the scroll, onto the step's heading. It
                    // used to stay on the pill, so the next Tab went back to
                    // the top of the results rather than into the step.
                    pill.addEventListener('click', function() {
                        let el = document.getElementById(p.scrollTo);
                        if (!el) return;
                        el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
                        focusTarget(headingFor(el));
                    });
                }
                summary.appendChild(pill);
            });
            container.appendChild(summary);

            // Announce results to screen readers
            let liveStatus = document.getElementById('analyzerLiveStatus');
            if (liveStatus) liveStatus.textContent = plan.liveText;

            let animDelay = 0;
            function applyFadeIn(el) {
                el.classList.add('analyzer-fade-in');
                el.style.animationDelay = animDelay + 'ms';
                animDelay += 100;
            }
            applyFadeIn(summary);

            // Success banner
            let banner = document.createElement('div');
            banner.className = 'analyzer-success-banner';
            // Every icon the renderer draws sits beside text that says the same
            // thing, so all four are hidden from assistive technology.
            banner.appendChild(makeSvg(
                { width: '22', height: '22', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5', 'aria-hidden': 'true' },
                [['path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }],
                 ['polyline', { points: '22 4 12 14.01 9 11.01' }]]
            ));
            let bannerText = document.createElement('div');
            bannerText.className = 'banner-text';
            bannerText.textContent = 'Analysis complete — ';
            let bannerStrong = document.createElement('strong');
            bannerStrong.textContent = plan.banner.strongText;
            bannerText.appendChild(bannerStrong);
            bannerText.appendChild(document.createTextNode(plan.banner.restText));
            banner.appendChild(bannerText);

            // Complexity indicator
            let complexityLevel = plan.banner.complexity;
            let complexityLabels = { simple: 'Simple migration', moderate: 'Moderate migration', advanced: 'Advanced migration' };
            let complexityFilled = { simple: 1, moderate: 2, advanced: 3 };
            let complexBadge = document.createElement('span');
            complexBadge.className = 'analyzer-complexity ' + complexityLevel;
            let dotsDiv = document.createElement('span');
            dotsDiv.className = 'analyzer-complexity-dots';
            for (let ci = 0; ci < 3; ci++) {
                let dot = document.createElement('span');
                if (ci < complexityFilled[complexityLevel]) dot.className = 'filled';
                dotsDiv.appendChild(dot);
            }
            complexBadge.appendChild(dotsDiv);
            complexBadge.appendChild(document.createTextNode(complexityLabels[complexityLevel]));
            banner.appendChild(complexBadge);
            applyFadeIn(banner);
            container.appendChild(banner);

            // Numbered steps — the id is fixed per step type (pills scroll to it),
            // the displayed number is sequential in render order.
            let stepNum = 0;
            plan.steps.forEach(function(stepData) {
                stepNum++;
                let step = buildStep({
                    id: stepData.id,
                    marker: String(stepNum),
                    title: stepData.title,
                    countText: stepData.countText,
                    countCls: stepData.countCls,
                    desc: stepData.desc
                });

                stepData.blocks.forEach(function(block) {
                    if (block.type === 'comparison') {
                        step.appendChild(renderComparisonBlock(block, stepData.title));
                    } else if (block.type === 'dual-note') {
                        let dualNote = document.createElement('div');
                        dualNote.className = 'analyzer-dual-note';
                        dualNote.textContent = block.text;
                        step.appendChild(dualNote);
                    } else if (block.type === 'crd-install-note') {
                        step.appendChild(renderCrdInstallNote());
                    } else if (block.type === 'crd-group') {
                        step.appendChild(renderCrdGroup(block));
                    } else {
                        console.warn('renderPlan: unknown block type "' + block.type + '" skipped');
                    }
                });

                applyFadeIn(step);
                container.appendChild(step);
            });

            // Informational notes (recognized values that don't need a swap or have no equivalent)
            if (plan.infoNotes && plan.infoNotes.length > 0) {
                let stepInfo = buildStep({
                    id: 'analyzer-info-notes',
                    marker: 'i',
                    title: 'Informational notes',
                    countText: plan.infoNotes.length + ' note' + (plan.infoNotes.length !== 1 ? 's' : '')
                });
                plan.infoNotes.forEach(function(note) {
                    stepInfo.appendChild(buildNoteCard('note', { code: note.code, text: note.message }));
                });
                applyFadeIn(stepInfo);
                container.appendChild(stepInfo);
            }

            // Unsupported findings (recognized but no migration path)
            if (plan.unsupported) {
                let step4 = buildStep({
                    id: 'analyzer-unsupported',
                    marker: '!',
                    markerCls: 'warning',
                    title: plan.unsupported.title,
                    countText: plan.unsupported.countText,
                    countCls: 'unsupported',
                    desc: plan.unsupported.desc
                });

                plan.unsupported.cards.forEach(function(cardData) {
                    let card = buildNoteCard('warning', {
                        title: cardData.title,
                        code: cardData.code,
                        text: cardData.desc
                    });
                    if (cardData.anchor) {
                        let link = document.createElement('a');
                        link.href = '#' + cardData.anchor;
                        link.className = 'analyzer-note-link';
                        link.textContent = 'See reference guide →';
                        // One of these per card, so the visible text alone does
                        // not say where each goes.
                        if (cardData.title) link.setAttribute('aria-label', 'See reference guide: ' + cardData.title);
                        link.addEventListener('click', function(e) {
                            e.preventDefault();
                            goToAnchor(cardData.anchor, cardData.sidebarSection);
                        });
                        card.appendChild(link);
                    }
                    step4.appendChild(card);
                });

                applyFadeIn(step4);
                container.appendChild(step4);
            }

            // Unrecognized
            if (plan.unrecognized) {
                let unrecSection = document.createElement('div');
                unrecSection.className = 'analyzer-unrecognized-section';
                unrecSection.id = 'analyzer-unrecognized';
                let h4 = document.createElement('h4');
                h4.textContent = plan.unrecognized.title;
                unrecSection.appendChild(h4);
                let desc = document.createElement('p');
                desc.className = 'analyzer-unrecognized-desc';
                desc.textContent = plan.unrecognized.desc;
                unrecSection.appendChild(desc);
                plan.unrecognized.items.forEach(function(u) {
                    let uCard = document.createElement('div');
                    uCard.className = 'analyzer-card unrecognized';
                    let uHeader = document.createElement('div');
                    uHeader.className = 'analyzer-card-header';
                    let uFound = document.createElement('div');
                    uFound.className = 'found-annotations';
                    // Named by the annotation it holds, the first key under
                    // `annotations:` in the item's snippet.
                    let uKey = (/^\s+([^\s:]+):/m.exec(u.yaml) || [])[1];
                    uFound.appendChild(buildYamlBlock(u.yaml, false, uKey ? 'unrecognized ' + uKey : 'unrecognized annotation'));
                    uHeader.appendChild(uFound);
                    uCard.appendChild(uHeader);
                    unrecSection.appendChild(uCard);
                });
                let contributeP = document.createElement('p');
                contributeP.className = 'analyzer-contribute';
                let contributeLink = document.createElement('a');
                contributeLink.href = 'https://github.com/nginx/kubernetes.nginx.org';
                contributeLink.target = '_blank';
                contributeLink.rel = 'noopener noreferrer';
                contributeLink.textContent = 'Contribute a mapping on GitHub →';
                contributeP.appendChild(contributeLink);
                unrecSection.appendChild(contributeP);
                applyFadeIn(unrecSection);
                container.appendChild(unrecSection);
            }

            // Export actions (Copy All + Download)
            if (plan.export) {
                let allYaml = plan.export.parts.join('\n---\n');
                let exportRow = document.createElement('div');
                exportRow.className = 'analyzer-export-actions';
                let copyAllBtn = document.createElement('button');
                copyAllBtn.className = 'analyzer-copy-all';
                copyAllBtn.type = 'button';
                copyAllBtn.appendChild(makeSvg(
                    { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'aria-hidden': 'true' },
                    [['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }],
                     ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]]
                ));
                // The label lives in its own span so the shared copy-feedback
                // helpers can swap it without destroying the icon beside it.
                addCopyLabel(copyAllBtn, 'Copy All Migration YAML');
                copyAllBtn.addEventListener('click', function() {
                    copyToClipboard(allYaml, copyAllBtn, 'Migration YAML copied to clipboard');
                });
                exportRow.appendChild(copyAllBtn);

                // Download YAML button
                let dlBtn = document.createElement('button');
                dlBtn.className = 'analyzer-download-btn';
                dlBtn.type = 'button';
                dlBtn.appendChild(makeSvg(
                    { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'aria-hidden': 'true' },
                    [['path', { d: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4' }],
                     ['polyline', { points: '7 10 12 15 17 10' }],
                     ['line', { x1: '12', y1: '15', x2: '12', y2: '3' }]]
                ));
                let dlLabel = addCopyLabel(dlBtn, 'Download YAML');
                dlBtn.addEventListener('click', function() {
                    let header = SOURCE.export.header + '\n# Generated: ' + new Date().toISOString().split('T')[0] + '\n\n';
                    let blob = new Blob([header + allYaml], { type: 'application/x-yaml' });
                    let url = URL.createObjectURL(blob);
                    let a = document.createElement('a');
                    a.href = url;
                    a.download = SOURCE.export.filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    dlBtn.classList.add('downloaded');
                    dlLabel.textContent = 'Downloaded!';
                    // The label change is silent to a screen reader, and so is
                    // the download itself; Copy already announces, now this does.
                    announce('Downloaded ' + SOURCE.export.filename);
                    setTimeout(function() {
                        dlLabel.textContent = 'Download YAML';
                        dlBtn.classList.remove('downloaded');
                    }, 2000);
                });
                exportRow.appendChild(dlBtn);
                container.appendChild(exportRow);
            }

            // What's next section
            if (plan.nextItems && plan.nextItems.length > 0) {
                let nextBox = document.createElement('div');
                nextBox.className = 'analyzer-next-steps';
                let nextH4 = document.createElement('h4');
                nextH4.textContent = "What's next?";
                nextBox.appendChild(nextH4);
                let nextUl = document.createElement('ul');
                plan.nextItems.forEach(function(item) {
                    let li = document.createElement('li');
                    let a = document.createElement('a');
                    if (item.external) {
                        a.href = item.href;
                        a.target = '_blank';
                        a.rel = 'noopener noreferrer';
                    } else {
                        a.href = item.anchor;
                        a.addEventListener('click', function(e) {
                            e.preventDefault();
                            highlightSection(item.anchor.replace('#', ''));
                        });
                    }
                    a.textContent = item.text;
                    li.appendChild(a);
                    nextUl.appendChild(li);
                });
                nextBox.appendChild(nextUl);
                container.appendChild(nextBox);

                // Edit YAML button
                let editBtn = document.createElement('button');
                editBtn.className = 'analyzer-edit-btn';
                editBtn.type = 'button';
                editBtn.appendChild(makeSvg(
                    { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'aria-hidden': 'true' },
                    [['path', { d: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7' }],
                     ['path', { d: 'M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z' }]]
                ));
                // A button, so Title Case like every other button label.
                editBtn.appendChild(document.createTextNode('Edit YAML & Re-Analyze'));
                editBtn.addEventListener('click', function() {
                    // Switch to analyzer page
                    let analyzerPageLink = document.querySelector('.sidebar-link[data-page="analyzer"]');
                    if (analyzerPageLink) analyzerPageLink.click();
                    setTimeout(function() {
                        let textarea = document.getElementById('yamlInput');
                        textarea.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
                        setTimeout(function() { textarea.focus(); }, 400);
                    }, 100);
                });
                container.appendChild(editBtn);
            }
        }

        function clearAnalyzer() {
            document.getElementById('yamlInput').value = '';
            document.getElementById('analyzerResults').textContent = '';
            // The highlight overlay is painted from the textarea, and clearing
            // the value fires no input event — the old YAML stayed painted
            // behind an empty editor. The live region likewise kept the last
            // run's result, which a screen reader could still land on.
            updateYamlHighlight();
            let liveStatus = document.getElementById('analyzerLiveStatus');
            if (liveStatus) liveStatus.textContent = '';
            announce('Analyzer cleared');
            showEmptyState();
            updateInputStatus();
        }

        function toggleSampleDropdown(e) {
            e.stopPropagation();
            let dropdown = document.getElementById('sampleDropdown');
            let btn = e.target.closest('.sample-dropdown-btn');
            let isVisible = dropdown.classList.toggle('visible');
            if (btn) btn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
            if (isVisible && btn) {
                // Position dropdown up or down based on available space
                let btnRect = btn.getBoundingClientRect();
                let spaceBelow = window.innerHeight - btnRect.bottom;
                let spaceAbove = btnRect.top;
                // Temporarily show to measure height
                dropdown.style.top = ''; dropdown.style.bottom = '';
                let dropH = dropdown.offsetHeight;
                // 8px clearance, matching --space-base; the numeric comparison
                // needs a number, the offsets resolve the token.
                if (spaceAbove > dropH + 8 && spaceBelow < dropH + 8) {
                    // Open upward
                    dropdown.style.bottom = 'calc(100% + var(--space-base))';
                    dropdown.style.top = 'auto';
                } else {
                    // Open downward
                    dropdown.style.top = 'calc(100% + var(--space-base))';
                    dropdown.style.bottom = 'auto';
                }
                let firstItem = dropdown.querySelector('[role="menuitem"]');
                if (firstItem) focusMenuItem(firstItem);
            }
        }

        // Roving tabindex (WAI-ARIA menu pattern): exactly one item is
        // reachable, the one with focus, and arrow keys move between them. Every
        // item used to be its own Tab stop, so tabbing through the open menu
        // took three stops and left it open behind you.
        function focusMenuItem(item) {
            let dropdown = document.getElementById('sampleDropdown');
            dropdown.querySelectorAll('[role="menuitem"]').forEach(function(i) {
                i.setAttribute('tabindex', i === item ? '0' : '-1');
            });
            item.focus();
        }

        function closeSampleMenu(returnFocus) {
            let dropdown = document.getElementById('sampleDropdown');
            let btn = document.querySelector('.sample-dropdown-btn');
            if (!dropdown || !dropdown.classList.contains('visible')) return;
            dropdown.classList.remove('visible');
            if (btn) {
                btn.setAttribute('aria-expanded', 'false');
                if (returnFocus) btn.focus();
            }
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', function(e) {
            let dropdown = document.getElementById('sampleDropdown');
            let btn = document.querySelector('.sample-dropdown-btn');
            if (dropdown && !e.target.closest('.sample-dropdown')) {
                dropdown.classList.remove('visible');
                if (btn) btn.setAttribute('aria-expanded', 'false');
            }
        });

        // Keyboard navigation within the sample menu (WAI-ARIA menu pattern).
        (function() {
            let dropdown = document.getElementById('sampleDropdown');
            if (!dropdown) return;
            // The markup gives each item tabindex="0" so it stays operable if
            // this script never runs; once it does, only the roving item is.
            dropdown.querySelectorAll('[role="menuitem"]').forEach(function(i) { i.setAttribute('tabindex', '-1'); });
            dropdown.addEventListener('keydown', function(e) {
                let items = Array.from(dropdown.querySelectorAll('[role="menuitem"]'));
                if (!items.length) return;
                let idx = items.indexOf(document.activeElement);
                if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(items[(idx + 1) % items.length]); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(items[(idx - 1 + items.length) % items.length]); }
                else if (e.key === 'Home') { e.preventDefault(); focusMenuItem(items[0]); }
                else if (e.key === 'End') { e.preventDefault(); focusMenuItem(items[items.length - 1]); }
                else if (e.key === 'Escape') { e.preventDefault(); closeSampleMenu(true); }
                // Tab leaves the menu as the pattern specifies: it closes, and
                // focus moves on from the trigger rather than from inside a
                // menu that is about to vanish.
                else if (e.key === 'Tab') { closeSampleMenu(false); }
            });
            // Any other way focus leaves (a click elsewhere is handled above;
            // this covers a screen reader's virtual cursor and Shift+Tab).
            dropdown.addEventListener('focusout', function(e) {
                if (!dropdown.contains(e.relatedTarget)) closeSampleMenu(false);
            });
        })();

        function loadSampleYaml(preset) {
            let presets = SOURCE.analyzer.samplePresets;
            let yaml = presets[preset] || presets[SOURCE.analyzer.defaultPreset];
            document.getElementById('yamlInput').value = yaml;
            document.getElementById('analyzerResults').textContent = '';
            // Focus was on the now-hidden menu item — return it to the trigger.
            closeSampleMenu(true);
            updateInputStatus();
            updateYamlHighlight();
        }

        // Go to a section, focus its heading, and flash it so the eye finds it.
        function highlightSection(anchorId) {
            let el = document.getElementById(anchorId);
            if (!el) return;
            goToAnchor(anchorId);
            requestAnimationFrame(function() {
                el.style.transition = 'background-color var(--dur-reveal)';
                el.style.backgroundColor = 'var(--amber-tint)';
                setTimeout(function() {
                    el.style.backgroundColor = '';
                    setTimeout(function() { el.style.transition = ''; }, 300);
                }, 2000);
            });
        }

        function showEmptyState() {
            let resultsDiv = document.getElementById('analyzerResults');
            if (resultsDiv.children.length > 0) return;
            let empty = document.createElement('div');
            empty.className = 'analyzer-empty-state';
            empty.id = 'analyzerEmptyState';
            empty.appendChild(makeSvg(
                // colour comes from CSS
                { width: '48', height: '48', viewBox: '0 0 24 24', fill: 'none', 'stroke-width': '1.5' },
                [['path', { d: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z' }],
                 ['polyline', { points: '14 2 14 8 20 8' }],
                 ['line', { x1: '16', y1: '13', x2: '8', y2: '13' }],
                 ['line', { x1: '16', y1: '17', x2: '8', y2: '17' }]]
            ));
            let p1 = document.createElement('p');
            p1.textContent = SOURCE.strings.emptyStateLead;
            empty.appendChild(p1);
            let p2 = document.createElement('p');
            p2.className = 'hint';
            p2.textContent = SOURCE.strings.emptyStateHint;
            empty.appendChild(p2);
            resultsDiv.appendChild(empty);
        }

        // Drag-and-drop file upload
        (function() {
            let dropZone = document.getElementById('dropZone');
            let textarea = document.getElementById('yamlInput');
            let dragCounter = 0;
            dropZone.addEventListener('dragenter', function(e) {
                e.preventDefault();
                dragCounter++;
                dropZone.classList.add('dragging');
            });
            dropZone.addEventListener('dragleave', function(e) {
                e.preventDefault();
                dragCounter--;
                if (dragCounter <= 0) { dragCounter = 0; dropZone.classList.remove('dragging'); }
            });
            dropZone.addEventListener('dragover', function(e) { e.preventDefault(); });
            dropZone.addEventListener('drop', function(e) {
                e.preventDefault();
                dragCounter = 0;
                dropZone.classList.remove('dragging');
                let files = e.dataTransfer.files;
                if (files.length > 0) {
                    let file = files[0];
                    if (file.name.match(/\.(ya?ml|txt)$/i) || file.type === 'text/plain' || file.type === 'application/x-yaml') {
                        let reader = new FileReader();
                        reader.onload = function(ev) {
                            textarea.value = ev.target.result;
                            updateInputStatus();
                            updateYamlHighlight();
                            document.getElementById('analyzerResults').textContent = '';
                        };
                        reader.readAsText(file);
                    }
                }
            });
        })();

        // Live input status
        function updateInputStatus() {
            let val = document.getElementById('yamlInput').value;
            let lineCount = val ? val.split('\n').length : 0;
            let annotationCount = SOURCE.inputStatus ? (val.match(SOURCE.inputStatus.pattern) || []).length : 0;
            document.getElementById('statusLines').textContent = lineCount + ' line' + (lineCount !== 1 ? 's' : '');
            document.getElementById('statusDot').className = 'status-dot ' + (lineCount > 0 ? 'active' : 'inactive');
            let annStatus = document.getElementById('statusAnnotations');
            if (annotationCount > 0) {
                annStatus.style.display = '';
                document.getElementById('statusAnnotationCount').textContent = annotationCount + ' ' + SOURCE.inputStatus.noun + (annotationCount !== 1 ? 's' : '') + ' detected';
            } else {
                annStatus.style.display = 'none';
            }
        }
        // Above this size, rebuilding the token spans on every keystroke causes
        // visible typing lag (a cluster-wide `kubectl get ingress -A -o yaml` dump
        // easily reaches thousands of lines) — fall back to plain text in the
        // overlay: the text stays readable, only the coloring is dropped.
        let HIGHLIGHT_LINE_LIMIT = 1500;
        function updateYamlHighlight() {
            let textarea = document.getElementById('yamlInput');
            let highlight = document.getElementById('yamlHighlight');
            highlight.textContent = '';
            if (textarea.value) {
                let lineCount = (textarea.value.match(/\n/g) || []).length + 1;
                if (lineCount > HIGHLIGHT_LINE_LIMIT) {
                    highlight.appendChild(document.createTextNode(textarea.value));
                } else {
                    highlight.appendChild(highlightYaml(textarea.value));
                }
                // Append a trailing newline so the pre height matches textarea with trailing newline
                highlight.appendChild(document.createTextNode('\n'));
            }
        }

        function syncEditorScroll() {
            let textarea = document.getElementById('yamlInput');
            let highlight = document.getElementById('yamlHighlight');
            highlight.scrollTop = textarea.scrollTop;
            highlight.scrollLeft = textarea.scrollLeft;
        }

        // Both passes walk the whole document — one counts lines and annotations,
        // the other rebuilds the highlight overlay. Running them synchronously on
        // every keystroke is visible as typing lag on a large paste, so they are
        // coalesced to one update per frame. The textarea itself is a native
        // control and keeps painting the caret and text without waiting for us.
        let editorUpdateQueued = false;
        function scheduleEditorUpdate() {
            if (editorUpdateQueued) return;
            editorUpdateQueued = true;
            requestAnimationFrame(function() {
                editorUpdateQueued = false;
                updateInputStatus();
                updateYamlHighlight();
            });
        }

        let yamlInputEl = document.getElementById('yamlInput');
        yamlInputEl.addEventListener('input', scheduleEditorUpdate);
        yamlInputEl.addEventListener('scroll', syncEditorScroll, { passive: true });

        // Keyboard shortcuts for textarea
        yamlInputEl.addEventListener('keydown', function(e) {
            // Ctrl+Enter or Cmd+Enter to analyze
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                analyzeYaml();
                return;
            }
            // Tab inserts 2 spaces (Escape releases focus)
            if (e.key === 'Escape') {
                this.blur();
                return;
            }
            // Shift+Tab must keep moving focus backwards — intercepting it too
            // would make the textarea a full keyboard trap.
            if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                let start = this.selectionStart;
                let end = this.selectionEnd;
                this.value = this.value.substring(0, start) + '  ' + this.value.substring(end);
                this.selectionStart = this.selectionEnd = start + 2;
                scheduleEditorUpdate();
            }
        });

        // Show empty state on page load
        showEmptyState();

        // Page switching (Analyzer / Reference)
        (function() {
            let pageLinks = document.querySelectorAll('.sidebar-link[data-page]');
            let sectionLinks = document.querySelectorAll('.sidebar-link[data-section]');
            let allSubnavs = document.querySelectorAll('.sidebar-subnav');

            let currentPage = SOURCE.reference.defaultPage;
            // The page's own <title>, read once before anything switches, so the
            // per-view titles below compose against it without the source module
            // having to declare it.
            let baseTitle = document.title;

            function showPage(id, opts) {
                opts = opts || {};
                let switching = (id !== currentPage);
                currentPage = id;
                let pageNames = SOURCE.strings.pageNames;

                // Whether keyboard focus is currently inside a tool page. That page
                // is about to be hidden, which would strand focus on an element in a
                // hidden subtree — it is not perceivable, and hidden="until-found"
                // content is out of the accessibility tree. The one trigger of this
                // shape on the page is the "config analyzer" link in the Getting
                // started tip. Read BEFORE the pages are toggled.
                //
                // Deliberately not unconditional: a sidebar link lives outside the
                // pages, so clicking one keeps its focus where the user put it.
                let focusLeavingPage = !!(document.activeElement &&
                    document.activeElement.closest &&
                    document.activeElement.closest('.tool-page'));

                // Toggle tool-page visibility — inactive pages are hidden="until-found"
                // (not display:none) so browser find-in-page can search their content.
                document.querySelectorAll('.tool-page').forEach(function(p) { p.classList.remove('active'); p.setAttribute('hidden', 'until-found'); });
                let page = document.getElementById('page-' + id);
                if (page) {
                    page.removeAttribute('hidden');
                    page.classList.add('active');
                    if (focusLeavingPage) {
                        page.setAttribute('tabindex', '-1');
                        page.focus({ preventScroll: true });
                    }
                }

                // Tab title per view. Every switch below pushes a history entry, so
                // without this the whole tool shares one label in the tab, in the
                // Back-button menu and to a screen reader. The default page carries
                // the bare site title, matching the landing page's treatment of Home.
                document.title = (id === SOURCE.reference.defaultPage ? '' : (pageNames[id] || id) + ' — ') + baseTitle;

                // Update sidebar active states
                pageLinks.forEach(function(l) { l.classList.remove('active'); l.removeAttribute('aria-current'); });
                let activeLink = document.querySelector('.sidebar-link[data-page="' + id + '"]');
                if (activeLink) { activeLink.classList.add('active'); activeLink.setAttribute('aria-current', 'page'); }

                // Toggle subnavs — open the one belonging to the active page, close others
                allSubnavs.forEach(function(sn) {
                    sn.classList.remove('open');
                    let ctrl = sn.parentElement && sn.parentElement.querySelector('[aria-controls="' + sn.id + '"]');
                    if (ctrl) ctrl.setAttribute('aria-expanded', 'false');
                });
                if (activeLink) {
                    let parentSubnav = activeLink.parentElement.querySelector('.sidebar-subnav');
                    if (parentSubnav) { parentSubnav.classList.add('open'); activeLink.setAttribute('aria-expanded', 'true'); }
                }

                // Update URL hash — a real history entry per page switch so Back/Forward
                // navigate within the tool (restored by the hashchange listener below);
                // guarded so re-clicks and hash-driven restores don't stack duplicates.
                if (opts.updateHash !== false && location.hash !== '#' + id) {
                    history.pushState(null, '', '#' + id);
                }

                // Announce page switch for screen readers
                if (switching) {
                    announce('Navigated to ' + (pageNames[id] || id));
                }

                // Update mobile breadcrumb
                let breadcrumb = document.getElementById('mobileBreadcrumb');
                if (breadcrumb) breadcrumb.textContent = pageNames[id] || id;

                // Only scroll to top when switching pages (unless caller handles scroll)
                if (switching && !opts.skipScroll) window.scrollTo(0, 0);
                // Shared closeSidebar() (a no-op while the drawer isn't open) also clears
                // the inert attribute openSidebar() set on .main — a local re-implementation
                // here used to leave the whole page inert after mobile drawer navigation.
                closeSidebar();
            }

            // Page link click handlers. Re-clicking the already-active parent
            // acts as a disclosure toggle (collapse/expand its subnav, chevron
            // follows via aria-expanded) instead of re-navigating; switching
            // pages via showPage() always reopens the active page's subnav.
            pageLinks.forEach(function(link) {
                link.addEventListener('click', function() {
                    let id = this.getAttribute('data-page');
                    if (id === currentPage && this.hasAttribute('aria-controls')) {
                        let subnav = document.getElementById(this.getAttribute('aria-controls'));
                        if (subnav) {
                            let nowOpen = !subnav.classList.contains('open');
                            subnav.classList.toggle('open', nowOpen);
                            this.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
                            return;
                        }
                    }
                    showPage(id);
                });
            });

            // Chromium fires beforematch when find-in-page reveals a
            // hidden="until-found" page — sync the tool state to it without
            // touching the scroll position (the browser jumps to the match).
            document.querySelectorAll('.tool-page').forEach(function(p) {
                p.addEventListener('beforematch', function() {
                    showPage(p.id.replace('page-', ''), { updateHash: false, skipScroll: true });
                });
            });

            // Map sections to their parent pages
            let sectionPageMap = SOURCE.reference.sectionPageMap;

            // Section link click handlers — switch to parent page + scroll
            sectionLinks.forEach(function(link) {
                link.addEventListener('click', function() {
                    let sectionId = this.getAttribute('data-section');
                    let targetPage = sectionPageMap[sectionId] || SOURCE.reference.fallbackPage;
                    let wasOnTargetPage = (currentPage === targetPage);
                    // Ensure target page is visible (skip hash + scroll-to-top)
                    showPage(targetPage, { updateHash: false, skipScroll: true });
                    // Update hash to the section (real, deduplicated entry so Back works)
                    if (location.hash !== '#' + sectionId) {
                        history.pushState(null, '', '#' + sectionId);
                    }

                    if (wasOnTargetPage) {
                        // Already on the page — scroll immediately
                        scrollToAnchor(document.getElementById(sectionId), true);
                    } else {
                        // Just switched pages — need a frame for layout, then jump (no smooth) to section
                        requestAnimationFrame(function() {
                            scrollToAnchor(document.getElementById(sectionId), false);
                        });
                    }

                    // Highlight active sub-link (suppress observer briefly)
                    _clickScrolling = true;
                    sectionLinks.forEach(function(l) { l.classList.remove('active'); });
                    this.classList.add('active');
                    clearTimeout(_clickScrollTimer);
                    _clickScrollTimer = setTimeout(function() { _clickScrolling = false; }, 1000);
                });
            });

            // Scroll-based active sub-link highlighting
            let _clickScrolling = false;
            let _clickScrollTimer = null;
            let sections = [];
            sectionLinks.forEach(function(link) {
                let id = link.getAttribute('data-section');
                let section = document.getElementById(id);
                if (section) sections.push({ el: section, link: link });
            });
            if (sections.length > 0) {
                let observer = new IntersectionObserver(function(entries) {
                    if (_clickScrolling) return;
                    entries.forEach(function(entry) {
                        if (entry.isIntersecting) {
                            let matched = sections.find(function(s) { return s.el === entry.target; });
                            if (matched) {
                                let sectionId = matched.link.getAttribute('data-section');
                                let parentPage = sectionPageMap[sectionId] || SOURCE.reference.fallbackPage;
                                let parentEl = document.getElementById('page-' + parentPage);
                                if (!parentEl || !parentEl.classList.contains('active')) return;
                                sectionLinks.forEach(function(l) { l.classList.remove('active'); });
                                matched.link.classList.add('active');
                            }
                        }
                    });
                }, { rootMargin: '-' + fixedTopHeight() + 'px 0px -60% 0px', threshold: 0 });
                sections.forEach(function(s) { observer.observe(s.el); });
            }

            // Navigate to whatever the URL hash points at — sidebar sections, tool pages,
            // or any anchor inside a (possibly hidden) tool page. Runs on load for deep
            // links, and on hashchange for Back/Forward and plain in-content anchors.
            function navigateFromHash() {
                let hash = location.hash.replace('#', '');
                if (!hash) {
                    // Back past the first in-tool navigation lands on the bare URL.
                    showPage(SOURCE.reference.defaultPage, { updateHash: false });
                    return;
                }
                // Anything outside [\w-] can't be an id on this page and would break
                // the attribute selector below (e.g. a trailing backslash throws).
                if (!/^[\w-]+$/.test(hash)) return;
                let sectionLink = document.querySelector('.sidebar-link[data-section="' + hash + '"]');
                if (sectionLink) {
                    sectionLink.click();
                } else if (Object.prototype.hasOwnProperty.call(SOURCE.strings.pageNames, hash)) {
                    showPage(hash);
                } else {
                    // Heading permalinks and other subsection anchors live inside
                    // display:none tool pages, so the browser's native fragment scroll
                    // can't reach them — activate the owning page, then scroll past
                    // the fixed header.
                    let target = document.getElementById(hash);
                    let owner = target && target.closest('.tool-page');
                    if (target && owner) {
                        if (!owner.classList.contains('active')) {
                            showPage(owner.id.replace('page-', ''), { updateHash: false, skipScroll: true });
                        }
                        requestAnimationFrame(function() { scrollToAnchor(target, false); });
                    }
                }
            }
            if (location.hash) navigateFromHash();
            window.addEventListener('hashchange', navigateFromHash);
        })();

        // Scroll-to-top button (created dynamically to ensure it exists)
        (function() {
            let btn = document.createElement('button');
            btn.className = 'scroll-to-top';
            btn.id = 'scrollTopBtn';
            btn.setAttribute('aria-label', 'Scroll to top');
            btn.appendChild(makeSvg(
                { width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
                  'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
                [['polyline', { points: '18 15 12 9 6 15' }]]
            ));
            document.body.appendChild(btn);

            // Passive (this never calls preventDefault, so the browser need not
            // wait on us to scroll) and coalesced to one classList write per
            // frame — scroll fires far more often than the page can paint.
            let scrollTicking = false;
            window.addEventListener('scroll', function() {
                if (scrollTicking) return;
                scrollTicking = true;
                requestAnimationFrame(function() {
                    scrollTicking = false;
                    btn.classList.toggle('visible', window.scrollY > 400);
                });
            }, { passive: true });
            btn.addEventListener('click', function() {
                window.scrollTo({ top: 0, behavior: scrollBehavior() });
            });
        })();

        // Migration checklist — toggle items and persist in localStorage
        (function() {
            let STORAGE_KEY = SOURCE.storage.checklist;
            let list = document.getElementById('migrationChecklist');
            if (!list) return;
            let items = list.querySelectorAll('li');

            function loadState() {
                try {
                    let raw = localStorage.getItem(STORAGE_KEY);
                    return raw ? JSON.parse(raw) : {};
                } catch (e) { return {}; }
            }

            function saveState(state) {
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
                catch (e) { /* quota or private browsing */ }
            }

            // Stable per-item keys (data-id) so editing the checklist between
            // releases doesn't shift saved checkmarks onto the wrong items.
            function keyFor(li, index) {
                return li.getAttribute('data-id') || String(index);
            }

            let progressEl = document.getElementById('checklistProgress');
            function updateProgress() {
                if (!progressEl) return;
                let done = list.querySelectorAll('li.checked').length;
                progressEl.textContent = done + ' of ' + items.length + ' complete';
            }

            function toggle(li, index) {
                let state = loadState();
                let isChecked = li.classList.toggle('checked');
                li.setAttribute('aria-checked', isChecked ? 'true' : 'false');
                let k = keyFor(li, index);
                if (isChecked) { state[k] = true; } else { delete state[k]; }
                saveState(state);
                updateProgress();
            }

            // Restore saved state
            let state = loadState();
            for (let i = 0; i < items.length; i++) {
                if (state[keyFor(items[i], i)]) {
                    items[i].classList.add('checked');
                    items[i].setAttribute('aria-checked', 'true');
                }
            }
            updateProgress();

            let resetBtn = document.getElementById('checklistReset');
            if (resetBtn) {
                resetBtn.addEventListener('click', function() {
                    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* storage blocked */ }
                    for (let i = 0; i < items.length; i++) {
                        items[i].classList.remove('checked');
                        items[i].setAttribute('aria-checked', 'false');
                    }
                    updateProgress();
                    announce('Checklist reset');
                });
            }

            // Click and keyboard handlers
            list.addEventListener('click', function(e) {
                let li = e.target.closest('li');
                if (!li) return;
                toggle(li, Array.prototype.indexOf.call(items, li));
            });
            list.addEventListener('keydown', function(e) {
                if (e.key !== ' ' && e.key !== 'Enter') return;
                let li = e.target.closest('li');
                if (!li) return;
                e.preventDefault();
                toggle(li, Array.prototype.indexOf.call(items, li));
            });
        })();

        // Collapsible end-of-maintenance warning — the same banner repeats at the
        // top of all three tool pages, so remember the reader's choice and show a
        // one-line version instead of pushing them past two paragraphs every visit.
        (function() {
            let KEY = SOURCE.storage.eolCollapsed;
            let banners = document.querySelectorAll('.eol-warning');
            if (!banners.length || !SOURCE.eolCompact) return;
            function readCollapsed() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
            function writeCollapsed(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* storage blocked */ } }
            let pairs = [];
            function apply(collapsed) {
                pairs.forEach(function(pair) {
                    pair.banner.style.display = collapsed ? 'none' : '';
                    pair.compact.style.display = collapsed ? '' : 'none';
                });
            }
            banners.forEach(function(banner) {
                let hideBtn = document.createElement('button');
                hideBtn.type = 'button';
                hideBtn.className = 'eol-toggle';
                hideBtn.textContent = 'Hide';
                hideBtn.setAttribute('aria-label', 'Collapse the end-of-maintenance warning');
                banner.appendChild(document.createTextNode(' '));
                banner.appendChild(hideBtn);

                let compact = document.createElement('div');
                compact.className = 'info-box warning eol-compact';
                compact.style.display = 'none';
                let strong = document.createElement('strong');
                strong.textContent = SOURCE.eolCompact.strongText;
                compact.appendChild(strong);
                compact.appendChild(document.createTextNode(SOURCE.eolCompact.restText));
                let showBtn = document.createElement('button');
                showBtn.type = 'button';
                showBtn.className = 'eol-toggle';
                showBtn.textContent = 'Details';
                showBtn.setAttribute('aria-label', 'Expand the end-of-maintenance warning');
                compact.appendChild(showBtn);
                banner.parentNode.insertBefore(compact, banner.nextSibling);
                pairs.push({ banner: banner, compact: compact });

                // Hand keyboard focus to the counterpart control so it doesn't
                // drop to <body> when the focused button's container hides.
                hideBtn.addEventListener('click', function() { writeCollapsed(true); apply(true); showBtn.focus(); });
                showBtn.addEventListener('click', function() { writeCollapsed(false); apply(false); hideBtn.focus(); });
            });
            if (readCollapsed()) apply(true);
        })();

    })();
