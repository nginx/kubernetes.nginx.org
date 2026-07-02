    /* migration-core.js — the source-agnostic engine behind the migration tool
       pages: YAML analyzer orchestration + rendering, reference-table filtering,
       page navigation, checklist persistence, and the shared MigrationTool.NIC
       target-version constants. Everything source-specific (mapping data,
       parsers, generators, strings) lives in the page's SOURCE module
       (e.g. migration-ingress-nginx.js), which defines
       window.MIGRATION_SOURCE and must load BEFORE this file:
       shared.js → migration-<source>.js → migration-core.js.
       Shared chrome (dark mode, sidebar drawer, copy-to-clipboard, copyright
       year) lives in shared.js, which loads first and exposes those globals. */
    (function() {
        'use strict';
        // Single source of truth for the F5 NGINX Ingress Controller (the migration
        // TARGET) versions the tool pages are documented against. Bump these when
        // updating the Version Reference (see the release checklist in CLAUDE.md;
        // also update the version pills/install URLs in index.html). The source
        // controller's version lives at the top of its migration-<source>.js.
        const NIC = {
            VERSION: 'v5.5.1',
            HELM_VERSION: '2.6.1'
        };
        NIC.CRD_INSTALL_CMD = 'kubectl apply -f https://raw.githubusercontent.com/nginx/kubernetes-ingress/' + NIC.VERSION + '/deploy/crds.yaml';
        NIC.HELM_INSTALL_CMD = 'helm install nginx-ingress oci://ghcr.io/nginx/charts/nginx-ingress --version ' + NIC.HELM_VERSION + ' --set controller.enableCustomResources=true';
        NIC.RELEASE_URL = 'https://github.com/nginx/kubernetes-ingress/releases/tag/' + NIC.VERSION;

        // Strip a trailing inline "# comment" from a YAML scalar, honoring quotes
        // (a '#' only begins a comment at the start of the value or after whitespace).
        function stripInlineComment(s) {
            let inSingle = false, inDouble = false;
            for (let k = 0; k < s.length; k++) {
                let c = s[k];
                if (c === '"' && !inSingle) inDouble = !inDouble;
                else if (c === "'" && !inDouble) inSingle = !inSingle;
                else if (c === '#' && !inSingle && !inDouble && (k === 0 || /\s/.test(s[k - 1]))) {
                    return s.slice(0, k);
                }
            }
            return s;
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

        // Normalize CRLF/CR and split a manifest into YAML documents.
        function splitDocuments(yamlText) {
            return yamlText.replace(/\r\n?/g, '\n').split(/^---\s*$/m);
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

        // Inject "  # <source-name>" comments into generated YAML so each line can be
        // traced back to the finding it came from. Two passes: value-based matching,
        // then field-name matching for whatever is still unmatched.
        function annotateYamlWithSources(yaml, foundAnnotations) {
            let crdYamlLines = yaml.split('\n');
            let usedAnnotations = {};
            // First pass: value-based matching
            let annotatedLines = crdYamlLines.map(function(line) {
                // Skip comment lines and top-level structural keys
                if (/^\s*#/.test(line) || /^(apiVersion|kind|metadata|spec):/.test(line.trim())) return line;
                // Skip metadata name (shallow indent ≤4 spaces)
                let nameCheck = line.match(/^(\s+)name:\s/);
                if (nameCheck && nameCheck[1].length <= 4) return line;
                // Extract value from "key: value" lines
                let kvMatch = line.match(/^(\s+\S+:\s*)(.+)$/);
                if (!kvMatch) return line;
                let lineVal = kvMatch[2].replace(/^["']|["']$/g, '').trim();
                let matched = null;
                foundAnnotations.forEach(function(a) {
                    if (matched) return;
                    if (usedAnnotations[a.annotation]) return;
                    let v = a.value != null ? String(a.value) : '';
                    let cleaned = v.replace(/^[^/]+\//, '');
                    if (lineVal && (lineVal === v || lineVal === cleaned || v.indexOf(lineVal) !== -1 || lineVal.indexOf(cleaned) !== -1)) {
                        matched = a.annotation;
                    }
                    // Boolean transforms: on/off → true/false
                    if (!matched && ((v === 'on' && lineVal === 'true') || (v === 'off' && lineVal === 'false'))) {
                        matched = a.annotation;
                    }
                });
                if (matched) {
                    usedAnnotations[matched] = true;
                    return line + '  # ' + matched;
                }
                return line;
            });
            // Second pass: field-name matching for remaining unmatched annotations
            let unmatched = foundAnnotations.filter(function(a) { return !usedAnnotations[a.annotation]; });
            if (unmatched.length > 0) {
                annotatedLines = annotatedLines.map(function(line) {
                    if (/  # \S/.test(line)) return line;
                    if (/^\s*#/.test(line) || /^(apiVersion|kind|metadata|spec):/.test(line.trim())) return line;
                    let nameCheck = line.match(/^(\s+)name:\s/);
                    if (nameCheck && nameCheck[1].length <= 4) return line;
                    let keyMatch = line.match(/^\s+(\S+):/);
                    if (!keyMatch) return line;
                    // Normalize camelCase to hyphenated: sessionCookie → session-cookie
                    let fieldKey = keyMatch[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
                    let matched = null;
                    unmatched.forEach(function(a) {
                        if (matched) return;
                        if (usedAnnotations[a.annotation]) return;
                        let parts = a.annotation.toLowerCase().split('-');
                        let last1 = parts[parts.length - 1];
                        let last2 = parts.length >= 2 ? parts.slice(-2).join('-') : '';
                        // Match last segment (min 3 chars) or last two segments against field key
                        if ((last1.length > 2 && fieldKey === last1) || (last2 && fieldKey === last2)) {
                            matched = a.annotation;
                        }
                        // For key-only lines, check if annotation value appears in field name
                        if (!matched && /:\s*$/.test(line)) {
                            let v = a.value != null ? String(a.value).toLowerCase() : '';
                            if (v.length > 3 && fieldKey.indexOf(v) !== -1) {
                                matched = a.annotation;
                            }
                        }
                    });
                    if (matched) {
                        usedAnnotations[matched] = true;
                        return line + '  # ' + matched;
                    }
                    return line;
                });
            }
            return annotatedLines.join('\n');
        }

        // Shared utilities the SOURCE modules call (call-time only — they load first).
        window.MigrationTool = {
            NIC: NIC,
            util: {
                splitDocuments: splitDocuments,
                stripInlineComment: stripInlineComment,
                sanitizeSnippetValue: sanitizeSnippetValue,
                formatYamlKV: formatYamlKV,
                detectGenericSyntaxWarnings: detectGenericSyntaxWarnings,
                annotateYamlWithSources: annotateYamlWithSources
            }
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
            document.querySelectorAll('[data-filter-source]').forEach(function(el) {
                let evt = el.tagName === 'SELECT' ? 'change' : 'input';
                el.addEventListener(evt, function() {
                    filterTable(el.getAttribute('data-filter-source'));
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
                let container = tabList.closest('.example-content');
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
            // Add copy buttons to comparison blocks
            document.querySelectorAll('.comparison-block').forEach(function(block) {
                let h5 = block.querySelector('h4');
                let pre = block.querySelector('pre');
                if (!h5 || !pre) return;
                let btn = document.createElement('button');
                btn.className = 'comparison-copy-btn';
                btn.textContent = 'Copy';
                btn.setAttribute('aria-label', 'Copy code snippet');
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    // Shared helper handles the fallback path, button feedback, and
                    // the screen-reader announcement via #page-announce.
                    copyToClipboard(pre.textContent, btn);
                });
                h5.appendChild(btn);
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

        function expandAllExamples(btn) {
            let scope = btn ? btn.closest('section') : document;
            if (!scope) scope = document;
            // Highlighting is lazy — cover the whole scope before revealing rows
            // so none of them flash as plain text while the idle queue catches up.
            highlightStaticExamples(scope);
            scope.querySelectorAll('.expandable').forEach(row => {
                row.classList.add('expanded');
                row.setAttribute('aria-expanded', 'true');
                const exampleRow = row.nextElementSibling;
                if (exampleRow && exampleRow.classList.contains('example-row')) {
                    exampleRow.classList.add('visible');
                    exampleRow.setAttribute('aria-hidden', 'false');
                }
            });
        }
        function collapseAllExamples(btn) {
            let scope = btn ? btn.closest('section') : document;
            if (!scope) scope = document;
            scope.querySelectorAll('.expandable').forEach(row => {
                row.classList.remove('expanded');
                row.setAttribute('aria-expanded', 'false');
                const exampleRow = row.nextElementSibling;
                if (exampleRow && exampleRow.classList.contains('example-row')) {
                    exampleRow.classList.remove('visible');
                    exampleRow.setAttribute('aria-hidden', 'true');
                }
            });
        }
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
            let term = primary.value.toLowerCase();
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
                // Walk back past any info-boxes sitting between the heading and the table.
                let h3 = wrapper ? wrapper.previousElementSibling : null;
                while (h3 && h3.tagName !== 'H3') h3 = h3.previousElementSibling;
                let tableCategory = (h3 && h3.id) ? h3.id : '';
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
                    let textMatch = !term || row.textContent.toLowerCase().includes(term);
                    let match = textMatch && categoryMatch;
                    row.style.display = match ? '' : 'none';
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
            });
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

        function switchApproach(btn, type) {
            const container = btn.closest('.example-content');
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
                let target = document.getElementById(anchorId);
                if (target) {
                    let y = target.getBoundingClientRect().top + window.pageYOffset - scrollOffsetFor(target);
                    window.scrollTo({ top: y, behavior: scrollBehavior() });
                }
            });
            anchor.setAttribute('aria-label', 'Permalink: ' + heading.textContent.trim());
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '16');
            svg.setAttribute('height', '16');
            svg.setAttribute('viewBox', '0 0 16 16');
            svg.setAttribute('fill', 'currentColor');
            svg.setAttribute('aria-hidden', 'true');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'm7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z');
            svg.appendChild(path);
            anchor.appendChild(svg);
            heading.appendChild(anchor);
        });

        // Respect the user's reduced-motion preference for programmatic scrolling.
        function scrollBehavior() {
            return (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth';
        }

        // Current fixed-chrome height (banner + topbar) read from the rendered layout,
        // so scroll math shares a single source of truth with the CSS --chrome-h var.
        function chromeHeight() {
            let tb = document.querySelector('.topbar');
            return tb ? Math.round(tb.getBoundingClientRect().bottom) : (document.body.classList.contains('has-banner') ? 87 : 52);
        }

        // Scroll offset for an anchor target: the fixed chrome plus, on desktop,
        // the sticky search/filter bar when the target sits below it inside a
        // mapping section (the bar would otherwise cover the scrolled-to heading).
        function scrollOffsetFor(target) {
            let offset = chromeHeight() + 12;
            let section = target.closest('section');
            let controls = section && section.querySelector('.controls');
            if (controls && window.matchMedia('(min-width: 901px)').matches &&
                (controls.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                offset += controls.offsetHeight + 4;
            }
            return offset;
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
            if (!parsed.findings || parsed.findings.length === 0) {
                resultsDiv.textContent = '';
                renderParserWarnings(resultsDiv, warnings);
                showAnalyzerMessage(resultsDiv, 'info', SOURCE.strings.noFindings.title, SOURCE.strings.noFindings.message, { append: true });
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
            // Smooth scroll to results
            setTimeout(function() {
                resultsDiv.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
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
                        // Split trailing inline comment (# preceded by space, outside quotes)
                        let commentStart = -1, inQ = false, qc = '';
                        for (let ci = 0; ci < fullVal.length; ci++) {
                            let cc = fullVal[ci];
                            if (inQ) { if (cc === qc) inQ = false; }
                            else if (cc === '"' || cc === "'") { inQ = true; qc = cc; }
                            else if (cc === '#' && ci > 0 && fullVal[ci - 1] === ' ') { commentStart = ci; break; }
                        }
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
                let fbComment = -1, fbInQ = false, fbQC = '';
                for (let fi = 0; fi < line.length; fi++) {
                    let fc = line[fi];
                    if (fbInQ) { if (fc === fbQC) fbInQ = false; }
                    else if (fc === '"' || fc === "'") { fbInQ = true; fbQC = fc; }
                    else if (fc === '#' && fi > 0 && line[fi - 1] === ' ') { fbComment = fi; break; }
                }
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

        function buildYamlBlock(text, collapsible) {
            let pre = document.createElement('div');
            pre.className = 'analyzer-yaml-output';
            let copyBtn = document.createElement('button');
            copyBtn.className = 'analyzer-copy-btn';
            copyBtn.textContent = 'Copy';
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
                expandBtn.className = 'analyzer-yaml-expand';
                expandBtn.textContent = 'Show full YAML (' + lineCount + ' lines)';
                expandBtn.addEventListener('click', function() {
                    if (pre.classList.contains('collapsed')) {
                        pre.classList.remove('collapsed');
                        expandBtn.textContent = 'Collapse';
                    } else {
                        pre.classList.add('collapsed');
                        expandBtn.textContent = 'Show full YAML (' + lineCount + ' lines)';
                    }
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

        function renderComparisonBlock(block) {
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
                sideBlock.appendChild(buildYamlBlock(pair.side.yaml, pair.side.collapsible));
                comp.appendChild(sideBlock);
            });
            return comp;
        }

        // Link to Installing CRDs section instead of showing inline command
        function renderCrdInstallNote() {
            let installNote = document.createElement('div');
            installNote.className = 'info-box note';
            installNote.style.cssText = 'margin:0 0 16px;';
            let noteStrong = document.createElement('strong');
            noteStrong.textContent = 'Note:';
            installNote.appendChild(noteStrong);
            installNote.appendChild(document.createTextNode(' These features require CRDs. See '));
            let installLink = document.createElement('a');
            installLink.href = '#installation';
            installLink.textContent = 'Installing CRDs';
            installLink.addEventListener('click', function(e) {
                e.preventDefault();
                let sidebarLink = document.querySelector('.sidebar-link[data-section="installation"]');
                if (sidebarLink) sidebarLink.click();
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
            kindBadge.className = 'badge badge-' + badgeClass;
            kindBadge.style.marginRight = '8px';
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
                catLabel.style.cssText = 'font-size:0.82rem;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
                catLabel.appendChild(document.createTextNode(item.category));
                if (item.plusRequired) {
                    let plusBadge = document.createElement('span');
                    plusBadge.className = 'plus-indicator';
                    plusBadge.textContent = 'Plus Required';
                    catLabel.appendChild(plusBadge);
                }
                if (item.dualSuffix) catLabel.appendChild(document.createTextNode(item.dualSuffix));
                groupDiv.appendChild(catLabel);
                groupDiv.appendChild(renderComparisonBlock({ old: item.old, new: item.new }));
            });
            return groupDiv;
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
                    pill.addEventListener('click', function() {
                        let el = document.getElementById(p.scrollTo);
                        if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
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
            let svgNS = 'http://www.w3.org/2000/svg';
            let checkSvg = document.createElementNS(svgNS, 'svg');
            checkSvg.setAttribute('width', '22'); checkSvg.setAttribute('height', '22');
            checkSvg.setAttribute('viewBox', '0 0 24 24'); checkSvg.setAttribute('fill', 'none');
            checkSvg.setAttribute('stroke', 'currentColor'); checkSvg.setAttribute('stroke-width', '2.5');
            let checkPath = document.createElementNS(svgNS, 'path');
            checkPath.setAttribute('d', 'M22 11.08V12a10 10 0 1 1-5.93-9.14');
            let checkLine = document.createElementNS(svgNS, 'polyline');
            checkLine.setAttribute('points', '22 4 12 14.01 9 11.01');
            checkSvg.appendChild(checkPath); checkSvg.appendChild(checkLine);
            banner.appendChild(checkSvg);
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
            let complexityLabels = { simple: 'Simple Migration', moderate: 'Moderate Migration', advanced: 'Advanced Migration' };
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
                let step = document.createElement('div');
                step.className = 'analyzer-step';
                step.id = stepData.id;
                let header = document.createElement('div');
                header.className = 'analyzer-step-header';
                let num = document.createElement('div');
                num.className = 'analyzer-step-number';
                num.textContent = String(stepNum);
                let title = document.createElement('h3');
                title.className = 'analyzer-step-title';
                title.textContent = stepData.title;
                let count = document.createElement('span');
                count.className = 'analyzer-step-count' + (stepData.countCls ? ' ' + stepData.countCls : '');
                count.textContent = stepData.countText;
                header.appendChild(num);
                header.appendChild(title);
                header.appendChild(count);
                step.appendChild(header);
                let desc = document.createElement('div');
                desc.className = 'analyzer-step-desc';
                desc.textContent = stepData.desc;
                step.appendChild(desc);

                stepData.blocks.forEach(function(block) {
                    if (block.type === 'comparison') {
                        step.appendChild(renderComparisonBlock(block));
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
                let stepInfo = document.createElement('div');
                stepInfo.className = 'analyzer-step';
                stepInfo.id = 'analyzer-info-notes';
                let hInfo = document.createElement('div');
                hInfo.className = 'analyzer-step-header';
                let nInfo = document.createElement('span');
                nInfo.className = 'analyzer-step-number';
                nInfo.textContent = 'i';
                let tInfo = document.createElement('h3');
                tInfo.className = 'analyzer-step-title';
                tInfo.textContent = 'Informational Notes';
                let cInfo = document.createElement('span');
                cInfo.className = 'analyzer-step-count';
                cInfo.textContent = plan.infoNotes.length + ' note' + (plan.infoNotes.length !== 1 ? 's' : '');
                hInfo.appendChild(nInfo);
                hInfo.appendChild(tInfo);
                hInfo.appendChild(cInfo);
                stepInfo.appendChild(hInfo);
                plan.infoNotes.forEach(function(note) {
                    let card = document.createElement('div');
                    card.className = 'info-box note';
                    card.style.cssText = 'margin: 10px 0;';
                    let annCode = document.createElement('code');
                    annCode.textContent = note.code;
                    card.appendChild(annCode);
                    let msg = document.createElement('div');
                    msg.style.cssText = 'margin-top: 6px; font-size: 0.88rem;';
                    msg.textContent = note.message;
                    card.appendChild(msg);
                    stepInfo.appendChild(card);
                });
                applyFadeIn(stepInfo);
                container.appendChild(stepInfo);
            }

            // Unsupported findings (recognized but no migration path)
            if (plan.unsupported) {
                let step4 = document.createElement('div');
                step4.className = 'analyzer-step';
                step4.id = 'analyzer-unsupported';
                let h4u = document.createElement('div');
                h4u.className = 'analyzer-step-header';
                let n4 = document.createElement('span');
                n4.className = 'analyzer-step-number warning';
                n4.textContent = '!';
                let t4 = document.createElement('h3');
                t4.className = 'analyzer-step-title';
                t4.textContent = plan.unsupported.title;
                let c4 = document.createElement('span');
                c4.className = 'analyzer-step-count unsupported';
                c4.textContent = plan.unsupported.countText;
                h4u.appendChild(n4);
                h4u.appendChild(t4);
                h4u.appendChild(c4);
                step4.appendChild(h4u);
                let d4 = document.createElement('div');
                d4.className = 'analyzer-step-desc';
                d4.textContent = plan.unsupported.desc;
                step4.appendChild(d4);

                plan.unsupported.cards.forEach(function(cardData) {
                    let card = document.createElement('div');
                    card.className = 'info-box warning';
                    card.style.cssText = 'margin: 10px 0;';
                    let title = document.createElement('strong');
                    title.textContent = cardData.title;
                    card.appendChild(title);
                    card.appendChild(document.createTextNode(' — '));
                    let annCode = document.createElement('code');
                    annCode.textContent = cardData.code;
                    card.appendChild(annCode);
                    let desc = document.createElement('div');
                    desc.style.cssText = 'margin-top: 6px; font-size: 0.88rem;';
                    desc.textContent = cardData.desc;
                    card.appendChild(desc);
                    if (cardData.anchor) {
                        let link = document.createElement('a');
                        link.href = '#' + cardData.anchor;
                        link.style.cssText = 'font-size: 0.82rem; margin-top: 4px; display: inline-block;';
                        link.textContent = 'See Reference Guide →';
                        link.addEventListener('click', function(e) {
                            e.preventDefault();
                            let sidebarLink = document.querySelector('.sidebar-link[data-section="' + cardData.sidebarSection + '"]');
                            if (sidebarLink) sidebarLink.click();
                            setTimeout(function() {
                                let target = document.getElementById(cardData.anchor);
                                if (target) { let y = target.getBoundingClientRect().top + window.pageYOffset - scrollOffsetFor(target); window.scrollTo({ top: y, behavior: scrollBehavior() }); }
                            }, 150);
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
                desc.style.fontSize = '0.9rem';
                desc.style.color = 'var(--text-secondary)';
                desc.style.marginBottom = '10px';
                desc.textContent = plan.unrecognized.desc;
                unrecSection.appendChild(desc);
                plan.unrecognized.items.forEach(function(u) {
                    let uCard = document.createElement('div');
                    uCard.className = 'analyzer-card unrecognized';
                    let uHeader = document.createElement('div');
                    uHeader.className = 'analyzer-card-header';
                    let uFound = document.createElement('div');
                    uFound.className = 'found-annotations';
                    uFound.appendChild(buildYamlBlock(u.yaml));
                    uHeader.appendChild(uFound);
                    uCard.appendChild(uHeader);
                    unrecSection.appendChild(uCard);
                });
                let contributeP = document.createElement('p');
                contributeP.style.fontSize = '0.85rem';
                contributeP.style.marginTop = '10px';
                let contributeLink = document.createElement('a');
                contributeLink.href = 'https://github.com/nginx/kubernetes.nginx.org';
                contributeLink.target = '_blank';
                contributeLink.rel = 'noopener noreferrer';
                contributeLink.style.color = 'var(--green-text)';
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
                copyAllBtn.style.marginTop = '0';
                let clipSvg = document.createElementNS(svgNS, 'svg');
                clipSvg.setAttribute('width', '18');
                clipSvg.setAttribute('height', '18');
                clipSvg.setAttribute('viewBox', '0 0 24 24');
                clipSvg.setAttribute('fill', 'none');
                clipSvg.setAttribute('stroke', 'currentColor');
                clipSvg.setAttribute('stroke-width', '2');
                let rect1 = document.createElementNS(svgNS, 'rect');
                rect1.setAttribute('x', '9'); rect1.setAttribute('y', '9');
                rect1.setAttribute('width', '13'); rect1.setAttribute('height', '13');
                rect1.setAttribute('rx', '2'); rect1.setAttribute('ry', '2');
                let path1 = document.createElementNS(svgNS, 'path');
                path1.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
                clipSvg.appendChild(rect1);
                clipSvg.appendChild(path1);
                copyAllBtn.appendChild(clipSvg);
                copyAllBtn.appendChild(document.createTextNode('Copy All Migration YAML'));
                copyAllBtn.addEventListener('click', function() {
                    function restoreLabel() {
                        copyAllBtn.textContent = '';
                        copyAllBtn.appendChild(clipSvg);
                        copyAllBtn.appendChild(document.createTextNode('Copy All Migration YAML'));
                        copyAllBtn.classList.remove('copied');
                    }
                    function onCopied() {
                        copyAllBtn.textContent = '';
                        copyAllBtn.appendChild(clipSvg);
                        copyAllBtn.appendChild(document.createTextNode('Copied!'));
                        copyAllBtn.classList.add('copied');
                        announce('Migration YAML copied to clipboard');
                        setTimeout(restoreLabel, 2000);
                    }
                    function onFailed() {
                        copyAllBtn.textContent = '';
                        copyAllBtn.appendChild(clipSvg);
                        copyAllBtn.appendChild(document.createTextNode('Copy failed'));
                        announce('Copy failed');
                        setTimeout(restoreLabel, 2000);
                    }
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(allYaml).then(onCopied).catch(function() {
                            if (fallbackCopy(allYaml)) onCopied(); else onFailed();
                        });
                    } else {
                        if (fallbackCopy(allYaml)) onCopied(); else onFailed();
                    }
                });
                exportRow.appendChild(copyAllBtn);

                // Download YAML button
                let dlBtn = document.createElement('button');
                dlBtn.className = 'analyzer-download-btn';
                let dlSvg = document.createElementNS(svgNS, 'svg');
                dlSvg.setAttribute('width', '18'); dlSvg.setAttribute('height', '18');
                dlSvg.setAttribute('viewBox', '0 0 24 24'); dlSvg.setAttribute('fill', 'none');
                dlSvg.setAttribute('stroke', 'currentColor'); dlSvg.setAttribute('stroke-width', '2');
                let dlPath1 = document.createElementNS(svgNS, 'path');
                dlPath1.setAttribute('d', 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4');
                let dlPath2 = document.createElementNS(svgNS, 'polyline');
                dlPath2.setAttribute('points', '7 10 12 15 17 10');
                let dlPath3 = document.createElementNS(svgNS, 'line');
                dlPath3.setAttribute('x1', '12'); dlPath3.setAttribute('y1', '15');
                dlPath3.setAttribute('x2', '12'); dlPath3.setAttribute('y2', '3');
                dlSvg.appendChild(dlPath1); dlSvg.appendChild(dlPath2); dlSvg.appendChild(dlPath3);
                dlBtn.appendChild(dlSvg);
                dlBtn.appendChild(document.createTextNode('Download YAML'));
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
                    let origText = dlBtn.lastChild;
                    origText.textContent = 'Downloaded!';
                    setTimeout(function() {
                        origText.textContent = 'Download YAML';
                        dlBtn.classList.remove('downloaded');
                    }, 2000);
                });
                exportRow.appendChild(dlBtn);
                container.appendChild(exportRow);
            }

            // What's Next? section
            if (plan.nextItems && plan.nextItems.length > 0) {
                let nextBox = document.createElement('div');
                nextBox.className = 'analyzer-next-steps';
                let nextH4 = document.createElement('h4');
                nextH4.textContent = "What's Next?";
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
                let editSvgNS = 'http://www.w3.org/2000/svg';
                let editSvg = document.createElementNS(editSvgNS, 'svg');
                editSvg.setAttribute('width', '16'); editSvg.setAttribute('height', '16');
                editSvg.setAttribute('viewBox', '0 0 24 24'); editSvg.setAttribute('fill', 'none');
                editSvg.setAttribute('stroke', 'currentColor'); editSvg.setAttribute('stroke-width', '2');
                let editPath = document.createElementNS(editSvgNS, 'path');
                editPath.setAttribute('d', 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7');
                let editPath2 = document.createElementNS(editSvgNS, 'path');
                editPath2.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z');
                editSvg.appendChild(editPath); editSvg.appendChild(editPath2);
                editBtn.appendChild(editSvg);
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
                if (spaceAbove > dropH + 6 && spaceBelow < dropH + 6) {
                    // Open upward
                    dropdown.style.bottom = 'calc(100% + 6px)';
                    dropdown.style.top = 'auto';
                } else {
                    // Open downward
                    dropdown.style.top = 'calc(100% + 6px)';
                    dropdown.style.bottom = 'auto';
                }
                let firstItem = dropdown.querySelector('[role="menuitem"]');
                if (firstItem) firstItem.focus();
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
            dropdown.addEventListener('keydown', function(e) {
                let items = Array.from(dropdown.querySelectorAll('[role="menuitem"]'));
                if (!items.length) return;
                let idx = items.indexOf(document.activeElement);
                let btn = document.querySelector('.sample-dropdown-btn');
                if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
                else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
                else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
                else if (e.key === 'Escape') { e.preventDefault(); dropdown.classList.remove('visible'); if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); } }
            });
        })();

        function loadSampleYaml(preset) {
            let presets = SOURCE.analyzer.samplePresets;
            let yaml = presets[preset] || presets[SOURCE.analyzer.defaultPreset];
            document.getElementById('yamlInput').value = yaml;
            document.getElementById('analyzerResults').textContent = '';
            document.getElementById('sampleDropdown').classList.remove('visible');
            let btn = document.querySelector('.sample-dropdown-btn');
            if (btn) {
                btn.setAttribute('aria-expanded', 'false');
                // Focus was on the now-hidden menu item — return it to the trigger.
                btn.focus();
            }
            updateInputStatus();
            updateYamlHighlight();
        }

        function highlightSection(anchorId) {
            let el = document.getElementById(anchorId);
            if (!el) return;
            // Switch to the correct page if needed
            let sectionLink = document.querySelector('.sidebar-link[data-section="' + anchorId + '"]');
            if (sectionLink) {
                sectionLink.click();
            } else {
                // Fallback: check which page contains the element
                let page = el.closest('.tool-page');
                if (page && !page.classList.contains('active')) {
                    let pageId = page.id.replace('page-', '');
                    let pageBtn = document.querySelector('.sidebar-link[data-page="' + pageId + '"]');
                    if (pageBtn) pageBtn.click();
                }
            }
            requestAnimationFrame(function() {
                el.scrollIntoView({ behavior: scrollBehavior() });
                el.style.transition = 'background-color 0.3s';
                el.style.backgroundColor = document.documentElement.classList.contains('dark-mode') ? 'rgba(255,249,196,0.1)' : '#fff9c4';
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
            let svgNS = 'http://www.w3.org/2000/svg';
            let svg = document.createElementNS(svgNS, 'svg');
            svg.setAttribute('width', '48'); svg.setAttribute('height', '48');
            svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', '#999'); svg.setAttribute('stroke-width', '1.5');
            let path1 = document.createElementNS(svgNS, 'path');
            path1.setAttribute('d', 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z');
            let polyline = document.createElementNS(svgNS, 'polyline');
            polyline.setAttribute('points', '14 2 14 8 20 8');
            let line1 = document.createElementNS(svgNS, 'line');
            line1.setAttribute('x1', '16'); line1.setAttribute('y1', '13');
            line1.setAttribute('x2', '8'); line1.setAttribute('y2', '13');
            let line2 = document.createElementNS(svgNS, 'line');
            line2.setAttribute('x1', '16'); line2.setAttribute('y1', '17');
            line2.setAttribute('x2', '8'); line2.setAttribute('y2', '17');
            svg.appendChild(path1); svg.appendChild(polyline);
            svg.appendChild(line1); svg.appendChild(line2);
            empty.appendChild(svg);
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

        let yamlInputEl = document.getElementById('yamlInput');
        yamlInputEl.addEventListener('input', function() { updateInputStatus(); updateYamlHighlight(); });
        yamlInputEl.addEventListener('scroll', syncEditorScroll);

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
                updateInputStatus();
                updateYamlHighlight();
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

            function showPage(id, opts) {
                opts = opts || {};
                let switching = (id !== currentPage);
                currentPage = id;

                // Toggle tool-page visibility — inactive pages are hidden="until-found"
                // (not display:none) so browser find-in-page can search their content.
                document.querySelectorAll('.tool-page').forEach(function(p) { p.classList.remove('active'); p.setAttribute('hidden', 'until-found'); });
                let page = document.getElementById('page-' + id);
                if (page) { page.removeAttribute('hidden'); page.classList.add('active'); }

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
                let pageNames = SOURCE.strings.pageNames;
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

            // Page link click handlers
            pageLinks.forEach(function(link) {
                link.addEventListener('click', function() {
                    showPage(this.getAttribute('data-page'));
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

                    function scrollToSection() {
                        let target = document.getElementById(sectionId);
                        if (target) {
                            let y = target.getBoundingClientRect().top + window.pageYOffset - scrollOffsetFor(target);
                            window.scrollTo({ top: y, behavior: scrollBehavior() });
                        }
                    }

                    if (wasOnTargetPage) {
                        // Already on the page — scroll immediately
                        scrollToSection();
                    } else {
                        // Just switched pages — need a frame for layout, then jump (no smooth) to section
                        requestAnimationFrame(function() {
                            let target = document.getElementById(sectionId);
                            if (target) {
                                let y = target.getBoundingClientRect().top + window.pageYOffset - scrollOffsetFor(target);
                                window.scrollTo({ top: y });
                            }
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
                }, { rootMargin: '-' + chromeHeight() + 'px 0px -60% 0px', threshold: 0 });
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
                    // the fixed chrome.
                    let target = document.getElementById(hash);
                    let owner = target && target.closest('.tool-page');
                    if (target && owner) {
                        if (!owner.classList.contains('active')) {
                            showPage(owner.id.replace('page-', ''), { updateHash: false, skipScroll: true });
                        }
                        requestAnimationFrame(function() {
                            let y = target.getBoundingClientRect().top + window.pageYOffset - scrollOffsetFor(target);
                            window.scrollTo({ top: y });
                        });
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
            let svgNS = 'http://www.w3.org/2000/svg';
            let svg = document.createElementNS(svgNS, 'svg');
            svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
            svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.5');
            svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
            let polyline = document.createElementNS(svgNS, 'polyline');
            polyline.setAttribute('points', '18 15 12 9 6 15');
            svg.appendChild(polyline);
            btn.appendChild(svg);
            document.body.appendChild(btn);

            window.addEventListener('scroll', function() {
                if (window.scrollY > 400) {
                    btn.classList.add('visible');
                } else {
                    btn.classList.remove('visible');
                }
            });
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
