    /* migration.js — behavior specific to the migration tool (ingress-nginx-migration.html):
       YAML config analyzer, annotation mappings, reference tables, checklist.
       Shared chrome (dark mode, sidebar drawer, copy-to-clipboard, copyright
       year) lives in shared.js, which loads first and exposes those globals.
       NIC_VERSION / INGRESS_NGINX_VERSION below are the single source of truth
       for the Version Reference banners and install commands. */
    (function() {
        'use strict';
        // Single source of truth for the controller versions this tool is documented against.
        // Bump these when updating the Version Reference (and also update the version pills/install URLs in index.html).
        const NIC_VERSION = 'v5.5.1';
        const INGRESS_NGINX_VERSION = 'v1.15.1';
        const NIC_HELM_VERSION = '2.6.1';
        const NIC_CRD_INSTALL_CMD = 'kubectl apply -f https://raw.githubusercontent.com/nginx/kubernetes-ingress/' + NIC_VERSION + '/deploy/crds.yaml';
        const NIC_HELM_INSTALL_CMD = 'helm install nginx-ingress oci://ghcr.io/nginx/charts/nginx-ingress --version ' + NIC_HELM_VERSION + ' --set controller.enableCustomResources=true';
        const NIC_RELEASE_URL = 'https://github.com/nginx/kubernetes-ingress/releases/tag/' + NIC_VERSION;
        const INGRESS_NGINX_RELEASE_URL = 'https://github.com/kubernetes/ingress-nginx/releases/tag/controller-' + INGRESS_NGINX_VERSION;

        function toggleRow(row) {
            const exampleRow = row.nextElementSibling;
            if (exampleRow && exampleRow.classList.contains('example-row')) {
                row.classList.toggle('expanded');
                exampleRow.classList.toggle('visible');
                let isExpanded = row.classList.contains('expanded');
                row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
                exampleRow.setAttribute('aria-hidden', isExpanded ? 'false' : 'true');
            }
        }

        // Add keyboard accessibility to expandable rows and approach tabs
        document.addEventListener('DOMContentLoaded', function() {
            // Populate version-reference markers from the single source of truth (NIC_VERSION / INGRESS_NGINX_VERSION)
            document.querySelectorAll('[data-nic-version]').forEach(function(el) { el.textContent = NIC_VERSION; });
            document.querySelectorAll('[data-ingress-nginx-version]').forEach(function(el) { el.textContent = INGRESS_NGINX_VERSION; });
            document.querySelectorAll('[data-nic-release-link]').forEach(function(el) { el.href = NIC_RELEASE_URL; });
            document.querySelectorAll('[data-ingress-nginx-release-link]').forEach(function(el) { el.href = INGRESS_NGINX_RELEASE_URL; });
            document.querySelectorAll('[data-nic-crd-install]').forEach(function(el) { el.textContent = NIC_CRD_INSTALL_CMD; });
            document.querySelectorAll('[data-nic-helm-install]').forEach(function(el) { el.textContent = NIC_HELM_INSTALL_CMD; });

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
            populateCategoryFilter('categoryFilter', 'mappings');
            populateCategoryFilter('categoryFilterPlus', 'plus-mappings');
            populateCategoryFilter('categoryFilterConfigMap', 'configmap-mappings');

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
                    let code = pre.textContent;
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(code).then(function() {
                            btn.textContent = 'Copied!';
                            btn.classList.add('copied');
                            setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
                        }).catch(function() {
                            btn.textContent = 'Failed';
                            setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
                        });
                    } else {
                        let textarea = document.createElement('textarea');
                        textarea.value = code;
                        textarea.style.position = 'fixed';
                        textarea.style.opacity = '0';
                        document.body.appendChild(textarea);
                        textarea.select();
                        try {
                            document.execCommand('copy');
                            btn.textContent = 'Copied!';
                            btn.classList.add('copied');
                        } catch (err) {
                            btn.textContent = 'Failed';
                        } finally {
                            document.body.removeChild(textarea);
                        }
                        setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
                    }
                });
                h5.appendChild(btn);
            });
            // Syntax-highlight all static YAML examples
            highlightStaticExamples();
        });

        // Applies the existing highlightYaml() DOM-based highlighter to all static pre>code blocks
        function highlightStaticExamples(root) {
            (root || document).querySelectorAll('pre > code').forEach(function(block) {
                if (block.dataset.highlighted) return;
                try {
                    let text = block.textContent;
                    let frag = highlightYaml(text);
                    block.textContent = '';
                    block.appendChild(frag);
                    block.dataset.highlighted = '1';
                } catch (e) { /* skip block on error */ }
            });
        }

        function expandAllExamples(btn) {
            let scope = btn ? btn.closest('section') : document;
            if (!scope) scope = document;
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
        let _migrationStrategy = 'crd'; // 'annotation' or 'crd'

        function setStrategy(strategy, btn) {
            _migrationStrategy = strategy;
            document.querySelectorAll('.strategy-option').forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');
            let desc = document.getElementById('strategyDesc');
            if (desc) {
                desc.textContent = strategy === 'annotation'
                    ? 'Swap annotations where possible, use CRDs only when needed'
                    : 'Prefer Policy CRDs and VirtualServer, fall back to annotations when no CRD path exists';
            }
        }
        function filterTable(source) {
            let ossInput = document.getElementById('searchInput');
            let plusInput = document.getElementById('searchInputPlus');
            let cmInput = document.getElementById('searchInputConfigMap');
            let catFilter = document.getElementById('categoryFilter');
            let catFilterPlus = document.getElementById('categoryFilterPlus');
            let catFilterCM = document.getElementById('categoryFilterConfigMap');
            if (!ossInput) return;
            // Sync search inputs (but not category filters — each section has its own).
            // Whichever input the user typed in becomes the canonical value, then mirror to the others.
            if (source === 'plus' && plusInput) ossInput.value = plusInput.value;
            else if (source === 'configmap' && cmInput) ossInput.value = cmInput.value;
            if (plusInput) plusInput.value = ossInput.value;
            if (cmInput) cmInput.value = ossInput.value;
            let term = ossInput.value.toLowerCase();
            let categoryOss = catFilter ? catFilter.value : '';
            let categoryPlus = catFilterPlus ? catFilterPlus.value : '';
            let categoryCM = catFilterCM ? catFilterCM.value : '';
            let anyCategory = categoryOss || categoryPlus || categoryCM;
            // Save expanded state when filtering begins
            if ((term || anyCategory) && _savedExpanded.length === 0) {
                document.querySelectorAll('.expandable.expanded').forEach(function(r) { _savedExpanded.push(r); });
            }
            let totalVisible = 0;
            let totalRows = 0;
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
                let category = '';
                if (sectionId === 'mappings') category = categoryOss;
                else if (sectionId === 'plus-mappings') category = categoryPlus;
                else if (sectionId === 'configmap-mappings') category = categoryCM;
                let categoryMatch = !category || tableCategory === category;
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
                    totalRows++;
                    let textMatch = !term || row.textContent.toLowerCase().includes(term);
                    let match = textMatch && categoryMatch;
                    row.style.display = match ? '' : 'none';
                    if (match) visibleCount++;
                });
                totalVisible += visibleCount;
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
            // Update result count displays
            let countText = '';
            let noResults = false;
            if (term) {
                countText = totalVisible + ' of ' + totalRows + ' rows';
                noResults = totalVisible === 0;
            }
            let countEl = document.getElementById('searchCount');
            let countElPlus = document.getElementById('searchCountPlus');
            let countElCM = document.getElementById('searchCountConfigMap');
            if (countEl) { countEl.textContent = countText; countEl.className = 'search-count' + (noResults ? ' no-results' : ''); }
            if (countElPlus) { countElPlus.textContent = countText; countElPlus.className = 'search-count' + (noResults ? ' no-results' : ''); }
            if (countElCM) { countElCM.textContent = countText; countElCM.className = 'search-count' + (noResults ? ' no-results' : ''); }
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
                    let y = target.getBoundingClientRect().top + window.pageYOffset - 64;
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

        // --- YAML Migration Analyzer ---
        const ANNOTATION_MAPPINGS = [
            // Access Control
            { community: ["denylist-source-range", "whitelist-source-range"], nic: "Policy CRD accessControl (+ nginx.org/policies annotation for Ingress)", type: "policy", category: "Access Control", anchor: "access-control", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateAccessControlPolicy" } },
            { community: ["satisfy"], nic: "Annotation nginx.org/location-snippets (satisfy directive)", type: "annotation", category: "Access Control", anchor: "access-control", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "satisfy": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "satisfy ${value};" } } } },
            // Authentication (Basic)
            { community: ["auth-realm", "auth-secret", "auth-secret-type", "auth-type"], nic: "Annotation nginx.org/basic-auth-secret, nginx.org/basic-auth-realm or Policy CRD basicAuth", type: "policy", category: "Authentication (Basic)", anchor: "authentication-basic", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "auth-secret": { key: "nginx.org/basic-auth-secret", transform: "direct" }, "auth-realm": { key: "nginx.org/basic-auth-realm", transform: "direct" } }, crdKind: "Policy", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateBasicAuthPolicy" } },
            // Buffering
            { community: ["client-body-buffer-size"], nic: "nginx.org/client-body-buffer-size — or — VirtualServer CRD upstreams[].client-body-buffer-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "client-body-buffer-size": { key: "nginx.org/client-body-buffer-size", transform: "direct" } } } },
            { community: ["proxy-body-size"], nic: "nginx.org/client-max-body-size — or — VirtualServer CRD upstreams[].client-max-body-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-body-size": { key: "nginx.org/client-max-body-size", transform: "direct" } } } },
            { community: ["proxy-buffer-size"], nic: "nginx.org/proxy-buffer-size — or — VirtualServer CRD upstreams[].buffer-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-buffer-size": { key: "nginx.org/proxy-buffer-size", transform: "direct" } } } },
            { community: ["proxy-buffering"], nic: "nginx.org/proxy-buffering — or — VirtualServer CRD upstreams[].buffering", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-buffering": { key: "nginx.org/proxy-buffering", transform: "direct" } } } },
            { community: ["proxy-buffers-number"], nic: "nginx.org/proxy-buffers — or — VirtualServer CRD upstreams[].buffers", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-buffers-number": { key: "nginx.org/proxy-buffers", transform: "appendBufferSize" } } } },
            { community: ["proxy-busy-buffers-size"], nic: "nginx.org/proxy-busy-buffers-size — or — VirtualServer CRD upstreams[].busy-buffers-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-busy-buffers-size": { key: "nginx.org/proxy-busy-buffers-size", transform: "direct" } } } },
            { community: ["proxy-max-temp-file-size"], nic: "Annotation nginx.org/proxy-max-temp-file-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-max-temp-file-size": { key: "nginx.org/proxy-max-temp-file-size", transform: "direct" } } } },
            { community: ["proxy-request-buffering"], nic: "Annotation nginx.org/location-snippets (proxy_request_buffering directive)", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-request-buffering": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_request_buffering ${value};" } } } },
            // Canary / Traffic Splitting
            { community: ["canary", "canary-by-cookie", "canary-by-header", "canary-by-header-pattern", "canary-by-header-value", "canary-weight", "canary-weight-total"], nic: "VirtualServer CRD splits[], matches[]", type: "virtualserver", category: "Canary / Traffic Splitting", anchor: "canary-traffic-splitting", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateCanaryVirtualServer" } },
            { community: ["affinity-canary-behavior"], nic: "VirtualServer CRD matches[] + upstreams[].sessionCookie", type: "virtualserver", category: "Session Affinity / Sticky Sessions", anchor: "session-affinity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD } },
            // Configuration Snippets
            { community: ["configuration-snippet"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "Configuration Snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "configuration-snippet": { key: "nginx.org/location-snippets", transform: "direct" } } } },
            { community: ["server-snippet"], nic: "Annotation nginx.org/server-snippets", type: "annotation", category: "Configuration Snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "server-snippet": { key: "nginx.org/server-snippets", transform: "direct" } } } },
            { community: ["stream-snippet"], nic: "GlobalConfiguration CRD + TransportServer CRD", type: "transportserver", category: "Configuration Snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "TransportServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateStreamSnippetTS" } },
            // CORS
            { community: ["cors-allow-credentials", "cors-allow-headers", "cors-allow-methods", "cors-allow-origin", "cors-expose-headers", "cors-max-age", "enable-cors"], nic: "Policy CRD cors (+ nginx.org/policies annotation) — or — Annotation snippets — or — VirtualServer CRD responseHeaders", type: "policy", category: "CORS / Header Manipulation", anchor: "cors", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "enable-cors": { key: "nginx.org/server-snippets", transform: "corsSnippet" } }, crdKind: "Policy", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateCORSPolicy" } },
            // Error Handling
            { community: ["custom-http-errors", "default-backend"], nic: "VirtualServer CRD errorPages[]", type: "virtualserver", category: "Error Handling", anchor: "error-handling", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateErrorPagesVirtualServer" } },
            // Headers
            { community: ["connection-proxy-header"], nic: "Snippets — or — VirtualServer CRD requestHeaders.set", type: "configmap", category: "Headers", anchor: "headers", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "connection-proxy-header": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_set_header Connection \"${value}\";" } } } },
            { community: ["custom-headers"], nic: "VirtualServer CRD responseHeaders.add", type: "virtualserver", category: "Headers", anchor: "headers", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateCustomHeadersVS" } },
            // proxy-hide-headers & proxy-pass-headers: F5 NGINX Ingress Controller-only annotations (nginx.org/) — no community equivalent
            { community: ["upstream-vhost", "x-forwarded-prefix"], nic: "VirtualServer CRD requestHeaders.set", type: "virtualserver", category: "Headers", anchor: "headers", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateRequestHeadersVS" } },
            // Load Balancing
            { community: ["load-balance"], nic: "nginx.org/lb-method — or — VirtualServer CRD upstreams[].lb-method", type: "annotation", category: "Load Balancing", anchor: "load-balancing", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "load-balance": { key: "nginx.org/lb-method", transform: "lbMethod" } } } },
            { community: ["service-upstream"], nic: "nginx.org/use-cluster-ip — or — VirtualServer CRD upstreams[].use-cluster-ip", type: "annotation", category: "Load Balancing", anchor: "load-balancing", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "service-upstream": { key: "nginx.org/use-cluster-ip", transform: "direct" } } } },
            { community: ["upstream-hash-by", "upstream-hash-by-subset", "upstream-hash-by-subset-size"], nic: "nginx.org/lb-method — or — VirtualServer CRD upstreams[].lb-method", type: "virtualserver", category: "Load Balancing", anchor: "load-balancing", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "upstream-hash-by": { key: "nginx.org/lb-method", transform: "snippetWrap", template: "hash ${value} consistent" } }, crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateHashLBVirtualServer" } },
            // mTLS (Client)
            { community: ["auth-tls-error-page", "auth-tls-pass-certificate-to-upstream", "auth-tls-secret", "auth-tls-verify-client", "auth-tls-verify-depth"], nic: "Policy CRD ingressMTLS + snippets", type: "policy", category: "mTLS (Client Certificate Verification)", anchor: "mtls-client", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateIngressMTLSPolicy" } },
            { community: ["auth-tls-match-cn"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "mTLS (Client Certificate Verification)", anchor: "mtls-client", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "auth-tls-match-cn": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "if ($ssl_client_s_dn !~ \"${value}\") { return 403; }" } } } },
            // mTLS (Backend)
            { community: ["proxy-ssl-ciphers", "proxy-ssl-name", "proxy-ssl-protocols", "proxy-ssl-secret", "proxy-ssl-server-name", "proxy-ssl-verify", "proxy-ssl-verify-depth"], nic: "Policy CRD egressMTLS", type: "policy", category: "mTLS (Backend/Egress)", anchor: "mtls-backend", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateEgressMTLSPolicy" } },
            // Logging
            { community: ["enable-access-log"], nic: "ConfigMap access-log-off", type: "configmap", category: "Logging", anchor: "logging", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { configMap: { "enable-access-log": { key: "access-log-off", transform: "booleanInvert" } } } },
            { community: ["enable-rewrite-log"], nic: "Annotation nginx.org/location-snippets (rewrite_log directive)", type: "annotation", category: "Logging", anchor: "logging", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "enable-rewrite-log": { key: "nginx.org/location-snippets", transform: "booleanOnOffSnippet", template: "rewrite_log ${value};" } } } },
            // Deprecated
            { community: ["http2-push-preload"], nic: "Not supported (HTTP/2 Server Push was removed from NGINX 1.25.1)", type: "unsupported", category: "Deprecated", anchor: "deprecated", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // server-tokens: F5 NGINX Ingress Controller-only annotation (nginx.org/server-tokens) — no community equivalent, not in YAML analyzer
            // Request Mirroring
            { community: ["mirror-host", "mirror-request-body", "mirror-target"], nic: "Annotation nginx.org/location-snippets with mirror directive", type: "annotation", category: "Request Mirroring", anchor: "mirroring", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "mirror-target": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "mirror /mirror;\nmirror_request_body on;" } } } },
            // Proxy Settings
            { community: ["proxy-http-version"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "Proxy Settings", anchor: "proxy-settings", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-http-version": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_http_version ${value};" } } } },
            // Route Delegation
            { community: ["server-alias"], nic: "VirtualServer CRD (one resource per hostname)", type: "virtualserver", category: "Route Delegation", anchor: "route-delegation", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateServerAliasVS" } },
            // OpenTelemetry
            { community: ["enable-opentelemetry"], nic: "ConfigMap otel-exporter-endpoint, otel-trace-in-http, otel-service-name", type: "configmap", category: "OpenTelemetry", anchor: "opentelemetry", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { configMap: { "enable-opentelemetry": { key: "otel-trace-in-http", transform: "direct" } } } },
            { community: ["opentelemetry-trust-incoming-span"], nic: "ConfigMap otel-exporter-endpoint, otel-trace-in-http, otel-service-name (global configuration)", type: "configmap", category: "OpenTelemetry", anchor: "opentelemetry", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { configMap: { "opentelemetry-trust-incoming-span": { key: "otel-trace-in-http", transform: "direct" } } } },
            // Proxy Settings
            { community: ["proxy-next-upstream", "proxy-next-upstream-timeout", "proxy-next-upstream-tries"], nic: "Annotations nginx.org/proxy-next-upstream* — or — VirtualServer CRD upstreams[].next-upstream*", type: "annotation", category: "Proxy Settings", anchor: "proxy-settings", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "proxy-next-upstream": { key: "nginx.org/proxy-next-upstream", transform: "direct" }, "proxy-next-upstream-timeout": { key: "nginx.org/proxy-next-upstream-timeout", transform: "direct" }, "proxy-next-upstream-tries": { key: "nginx.org/proxy-next-upstream-tries", transform: "direct" } }, crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateProxyNextUpstreamVS" } },
            // Rate Limiting
            { community: ["limit-burst-multiplier", "limit-connections", "limit-rate", "limit-rate-after", "limit-rpm", "limit-rps", "limit-whitelist"], nic: "nginx.org/limit-req-* annotations — or — Policy CRD rateLimit", type: "policy", category: "Rate Limiting", anchor: "rate-limiting", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "limit-rps": { key: "nginx.org/limit-req-rate", transform: "appendRateUnit" }, "limit-burst-multiplier": { key: "nginx.org/limit-req-burst", transform: "direct" } }, crdKind: "Policy", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateRateLimitPolicy" } },
            // Redirects
            { community: ["from-to-www-redirect", "permanent-redirect", "permanent-redirect-code", "temporal-redirect", "temporal-redirect-code"], nic: "VirtualServer CRD action.redirect", type: "virtualserver", category: "Redirects", anchor: "redirects", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateRedirectVirtualServer" } },
            // Rewrites
            { community: ["app-root", "rewrite-target", "use-regex"], nic: "nginx.org/rewrite-target, nginx.org/rewrites, nginx.org/app-root — or — VirtualServer CRD rewritePath", type: "virtualserver", category: "Rewrites", anchor: "rewrites", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "rewrite-target": { key: "nginx.org/rewrite-target", transform: "direct" }, "app-root": { key: "nginx.org/app-root", transform: "direct" } }, crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateRewriteVirtualServer" } },
            { community: ["proxy-redirect-from", "proxy-redirect-to"], nic: "Annotations nginx.org/proxy-redirect-from, nginx.org/proxy-redirect-to", type: "annotation", category: "Rewrites", anchor: "rewrites", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-redirect-from": { key: "nginx.org/proxy-redirect-from", transform: "direct" }, "proxy-redirect-to": { key: "nginx.org/proxy-redirect-to", transform: "direct" } } } },
            { community: ["proxy-cookie-domain", "proxy-cookie-path"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "Rewrites", anchor: "rewrites", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-cookie-domain": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_cookie_domain ${value};" }, "proxy-cookie-path": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_cookie_path ${value};" } } } },
            // SSL/TLS
            { community: ["backend-protocol"], nic: "nginx.org/ssl-services or nginx.org/grpc-services — or — VirtualServer CRD upstreams[].tls.enable, upstreams[].type", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "backend-protocol": { key: "nginx.org/ssl-services", transform: "backendProtocol" } } } },
            { community: ["force-ssl-redirect"], nic: "Annotation nginx.org/redirect-to-https", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "force-ssl-redirect": { key: "nginx.org/redirect-to-https", transform: "direct" } } } },
            { community: ["ssl-ciphers"], nic: "Annotation nginx.org/ssl-ciphers", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-ciphers": { key: "nginx.org/ssl-ciphers", transform: "direct" } } } },
            { community: ["ssl-prefer-server-ciphers"], nic: "Annotation nginx.org/ssl-prefer-server-ciphers", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-prefer-server-ciphers": { key: "nginx.org/ssl-prefer-server-ciphers", transform: "direct" } } } },
            { community: ["ssl-redirect"], nic: "Annotation nginx.org/ssl-redirect (or nginx.org/redirect-to-https)", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-redirect": { key: "nginx.org/ssl-redirect", transform: "direct" } } } },
            { community: ["ssl-passthrough"], nic: "TransportServer CRD TLS_PASSTHROUGH", type: "transportserver", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "TransportServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateSSLPassthroughTransportServer" } },
            { community: ["preserve-trailing-slash"], nic: "Not needed (trailing slash preserved by default)", type: "unsupported", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // Timeouts
            { community: ["proxy-connect-timeout"], nic: "nginx.org/proxy-connect-timeout — or — VirtualServer CRD upstreams[].connect-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-connect-timeout": { key: "nginx.org/proxy-connect-timeout", transform: "appendTimeUnit" } } } },
            { community: ["proxy-read-timeout"], nic: "nginx.org/proxy-read-timeout — or — VirtualServer CRD upstreams[].read-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-read-timeout": { key: "nginx.org/proxy-read-timeout", transform: "appendTimeUnit" } } } },
            { community: ["proxy-send-timeout"], nic: "nginx.org/proxy-send-timeout — or — VirtualServer CRD upstreams[].send-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-send-timeout": { key: "nginx.org/proxy-send-timeout", transform: "appendTimeUnit" } } } },
            // Authentication (External): generic auth_request → externalAuth Policy (OSS, recommended).
            // Native OIDC (Plus) is documented as an alternative in the OIDC Authentication section.
            { community: ["auth-cache-duration", "auth-cache-key", "auth-method", "auth-proxy-set-headers", "auth-request-redirect", "auth-response-headers", "auth-signin", "auth-signin-redirect-param", "auth-snippet", "auth-url"], nic: "Policy CRD externalAuth (+ nginx.org/policies annotation)", type: "policy", category: "Authentication (External)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateExternalAuthPolicy" } },
            { community: ["auth-keepalive", "auth-keepalive-requests", "auth-keepalive-share-vars", "auth-keepalive-timeout"], nic: "Annotation nginx.org/location-snippets (auth_request directives)", type: "annotation", category: "Authentication (External)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "auth-keepalive": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "# auth-keepalive not directly supported; use auth_request directives" } } } },
            { community: ["auth-always-set-cookie"], nic: "Annotation nginx.org/location-snippets (auth_request_set directive)", type: "annotation", category: "Authentication (External)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "auth-always-set-cookie": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "auth_request_set $auth_cookie $upstream_http_set_cookie;\nadd_header Set-Cookie $auth_cookie;" } } } },
            { community: ["enable-global-auth"], nic: "Not applicable (F5 NGINX Ingress Controller has no global external auth)", type: "unsupported", category: "Authentication (External)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // Session Affinity (OSS + Plus)
            { community: ["affinity", "affinity-mode", "session-cookie-change-on-failure", "session-cookie-conditional-samesite-none", "session-cookie-domain", "session-cookie-expires", "session-cookie-max-age", "session-cookie-name", "session-cookie-path", "session-cookie-samesite", "session-cookie-secure"], nic: "VirtualServer CRD sessionCookie", type: "virtualserver", category: "Session Affinity / Sticky Sessions", anchor: "session-affinity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: NIC_CRD_INSTALL_CMD, templateFn: "generateSessionAffinityVS" } },
            // Plus: WAF
            // ModSecurity / WAF — no OSS replacement; Plus users can use F5 WAF for NGINX
            { community: ["enable-modsecurity", "enable-owasp-core-rules", "modsecurity-snippet", "modsecurity-transaction-id"], nic: "No direct replacement (OSS) — F5 WAF for NGINX available with Plus", type: "unsupported", category: "ModSecurity / WAF", anchor: "modsecurity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} }
        ];

        const ANNOTATION_LOOKUP = new Map();
        ANNOTATION_MAPPINGS.forEach(function(mapping, idx) {
            mapping.community.forEach(function(name) {
                ANNOTATION_LOOKUP.set(name, idx);
            });
        });

        // Detect syntax we don't fully parse and surface it to the user, so confusing
        // "no annotations found" results have a clear cause.
        function detectUnsupportedSyntax(yamlText) {
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
            // Multiple Ingress rules/hosts — example CRDs are built from the first rule only.
            if ((yamlText.match(/^\s*-?\s*host:\s*\S/gm) || []).length > 1) {
                warnings.push({
                    title: 'Multiple hosts/rules detected',
                    message: 'The analyzer builds its example resources from the first rule only. Review the generated YAML and add the remaining hosts, paths, and services manually.'
                });
            }
            // Named service ports — the analyzer uses port 80 as a placeholder for these.
            if (/\bport:\s*name:\s*\S/.test(yamlText)) {
                warnings.push({
                    title: 'Named service port detected',
                    message: 'The analyzer uses port 80 as a placeholder for named ports. Set the correct port in the generated resources.'
                });
            }
            return warnings;
        }

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

        function parseYamlAnnotations(yamlText) {
            let results = [];
            // Normalize CRLF/CR so line-by-line parsing never trips on a trailing \r.
            yamlText = yamlText.replace(/\r\n?/g, '\n');
            let docs = yamlText.split(/^---\s*$/m);
            docs.forEach(function(doc, docIndex) {
                let lines = doc.split('\n');
                let inAnnotations = false;
                let annotationIndent = -1;
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i];
                    let trimmed = line.trimStart();
                    if (trimmed.startsWith('#') || trimmed === '') continue;
                    let currentIndent = line.length - line.trimStart().length;
                    if (/^\s*annotations\s*:/.test(line)) {
                        let inlineMatch = line.match(/annotations\s*:\s*\{(.+)\}/);
                        if (inlineMatch) {
                            let pairRegex = /["']?([^"':,]+(?::\/\/[^"':,]*)*)["']?\s*:\s*["']?([^"',}]*(?:,[^"':},]*)*)["']?/g;
                            let pairMatch;
                            while ((pairMatch = pairRegex.exec(inlineMatch[1])) !== null) {
                                let key = pairMatch[1].trim().replace(/^["']|["']$/g, '');
                                let val = stripInlineComment(pairMatch[2]).trim().replace(/^["']|["']$/g, '');
                                if (key.startsWith('nginx.ingress.kubernetes.io/')) {
                                    results.push({ annotation: key.replace('nginx.ingress.kubernetes.io/', ''), value: val, docIndex: docIndex });
                                }
                            }
                            inAnnotations = false;
                            continue;
                        }
                        inAnnotations = true;
                        annotationIndent = currentIndent;
                        continue;
                    }
                    if (inAnnotations) {
                        if (currentIndent <= annotationIndent && trimmed !== '') {
                            inAnnotations = false;
                            annotationIndent = -1;
                            continue;
                        }
                        let kvMatch = trimmed.match(/^["']?([^"':]+)["']?\s*:\s*(.*)$/);
                        if (kvMatch) {
                            let key = kvMatch[1].trim().replace(/^["']|["']$/g, '');
                            let val = stripInlineComment(kvMatch[2]).trim().replace(/^["']|["']$/g, '');
                            // Handle pipe (|) and block scalar (>) multi-line values
                            if (/^[|>][+-]?\s*$/.test(val)) {
                                let blockLines = [];
                                let blockIndent = -1;
                                for (let j = i + 1; j < lines.length; j++) {
                                    let bLine = lines[j];
                                    if (bLine.trim() === '') {
                                        // Peek ahead: if next non-empty line has lower indent, end block
                                        let peek = j + 1;
                                        while (peek < lines.length && lines[peek].trim() === '') peek++;
                                        if (peek < lines.length && blockIndent !== -1) {
                                            let peekIndent = lines[peek].length - lines[peek].trimStart().length;
                                            if (peekIndent < blockIndent) break;
                                        }
                                        blockLines.push('');
                                        i = j;
                                        continue;
                                    }
                                    let bIndent = bLine.length - bLine.trimStart().length;
                                    if (blockIndent === -1) {
                                        // Block content must be more indented than the key line;
                                        // otherwise the block is empty and this is a sibling key.
                                        if (bIndent <= currentIndent) break;
                                        blockIndent = bIndent;
                                    }
                                    if (bIndent < blockIndent) break;
                                    blockLines.push(bLine.substring(blockIndent));
                                    i = j;
                                }
                                val = blockLines.join('\n').trim();
                            }
                            if (key.startsWith('nginx.ingress.kubernetes.io/')) {
                                results.push({ annotation: key.replace('nginx.ingress.kubernetes.io/', ''), value: val, docIndex: docIndex });
                            }
                        }
                    }
                }
            });
            return results;
        }

        // Translate a community annotation value to its NIC equivalent.
        // Returns either a string (the translated value) or an object
        // { value, note } when a non-trivial substitution was applied.
        function translateValue(value, transform, template) {
            if (!value && value !== '0') return value;
            switch (transform) {
                case 'direct': return value;
                case 'booleanInvert': return value === 'true' ? 'false' : value === 'false' ? 'true' : value;
                case 'appendRateUnit': return /r\/[sm]$/.test(value) ? value : value + 'r/s';
                case 'appendTimeUnit': return /[smhd]$/.test(value) ? value : value + 's';
                case 'appendBufferSize': return /\s/.test(value) ? value : value + ' 8k';
                case 'snippetWrap': return template ? template.replace('${value}', value) : value;
                case 'booleanOnOffSnippet': return template ? template.replace('${value}', value === 'true' ? 'on' : value === 'false' ? 'off' : value) : value;
                case 'backendProtocol': return value; // key selection handled in generateMigrationYaml
                case 'corsSnippet': return value; // handled specially in generateMigrationYaml
                case 'lbMethod': {
                    // NIC's nginx.org/lb-method does not support every value the
                    // community controller accepts. Map known unsupported values
                    // to the closest equivalent and surface a note.
                    let lbAliases = { 'ewma': 'least_conn', 'round_robin': 'round_robin' };
                    let trimmed = (value || '').trim();
                    if (lbAliases[trimmed] && lbAliases[trimmed] !== trimmed) {
                        return { value: lbAliases[trimmed], note: trimmed + ' is not supported, using ' + lbAliases[trimmed] + ' as the closest equivalent' };
                    }
                    return value;
                }
                default: return value;
            }
        }

        // Normalize a translateValue result into { value, note } for callers.
        function unwrapTranslated(result) {
            if (result && typeof result === 'object' && 'value' in result) {
                return { value: result.value, note: result.note || null };
            }
            return { value: result, note: null };
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

        // Extract Ingress spec fields (host, service, port, path, tls, name) from YAML text
        function parseIngressSpec(yamlText) {
            let specs = [];
            yamlText = yamlText.replace(/\r\n?/g, '\n');
            let docs = yamlText.split(/^---\s*$/m);
            docs.forEach(function(doc) {
                let spec = { host: null, serviceName: null, servicePort: null, path: null, tlsSecret: null, ingressName: null };
                let lines = doc.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i];
                    let trimmed = line.trim();
                    if (trimmed.startsWith('#') || trimmed === '') continue;
                    let indent = line.length - line.trimStart().length;
                    // Ingress name
                    if (/^\s{2}name:\s/.test(line) && indent <= 4 && !spec.ingressName) {
                        let m = trimmed.match(/^name:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.ingressName = m[1];
                    }
                    // Host from rules
                    if (/^\s+-?\s*host:\s/.test(line) && !spec.host) {
                        let m = trimmed.match(/^-?\s*host:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.host = m[1];
                    }
                    // Path
                    if (/^\s+-?\s*path:\s/.test(line) && !spec.path) {
                        let m = trimmed.match(/^-?\s*path:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.path = m[1];
                    }
                    // Service name (v1 style: backend.service.name)
                    if (/^\s+name:\s/.test(line) && indent >= 10 && !spec.serviceName) {
                        // Check context: previous non-empty lines should include service: or backend:
                        for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
                            let prev = lines[k].trim();
                            if (/^service:/.test(prev) || /^backend:/.test(prev) || /^serviceName:/.test(prev)) {
                                let m = trimmed.match(/^name:\s*["']?([^"'\s]+)["']?/);
                                if (m) spec.serviceName = m[1];
                                break;
                            }
                        }
                    }
                    // Service name (legacy style: serviceName)
                    if (/^\s+serviceName:\s/.test(line) && !spec.serviceName) {
                        let m = trimmed.match(/^serviceName:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.serviceName = m[1];
                    }
                    // Service port number
                    if (/^\s+number:\s/.test(line) && indent >= 12 && !spec.servicePort) {
                        let m = trimmed.match(/^number:\s*["']?(\d+)["']?/);
                        if (m) spec.servicePort = m[1];
                    }
                    // Service port (legacy style: servicePort)
                    if (/^\s+servicePort:\s/.test(line) && !spec.servicePort) {
                        let m = trimmed.match(/^servicePort:\s*["']?(\w+)["']?/);
                        if (m) spec.servicePort = m[1];
                    }
                    // TLS secret
                    if (/^\s+secretName:\s/.test(line) && !spec.tlsSecret) {
                        let m = trimmed.match(/^secretName:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.tlsSecret = m[1];
                    }
                }
                specs.push(spec);
            });
            // Merge all docs into one spec (use first non-null value found)
            let merged = { host: null, serviceName: null, servicePort: null, path: null, tlsSecret: null, ingressName: null };
            specs.forEach(function(s) {
                Object.keys(merged).forEach(function(k) { if (!merged[k] && s[k]) merged[k] = s[k]; });
            });
            return merged;
        }

        function getAnnotationValue(foundAnnotations, name) {
            let found = foundAnnotations.find(function(a) { return a.annotation === name; });
            return found ? found.value : null;
        }

        // Helper: resolve spec values with fallback to TODO placeholders
        function specHost(spec) { return (spec && spec.host) || '# TODO: Set your host'; }
        function specService(spec) { return (spec && spec.serviceName) || '# TODO: Set your service'; }
        function specPort(spec) { return (spec && spec.servicePort) || '80'; }
        function specPath(spec) { return (spec && spec.path) || '/'; }

        let CRD_GENERATORS = {
            generateAccessControlPolicy: function(found) {
                let allow = getAnnotationValue(found, 'whitelist-source-range');
                let deny = getAnnotationValue(found, 'denylist-source-range');
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: access-control-policy', 'spec:', '  accessControl:'];
                if (allow) {
                    lines.push('    allow:');
                    allow.split(',').forEach(function(ip) { lines.push('      - ' + ip.trim()); });
                }
                if (deny) {
                    lines.push('    deny:');
                    deny.split(',').forEach(function(ip) { lines.push('      - ' + ip.trim()); });
                }
                if (!allow && !deny) { lines.push('    allow:', '      - # TODO: Set your allowed CIDRs'); }
                lines.push('', '# Reference from Ingress using:', '#   annotations:', '#     nginx.org/policies: "access-control-policy"');
                return lines.join('\n');
            },
            generateCORSPolicy: function(found) {
                let origin = getAnnotationValue(found, 'cors-allow-origin') || '*';
                let methods = getAnnotationValue(found, 'cors-allow-methods') || 'GET, POST, OPTIONS';
                let headers = getAnnotationValue(found, 'cors-allow-headers') || 'Content-Type, Authorization';
                let creds = getAnnotationValue(found, 'cors-allow-credentials');
                let expose = getAnnotationValue(found, 'cors-expose-headers');
                let maxAge = getAnnotationValue(found, 'cors-max-age') || '86400';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: cors-policy', 'spec:', '  cors:', '    allowOrigin:'];
                origin.split(',').forEach(function(o) { lines.push('      - "' + o.trim() + '"'); });
                lines.push('    allowMethods:');
                methods.split(',').forEach(function(m) { lines.push('      - "' + m.trim() + '"'); });
                lines.push('    allowHeaders:');
                headers.split(',').forEach(function(h) { lines.push('      - "' + h.trim() + '"'); });
                if (creds === 'true') lines.push('    allowCredentials: true');
                if (expose) {
                    lines.push('    exposeHeaders:');
                    expose.split(',').forEach(function(e) { lines.push('      - "' + e.trim() + '"'); });
                }
                lines.push('    maxAge: ' + parseInt(maxAge, 10));
                lines.push('', '# Reference from Ingress using:', '#   annotations:', '#     nginx.org/policies: "cors-policy"', '', '# Or reference from VirtualServer:', '#   spec:', '#     policies:', '#       - name: cors-policy');
                return lines.join('\n');
            },
            generateBasicAuthPolicy: function(found) {
                let secret = getAnnotationValue(found, 'auth-secret') || '# TODO: Set your secret name';
                let realm = getAnnotationValue(found, 'auth-realm') || 'Protected Area';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: basic-auth-policy', 'spec:', '  basicAuth:', '    secret: ' + secret, '    realm: "' + realm + '"'].join('\n');
            },
            generateIngressMTLSPolicy: function(found) {
                let secret = getAnnotationValue(found, 'auth-tls-secret');
                let verify = getAnnotationValue(found, 'auth-tls-verify-client');
                let depth = getAnnotationValue(found, 'auth-tls-verify-depth');
                let secretVal = secret ? secret.replace(/^[^/]+\//, '') : '# TODO: Set your CA secret';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ingress-mtls-policy', 'spec:', '  ingressMTLS:', '    clientCertSecret: ' + secretVal, '    verifyClient: "' + (verify || 'on') + '"', '    verifyDepth: ' + (depth || '1')].join('\n');
            },
            generateEgressMTLSPolicy: function(found) {
                let secret = getAnnotationValue(found, 'proxy-ssl-secret');
                let verify = getAnnotationValue(found, 'proxy-ssl-verify');
                let depth = getAnnotationValue(found, 'proxy-ssl-verify-depth');
                let secretVal = secret ? secret.replace(/^[^/]+\//, '') : '# TODO: Set your client cert secret';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: egress-mtls-policy', 'spec:', '  egressMTLS:', '    tlsSecret: ' + secretVal, '    trustedCertSecret: # TODO: Set your CA cert secret'];
                if (verify) lines.push('    verifyServer: ' + (verify === 'on' ? 'true' : 'false'));
                if (depth) lines.push('    verifyDepth: ' + depth);
                return lines.join('\n');
            },
            generateRateLimitPolicy: function(found) {
                let rps = getAnnotationValue(found, 'limit-rps');
                let burst = getAnnotationValue(found, 'limit-burst-multiplier');
                let rate = rps ? rps + 'r/s' : '# TODO: Set your rate';
                let burstVal = (rps && burst) ? String(parseInt(rps, 10) * parseInt(burst, 10)) : (burst || '5');
                return ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: rate-limit-policy', 'spec:', '  rateLimit:', '    rate: ' + rate, '    burst: ' + burstVal, '    key: ${binary_remote_addr}', '    zoneSize: 10M', '    rejectCode: 429'].join('\n');
            },
            generateCanaryVirtualServer: function(found, spec) {
                let weight = getAnnotationValue(found, 'canary-weight') || '20';
                let header = getAnnotationValue(found, 'canary-by-header');
                let cookie = getAnnotationValue(found, 'canary-by-cookie');
                let mainWeight = String(100 - parseInt(weight, 10));
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: canary-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: main', '      service: ' + specService(spec), '      port: ' + specPort(spec), '    - name: canary', '      service: # TODO: canary service', '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec)];
                if (header || cookie) {
                    lines.push('      matches:');
                    if (header) { lines.push('        - conditions:', '            - header: ' + header, '              value: "true"', '          action:', '            pass: canary'); }
                    if (cookie) { lines.push('        - conditions:', '            - cookie: ' + cookie, '              value: "true"', '          action:', '            pass: canary'); }
                }
                lines.push('      splits:', '        - weight: ' + mainWeight, '          action: { pass: main }', '        - weight: ' + weight, '          action: { pass: canary }');
                return lines.join('\n');
            },
            generateRedirectVirtualServer: function(found, spec) {
                let url = getAnnotationValue(found, 'permanent-redirect') || getAnnotationValue(found, 'temporal-redirect') || '# TODO: Set redirect URL';
                let code = getAnnotationValue(found, 'permanent-redirect-code') || (getAnnotationValue(found, 'temporal-redirect') ? '302' : '301');
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: redirect-app', 'spec:', '  host: ' + specHost(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        redirect:', '          url: ' + url + '${request_uri}', '          code: ' + code].join('\n');
            },
            generateRewriteVirtualServer: function(found, spec) {
                let target = getAnnotationValue(found, 'rewrite-target') || '/$2';
                let path = (spec && spec.path) ? '~ ^' + spec.path : '~ ^/api(/|$)(.*)';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: rewrite-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + path, '      action:', '        proxy:', '          upstream: backend', '          rewritePath: ' + target].join('\n');
            },
            generateErrorPagesVirtualServer: function(found, spec) {
                let codes = getAnnotationValue(found, 'custom-http-errors') || '404,500,502';
                let codeList = codes.split(',').map(function(c) { return c.trim(); });
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: error-pages-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend', '      errorPages:', '        - codes: [' + codeList.join(', ') + ']', '          return:', '            code: 503', '            body: "Service Unavailable"'].join('\n');
            },
            generateSSLPassthroughTransportServer: function(found, spec) {
                return ['# tls-passthrough is a built-in listener — no GlobalConfiguration needed', 'apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ssl-passthrough-app', 'spec:', '  listener:', '    name: tls-passthrough', '    protocol: TLS_PASSTHROUGH', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: 443', '  action:', '    pass: backend'].join('\n');
            },
            generateStreamSnippetTS: function(found, spec) {
                return ['apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: stream-app', 'spec:', '  listener:', '    name: # TODO: Define in GlobalConfiguration', '    protocol: TCP', '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  action:', '    pass: backend'].join('\n');
            },
            generateCustomHeadersVS: function(found, spec) {
                let val = getAnnotationValue(found, 'custom-headers') || 'default/custom-headers-configmap';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: custom-headers-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        proxy:', '          upstream: backend', '          responseHeaders:', '            add:', '              - name: # TODO: Add your headers', '                value: # TODO: Set values', '  # Note: Migrating from ConfigMap ref: ' + val].join('\n');
            },
            generateRequestHeadersVS: function(found, spec) {
                let vhost = getAnnotationValue(found, 'upstream-vhost');
                let prefix = getAnnotationValue(found, 'x-forwarded-prefix');
                let headers = [];
                if (vhost) headers.push('              - name: Host', '                value: "' + vhost + '"');
                if (prefix) headers.push('              - name: X-Forwarded-Prefix', '                value: "' + prefix + '"');
                if (headers.length === 0) headers.push('              - name: # TODO: Set header', '                value: # TODO: Set value');
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: headers-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        proxy:', '          upstream: backend', '          requestHeaders:', '            set:'].concat(headers).join('\n');
            },
            generateHashLBVirtualServer: function(found, spec) {
                let hashBy = getAnnotationValue(found, 'upstream-hash-by') || '$request_uri';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: hash-lb-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '      lb-method: "hash ' + hashBy + ' consistent"', '  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend'].join('\n');
            },
            generateProxyNextUpstreamVS: function(found, spec) {
                let conditions = getAnnotationValue(found, 'proxy-next-upstream') || 'error timeout';
                let timeout = getAnnotationValue(found, 'proxy-next-upstream-timeout');
                let tries = getAnnotationValue(found, 'proxy-next-upstream-tries');
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: proxy-upstream-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '      next-upstream: "' + conditions + '"'];
                if (timeout) lines.push('      next-upstream-timeout: ' + (timeout.endsWith('s') ? timeout : timeout + 's'));
                if (tries) lines.push('      next-upstream-tries: ' + tries);
                lines.push('  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend');
                return lines.join('\n');
            },
            generateServerAliasVS: function(found, spec) {
                let alias = getAnnotationValue(found, 'server-alias') || 'alias.example.com';
                return ['# Create a separate VirtualServer per host alias', 'apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: alias-app', 'spec:', '  host: ' + alias, '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend'].join('\n');
            },
            generateExternalAuthPolicy: function(found) {
                let authUrl = getAnnotationValue(found, 'auth-url');
                let signin = getAnnotationValue(found, 'auth-signin');
                let snippet = getAnnotationValue(found, 'auth-snippet');
                let serviceName = '# TODO: Set your auth service (namespace/name)';
                let authURI = '/auth';
                if (authUrl) {
                    let m = authUrl.match(/^https?:\/\/([^\/:]+)(?::\d+)?(\/[^\s]*)?$/);
                    if (m) {
                        let parts = m[1].split('.');
                        // Cluster-internal "svc.ns.svc.cluster.local" → "ns/svc"; bare host → host.
                        serviceName = (parts.length >= 2 && parts.indexOf('svc') !== -1) ? (parts[1] + '/' + parts[0]) : parts[0];
                        if (m[2]) authURI = m[2];
                    }
                }
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: external-auth-policy', 'spec:', '  externalAuth:', '    authURI: "' + authURI + '"  # auth-url (path)', '    authServiceName: "' + serviceName + '"  # auth-url (service)'];
                if (signin) lines.push('    authSigninURI: "' + signin + '"  # auth-signin');
                if (snippet) {
                    lines.push('    authSnippets: |  # auth-snippet');
                    snippet.split('\n').forEach(function(l) { lines.push('      ' + l.trim()); });
                }
                lines.push('', '# Reference from Ingress (v5.5.0+):', '#   annotations:', '#     nginx.org/policies: "external-auth-policy"', '# For native OIDC (Plus), use the oidc Policy instead — see the OIDC Authentication section.');
                return lines.join('\n');
            },
            generateSessionAffinityVS: function(found, spec) {
                let name = getAnnotationValue(found, 'session-cookie-name') || 'SERVERID';
                let expires = getAnnotationValue(found, 'session-cookie-expires');
                let path = getAnnotationValue(found, 'session-cookie-path') || '/';
                let secure = getAnnotationValue(found, 'session-cookie-secure');
                let samesite = getAnnotationValue(found, 'session-cookie-samesite');
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: sticky-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '      sessionCookie:', '        enable: true', '        name: ' + name];
                if (expires) {
                    let secs = parseInt(expires, 10);
                    if (secs > 0 && secs % 3600 === 0) {
                        lines.push('        expires: ' + (secs / 3600) + 'h');
                    } else {
                        lines.push('        expires: ' + secs + 's');
                    }
                }
                lines.push('        path: ' + path);
                if (secure) lines.push('        secure: ' + secure);
                lines.push('        httpOnly: true');
                if (samesite) lines.push('        samesite: ' + samesite.toLowerCase());
                lines.push('  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend');
                return lines.join('\n');
            },
            generateWAFPolicy: function(found) {
                return ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: waf-policy', 'spec:', '  waf:', '    enable: true', '    apPolicy: "default/waf-policy"', '    securityLogs:', '      - enable: true', '        apLogConf: "default/log-config"', '        logDest: "syslog:server=syslog:514"'].join('\n');
            }
        };

        function generateMigrationYaml(sorted, ingressSpec) {
            ingressSpec = ingressSpec || {};
            let annotationSwaps = [];
            let configMapChanges = [];
            let crdResources = [];
            let unsupportedEntries = [];
            let infoNotes = [];

            sorted.forEach(function(entry) {
                let m = entry.mapping;
                let om = m.nicMapping;
                if (!om) return;

                // Collect unsupported annotations
                if (m.type === 'unsupported') {
                    unsupportedEntries.push(entry);
                    return;
                }

                // For dualApproach entries, only generate the path matching the chosen strategy
                let isDual = m.dualApproach && om.annotations && om.crdKind;
                let skipAnnotations = isDual && _migrationStrategy === 'crd';
                let skipCrd = isDual && _migrationStrategy === 'annotation';

                // Annotation swaps
                if (om.annotations && !skipAnnotations) {
                    // Special handling for CORS — generate one combined snippet
                    let hasCorsSnippet = Object.keys(om.annotations).some(function(k) { return om.annotations[k].transform === 'corsSnippet'; });
                    if (hasCorsSnippet) {
                        let corsOrigin = getAnnotationValue(entry.foundAnnotations, 'cors-allow-origin') || '*';
                        let corsMethods = getAnnotationValue(entry.foundAnnotations, 'cors-allow-methods') || 'GET, POST, OPTIONS';
                        let corsHeaders = getAnnotationValue(entry.foundAnnotations, 'cors-allow-headers') || 'DNT,User-Agent,X-Requested-With,Content-Type,Authorization';
                        let corsCreds = getAnnotationValue(entry.foundAnnotations, 'cors-allow-credentials');
                        let corsMaxAge = getAnnotationValue(entry.foundAnnotations, 'cors-max-age') || '86400';
                        let corsExpose = getAnnotationValue(entry.foundAnnotations, 'cors-expose-headers');
                        let snippetLines = [];
                        snippetLines.push('add_header Access-Control-Allow-Origin "' + corsOrigin + '" always;');
                        snippetLines.push('add_header Access-Control-Allow-Methods "' + corsMethods + '" always;');
                        snippetLines.push('add_header Access-Control-Allow-Headers "' + corsHeaders + '" always;');
                        if (corsCreds === 'true') snippetLines.push('add_header Access-Control-Allow-Credentials "true" always;');
                        snippetLines.push('add_header Access-Control-Max-Age ' + corsMaxAge + ' always;');
                        if (corsExpose) snippetLines.push('add_header Access-Control-Expose-Headers "' + corsExpose + '" always;');
                        snippetLines.push('if ($request_method = OPTIONS) { return 204; }');
                        annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/enable-cors + cors-*', fromAnnotations: entry.foundAnnotations, to: 'nginx.org/server-snippets', value: '|\\n  ' + snippetLines.join('\\n  '), originalValue: 'true (+ cors-* values)', entry: entry });
                    } else {
                        // Special handling for backend-protocol — selects correct F5 NGINX Ingress Controller annotation based on value
                        let hasBackendProtocol = Object.keys(om.annotations).some(function(k) { return om.annotations[k].transform === 'backendProtocol'; });
                        if (hasBackendProtocol) {
                            entry.foundAnnotations.forEach(function(a) {
                                let spec = om.annotations[a.annotation];
                                if (spec && spec.transform === 'backendProtocol') {
                                    let upperVal = (a.value || '').toUpperCase();
                                    let svcName = specService(ingressSpec);
                                    if (upperVal === 'GRPC' || upperVal === 'GRPCS') {
                                        annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, to: 'nginx.org/grpc-services', value: svcName, originalValue: a.value, entry: entry });
                                    } else if (upperVal === 'HTTPS') {
                                        annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, to: 'nginx.org/ssl-services', value: svcName, originalValue: a.value, entry: entry });
                                    } else if (upperVal === 'HTTP') {
                                        infoNotes.push({ annotation: a.annotation, value: a.value, message: 'HTTP is the default protocol in F5 NGINX Ingress Controller. Remove this annotation — no replacement is needed.', entry: entry });
                                    } else if (upperVal === 'AUTO_HTTP' || upperVal === 'FCGI') {
                                        infoNotes.push({ annotation: a.annotation, value: a.value, message: upperVal + ' has no direct equivalent in F5 NGINX Ingress Controller. Review your backend protocol strategy before migrating.', entry: entry });
                                    }
                                } else if (spec) {
                                    let translated = unwrapTranslated(translateValue(a.value, spec.transform, spec.template));
                                    annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, to: spec.key, value: translated.value, note: translated.note, originalValue: a.value, entry: entry });
                                }
                            });
                        } else {
                            entry.foundAnnotations.forEach(function(a) {
                                let spec = om.annotations[a.annotation];
                                if (spec) {
                                    let translated = unwrapTranslated(translateValue(a.value, spec.transform, spec.template));
                                    annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, to: spec.key, value: translated.value, note: translated.note, originalValue: a.value, entry: entry });
                                }
                            });
                        }
                    }
                }

                // ConfigMap changes
                if (om.configMap) {
                    entry.foundAnnotations.forEach(function(a) {
                        let spec = om.configMap[a.annotation];
                        if (spec) {
                            let translated = unwrapTranslated(translateValue(a.value, spec.transform, spec.template));
                            configMapChanges.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, to: spec.key, value: translated.value, note: translated.note, originalValue: a.value, entry: entry });
                        }
                    });
                }

                // CRD resources
                if (om.crdKind && om.templateFn && CRD_GENERATORS[om.templateFn] && !skipCrd) {
                    try {
                        let yaml = CRD_GENERATORS[om.templateFn](entry.foundAnnotations, ingressSpec);
                        crdResources.push({ kind: om.crdKind, install: om.crdInstall, yaml: yaml, entry: entry });
                    } catch (e) {
                        console.warn('CRD generator failed for ' + om.crdKind + ' (' + om.templateFn + '):', e);
                    }
                }
            });

            // Merge duplicate annotation keys (e.g., multiple location-snippets)
            let mergedSwaps = [];
            let snippetKeys = {};
            annotationSwaps.forEach(function(swap) {
                if (swap.to === 'nginx.org/location-snippets' || swap.to === 'nginx.org/server-snippets') {
                    if (!snippetKeys[swap.to]) {
                        snippetKeys[swap.to] = { swap: { from: swap.from, fromAnnotations: swap.fromAnnotations, to: swap.to, value: swap.value, originalValue: swap.originalValue, entry: swap.entry, mergedEntries: [swap.entry] }, fromParts: [swap.from], valueParts: [swap.value], origParts: [swap.originalValue || swap.value], allFromAnnotations: swap.fromAnnotations ? swap.fromAnnotations.slice() : [] };
                    } else {
                        snippetKeys[swap.to].fromParts.push(swap.from);
                        snippetKeys[swap.to].valueParts.push(swap.value);
                        snippetKeys[swap.to].origParts.push(swap.originalValue || swap.value);
                        snippetKeys[swap.to].swap.mergedEntries.push(swap.entry);
                        if (swap.fromAnnotations) swap.fromAnnotations.forEach(function(a) { snippetKeys[swap.to].allFromAnnotations.push(a); });
                    }
                } else {
                    mergedSwaps.push(swap);
                }
            });
            Object.keys(snippetKeys).forEach(function(key) {
                let merged = snippetKeys[key];
                merged.swap.from = merged.fromParts.join(' + ');
                merged.swap.value = '|\\n  ' + merged.valueParts.map(function(v) { return v.replace(/^\|\\n\s*/, ''); }).join('\\n  ');
                merged.swap.originalValue = merged.origParts.join(', ');
                if (merged.allFromAnnotations.length > 0) merged.swap.fromAnnotations = merged.allFromAnnotations;
                mergedSwaps.push(merged.swap);
            });

            // Post-process: when ssl-redirect or force-ssl-redirect is migrated,
            // also emit nginx.org/http-redirect-code: "308" so the migrated
            // Ingress preserves the community controller's 308 default
            // (which preserves the original request method and body — NIC
            // defaults to 301, which clients may downgrade to GET).
            let redirectSwap = mergedSwaps.find(function(s) {
                return s.to === 'nginx.org/ssl-redirect' || s.to === 'nginx.org/redirect-to-https';
            });
            let alreadyHasCode = mergedSwaps.some(function(s) { return s.to === 'nginx.org/http-redirect-code'; });
            if (redirectSwap && !alreadyHasCode) {
                mergedSwaps.push({
                    from: 'ssl-redirect (community 308 default)',
                    fromAnnotations: [],
                    to: 'nginx.org/http-redirect-code',
                    value: '308',
                    originalValue: '308',
                    note: 'matches community 308 default; preserves request method and body',
                    entry: redirectSwap.entry,
                    isSynthetic: true
                });
            }

            return { annotationSwaps: mergedSwaps, configMapChanges: configMapChanges, crdResources: crdResources, unsupportedEntries: unsupportedEntries, infoNotes: infoNotes };
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
            wrap.setAttribute('role', 'status');
            wrap.setAttribute('aria-live', 'polite');
            let spinner = document.createElement('span');
            spinner.className = 'analyzer-loading-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            wrap.appendChild(spinner);
            wrap.appendChild(document.createTextNode('Analyzing your YAML…'));
            container.appendChild(wrap);
        }

        function analyzeYaml() {
            let yamlText = document.getElementById('yamlInput').value.trim();
            let resultsDiv = document.getElementById('analyzerResults');
            if (!yamlText) {
                showAnalyzerMessage(resultsDiv, 'error', 'No input.', 'Paste a Kubernetes Ingress YAML manifest to analyze.');
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
            let warnings = detectUnsupportedSyntax(yamlText);
            let annotations = parseYamlAnnotations(yamlText);
            let ingressSpec = parseIngressSpec(yamlText);
            if (annotations.length === 0) {
                resultsDiv.textContent = '';
                renderParserWarnings(resultsDiv, warnings);
                showAnalyzerMessage(resultsDiv, 'info', 'No community NGINX annotations found.', 'Make sure your YAML contains annotations with the nginx.ingress.kubernetes.io/ prefix.', { append: true });
                return;
            }
            let matchedMappings = new Map();
            let unrecognized = [];
            annotations.forEach(function(ann) {
                let idx = ANNOTATION_LOOKUP.get(ann.annotation);
                if (idx !== undefined) {
                    if (!matchedMappings.has(idx)) {
                        matchedMappings.set(idx, { mapping: ANNOTATION_MAPPINGS[idx], foundAnnotations: [] });
                    }
                    let entry = matchedMappings.get(idx);
                    if (!entry.foundAnnotations.some(function(a) { return a.annotation === ann.annotation; })) {
                        entry.foundAnnotations.push({ annotation: ann.annotation, value: ann.value });
                    }
                } else {
                    if (!unrecognized.some(function(u) { return u.annotation === ann.annotation; })) {
                        unrecognized.push(ann);
                    }
                }
            });
            let typeOrder = { policy: 0, virtualserver: 1, virtualserverroute: 2, transportserver: 3, globalconfiguration: 4, annotation: 5, configmap: 6, unsupported: 7 };
            let sorted = Array.from(matchedMappings.values()).sort(function(a, b) {
                let ta = typeOrder[a.mapping.type] !== undefined ? typeOrder[a.mapping.type] : 99;
                let tb = typeOrder[b.mapping.type] !== undefined ? typeOrder[b.mapping.type] : 99;
                if (ta !== tb) return ta - tb;
                return a.mapping.category.localeCompare(b.mapping.category);
            });
            renderAnalyzerResults(resultsDiv, annotations.length, sorted, unrecognized, ingressSpec);
            // Prepend any parser warnings inside the renderer's now-populated container.
            if (warnings.length > 0) {
                let firstChild = resultsDiv.firstChild;
                let warningHolder = document.createDocumentFragment();
                renderParserWarnings(warningHolder, warnings);
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

        function buildDiffYamlBlock(text, diffType) {
            // diffType: 'removed' or 'added' — highlights annotation lines (skips the first 'annotations:' line)
            let pre = document.createElement('div');
            pre.className = 'analyzer-yaml-output';
            let copyBtn = document.createElement('button');
            copyBtn.className = 'analyzer-copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', function() { copyAnalyzerBlock(copyBtn); });
            pre.appendChild(copyBtn);
            let lines = text.split('\n');
            lines.forEach(function(line, i) {
                if (i > 0) pre.appendChild(document.createTextNode('\n'));
                let isAnnotationLine = i > 0 && line.match(/^\s+\S/);
                if (isAnnotationLine) {
                    let wrapper = document.createElement('span');
                    wrapper.className = 'yaml-diff-line ' + diffType;
                    let frag = highlightYaml(line);
                    wrapper.appendChild(frag);
                    pre.appendChild(wrapper);
                } else {
                    pre.appendChild(highlightYaml(line));
                }
            });
            pre.setAttribute('data-raw', text);
            return pre;
        }

        function renderAnalyzerResults(container, totalAnnotations, sorted, unrecognized, ingressSpec) {
            container.textContent = '';
            let migration = generateMigrationYaml(sorted, ingressSpec);

            // Summary pills
            let summary = document.createElement('div');
            summary.className = 'analyzer-summary';
            function addPill(cls, text, scrollTarget) {
                let span = document.createElement('span');
                span.className = 'analyzer-pill ' + cls;
                span.textContent = text;
                if (scrollTarget) {
                    span.setAttribute('data-scroll', scrollTarget);
                    span.setAttribute('title', 'Click to jump to this section');
                    span.addEventListener('click', function() {
                        let el = document.getElementById(scrollTarget);
                        if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
                    });
                }
                summary.appendChild(span);
            }
            addPill('found', totalAnnotations + ' annotation' + (totalAnnotations !== 1 ? 's' : '') + ' found');
            addPill('paths', sorted.length + ' migration path' + (sorted.length !== 1 ? 's' : ''), migration.annotationSwaps.length > 0 ? 'analyzer-step-1' : null);
            if (migration.crdResources.length > 0) addPill('crds', migration.crdResources.length + ' require CRDs', 'analyzer-step-3');
            if (unrecognized.length > 0) addPill('unrecognized', unrecognized.length + ' unrecognized', 'analyzer-unrecognized');
            container.appendChild(summary);

            // Announce results to screen readers
            let liveStatus = document.getElementById('analyzerLiveStatus');
            if (liveStatus) {
                let msg = totalAnnotations + ' annotation' + (totalAnnotations !== 1 ? 's' : '') + ' found, ' + sorted.length + ' migration path' + (sorted.length !== 1 ? 's' : '');
                if (migration.crdResources.length > 0) msg += ', ' + migration.crdResources.length + ' require CRDs';
                if (unrecognized.length > 0) msg += ', ' + unrecognized.length + ' unrecognized';
                liveStatus.textContent = msg;
            }

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
            let stepCount = (migration.annotationSwaps.length > 0 ? 1 : 0) + (migration.configMapChanges.length > 0 ? 1 : 0) + (migration.crdResources.length > 0 ? 1 : 0);
            bannerText.textContent = 'Analysis complete \u2014 ';
            let bannerStrong = document.createElement('strong');
            bannerStrong.textContent = totalAnnotations + ' annotations analyzed';
            bannerText.appendChild(bannerStrong);
            bannerText.appendChild(document.createTextNode(', ' + sorted.length + ' migration paths across ' + stepCount + ' step' + (stepCount !== 1 ? 's' : '') + '.'));
            banner.appendChild(bannerText);

            // Complexity indicator
            let complexityLevel = migration.crdResources.length > 0 ? 'advanced' : migration.configMapChanges.length > 0 ? 'moderate' : 'simple';
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

            let stepNum = 0;

            // Step 1: Annotation Swaps
            if (migration.annotationSwaps.length > 0) {
                stepNum++;
                let step1 = document.createElement('div');
                step1.className = 'analyzer-step';
                step1.id = 'analyzer-step-1';
                let h1 = document.createElement('div');
                h1.className = 'analyzer-step-header';
                let n1 = document.createElement('div');
                n1.className = 'analyzer-step-number';
                n1.textContent = String(stepNum);
                let t1 = document.createElement('h3');
                t1.className = 'analyzer-step-title';
                t1.textContent = 'Swap Annotations';
                let c1 = document.createElement('span');
                c1.className = 'analyzer-step-count';
                c1.textContent = migration.annotationSwaps.length + ' annotation' + (migration.annotationSwaps.length !== 1 ? 's' : '');
                h1.appendChild(n1);
                h1.appendChild(t1);
                h1.appendChild(c1);
                step1.appendChild(h1);
                let d1 = document.createElement('div');
                d1.className = 'analyzer-step-desc';
                d1.textContent = 'Replace community annotations with their F5 NGINX Ingress Controller equivalents. Copy this annotations block into your Ingress metadata.';
                step1.appendChild(d1);

                let oldLines = ['annotations:'];
                let newLines = ['annotations:'];
                let seenEntries = new Map();
                // Sort by category for grouped output
                let swapsByCategory = {};
                migration.annotationSwaps.forEach(function(swap) {
                    let cat = swap.entry.mapping.category;
                    if (!swapsByCategory[cat]) swapsByCategory[cat] = [];
                    swapsByCategory[cat].push(swap);
                });
                let categoryKeys = Object.keys(swapsByCategory).sort();
                let multiCategory = categoryKeys.length > 1;
                categoryKeys.forEach(function(cat) {
                    if (multiCategory) {
                        oldLines.push('  # ' + cat);
                        newLines.push('  # ' + cat);
                    }
                    swapsByCategory[cat].forEach(function(swap) {
                        if (swap.fromAnnotations) {
                            swap.fromAnnotations.forEach(function(a) {
                                oldLines.push(formatYamlKV('  ', 'nginx.ingress.kubernetes.io/' + a.annotation, a.value != null ? a.value : ''));
                            });
                        } else {
                            oldLines.push(formatYamlKV('  ', swap.from, swap.originalValue || swap.value));
                        }
                        // New line: NIC annotation + comment showing community source
                        // and any substitution note (e.g., "ewma is not supported, using least_conn").
                        let shortName = swap.from.replace(/nginx\.ingress\.kubernetes\.io\//g, '');
                        let commentText = shortName + (swap.note ? ' — ' + swap.note : '');
                        let newLine = formatYamlKV('  ', swap.to, swap.value);
                        if (newLine.indexOf(': |\n') !== -1) {
                            newLine = newLine.replace(': |', ': |  # ' + commentText);
                        } else {
                            newLine += '  # ' + commentText;
                        }
                        newLines.push(newLine);
                        let entriesToTrack = swap.mergedEntries || [swap.entry];
                        entriesToTrack.forEach(function(e) { if (!seenEntries.has(e)) seenEntries.set(e, e); });
                    });
                });

                // Side-by-side comparison
                let comp = document.createElement('div');
                comp.className = 'analyzer-comparison';
                let oldBlock = document.createElement('div');
                oldBlock.className = 'analyzer-comparison-block old';
                let oldH5 = document.createElement('h4');
                oldH5.textContent = 'Kubernetes Ingress NGINX (Ingress-NGINX) '; let oldBadge = document.createElement('span'); oldBadge.className = 'analyzer-comparison-badge'; oldBadge.textContent = 'current'; oldH5.appendChild(oldBadge);
                oldBlock.appendChild(oldH5);
                oldBlock.appendChild(buildYamlBlock(oldLines.join('\n')));
                let newBlock = document.createElement('div');
                newBlock.className = 'analyzer-comparison-block new';
                let newH5 = document.createElement('h4');
                newH5.textContent = 'F5 NGINX Ingress Controller '; let newBadge = document.createElement('span'); newBadge.className = 'analyzer-comparison-badge'; newBadge.textContent = 'migrated'; newH5.appendChild(newBadge);
                newBlock.appendChild(newH5);
                newBlock.appendChild(buildYamlBlock(newLines.join('\n')));
                comp.appendChild(oldBlock);
                comp.appendChild(newBlock);
                step1.appendChild(comp);

                // Dual-approach note
                let dualEntries = Array.from(seenEntries.values()).filter(function(e) { return e.mapping.dualApproach; });
                if (dualEntries.length > 0 && migration.crdResources.length > 0) {
                    let dualNote = document.createElement('div');
                    dualNote.className = 'analyzer-dual-note';
                    let crdStepNum = stepNum + (migration.configMapChanges.length > 0 ? 2 : 1);
                    dualNote.textContent = 'Some annotations above also have a CRD-based approach shown in Step ' + crdStepNum + ' below.';
                    step1.appendChild(dualNote);
                }

                applyFadeIn(step1);
                container.appendChild(step1);
            }

            // Step 2: ConfigMap Changes
            if (migration.configMapChanges.length > 0) {
                stepNum++;
                let step2 = document.createElement('div');
                step2.className = 'analyzer-step';
                step2.id = 'analyzer-step-2';
                let h2 = document.createElement('div');
                h2.className = 'analyzer-step-header';
                let n2 = document.createElement('div');
                n2.className = 'analyzer-step-number';
                n2.textContent = String(stepNum);
                let t2 = document.createElement('h3');
                t2.className = 'analyzer-step-title';
                t2.textContent = 'ConfigMap Changes';
                let c2 = document.createElement('span');
                c2.className = 'analyzer-step-count configmap';
                c2.textContent = migration.configMapChanges.length + ' entr' + (migration.configMapChanges.length !== 1 ? 'ies' : 'y');
                h2.appendChild(n2);
                h2.appendChild(t2);
                h2.appendChild(c2);
                step2.appendChild(h2);
                let d2 = document.createElement('div');
                d2.className = 'analyzer-step-desc';
                d2.textContent = 'These settings are configured via the NGINX ConfigMap instead of annotations. Update your nginx-config ConfigMap with these entries.';
                step2.appendChild(d2);

                let cmOldLines = ['annotations:'];
                let cmLines = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: nginx-config', 'data:'];
                migration.configMapChanges.forEach(function(change) {
                    cmOldLines.push(formatYamlKV('  ', change.from, change.originalValue || change.value));
                    let cmShortName = change.from.replace(/nginx\.ingress\.kubernetes\.io\//g, '');
                    let cmComment = cmShortName + (change.note ? ' — ' + change.note : '');
                    cmLines.push(formatYamlKV('  ', change.to, change.value) + '  # ' + cmComment);
                });

                // Side-by-side comparison for ConfigMap
                let cmComp = document.createElement('div');
                cmComp.className = 'analyzer-comparison';
                let cmOldBlock = document.createElement('div');
                cmOldBlock.className = 'analyzer-comparison-block old';
                let cmOldH5 = document.createElement('h4');
                cmOldH5.textContent = 'Kubernetes Ingress NGINX (Ingress-NGINX) (current)';
                cmOldBlock.appendChild(cmOldH5);
                cmOldBlock.appendChild(buildYamlBlock(cmOldLines.join('\n')));
                let cmNewBlock = document.createElement('div');
                cmNewBlock.className = 'analyzer-comparison-block new';
                let cmNewH5 = document.createElement('h4');
                cmNewH5.textContent = 'F5 NGINX Ingress Controller (migrated)';
                cmNewBlock.appendChild(cmNewH5);
                cmNewBlock.appendChild(buildYamlBlock(cmLines.join('\n')));
                cmComp.appendChild(cmOldBlock);
                cmComp.appendChild(cmNewBlock);
                step2.appendChild(cmComp);
                applyFadeIn(step2);
                container.appendChild(step2);
            }

            // Step 3: CRD Resources
            if (migration.crdResources.length > 0) {
                stepNum++;
                let step3 = document.createElement('div');
                step3.className = 'analyzer-step';
                step3.id = 'analyzer-step-3';
                let h3 = document.createElement('div');
                h3.className = 'analyzer-step-header';
                let n3 = document.createElement('div');
                n3.className = 'analyzer-step-number';
                n3.textContent = String(stepNum);
                let t3 = document.createElement('h3');
                t3.className = 'analyzer-step-title';
                t3.textContent = 'CRD Resources';
                let c3 = document.createElement('span');
                c3.className = 'analyzer-step-count crd';
                c3.textContent = migration.crdResources.length + ' resource' + (migration.crdResources.length !== 1 ? 's' : '');
                h3.appendChild(n3);
                h3.appendChild(t3);
                h3.appendChild(c3);
                step3.appendChild(h3);
                let d3 = document.createElement('div');
                d3.className = 'analyzer-step-desc';
                d3.textContent = 'These features require Custom Resource Definitions. Install the CRDs first, then apply the generated resources.';
                step3.appendChild(d3);

                // Group by CRD kind
                let crdGroups = {};
                migration.crdResources.forEach(function(res) {
                    if (!crdGroups[res.kind]) crdGroups[res.kind] = [];
                    crdGroups[res.kind].push(res);
                });

                // Link to Installing CRDs section instead of showing inline command
                let hasCrdInstall = Object.keys(crdGroups).some(function(kind) {
                    return crdGroups[kind].some(function(res) { return res.install; });
                });
                if (hasCrdInstall) {
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
                    step3.appendChild(installNote);
                }

                Object.keys(crdGroups).forEach(function(kind) {
                    let group = crdGroups[kind];
                    let groupDiv = document.createElement('div');
                    groupDiv.className = 'analyzer-crd-group';
                    let groupTitle = document.createElement('div');
                    groupTitle.className = 'analyzer-crd-group-title';
                    // Map CRD kind to badge class
                    let kindBadgeMap = { 'Policy': 'policy', 'VirtualServer': 'virtualserver', 'VirtualServerRoute': 'virtualserverroute', 'TransportServer': 'transportserver', 'GlobalConfiguration': 'globalconfiguration' };
                    let badgeClass = kindBadgeMap[kind] || 'virtualserver';
                    let kindBadge = document.createElement('span');
                    kindBadge.className = 'badge badge-' + badgeClass;
                    kindBadge.style.marginRight = '8px';
                    kindBadge.textContent = kind + ' CRD';
                    groupTitle.appendChild(kindBadge);
                    groupTitle.appendChild(document.createTextNode(group.length + ' resource' + (group.length !== 1 ? 's' : '')));
                    groupDiv.appendChild(groupTitle);

                    group.forEach(function(res, idx) {
                        if (idx > 0) {
                            let spacer = document.createElement('hr');
                            spacer.className = 'analyzer-step-separator';
                            groupDiv.appendChild(spacer);
                        }
                        let catLabel = document.createElement('div');
                        catLabel.style.cssText = 'font-size:0.82rem;color:var(--text-secondary);margin-bottom:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
                        catLabel.appendChild(document.createTextNode(res.entry.mapping.category));
                        if (res.entry.mapping.plusRequired) {
                            let plusBadge = document.createElement('span');
                            plusBadge.className = 'plus-indicator';
                            plusBadge.textContent = 'Plus Required';
                            catLabel.appendChild(plusBadge);
                        }
                        if (res.entry.mapping.dualApproach) catLabel.appendChild(document.createTextNode(' — CRD Approach'));
                        groupDiv.appendChild(catLabel);

                        // Side-by-side: community annotations (left) → CRD resource (right)
                        let crdComp = document.createElement('div');
                        crdComp.className = 'analyzer-comparison';
                        let crdOldBlock = document.createElement('div');
                        crdOldBlock.className = 'analyzer-comparison-block old';
                        let crdOldH5 = document.createElement('h4');
                        crdOldH5.textContent = 'Kubernetes Ingress NGINX (Ingress-NGINX) (current)';
                        crdOldBlock.appendChild(crdOldH5);
                        let crdOldYaml = ['annotations:'];
                        res.entry.foundAnnotations.forEach(function(a) {
                            let key = 'nginx.ingress.kubernetes.io/' + a.annotation;
                            let val = a.value != null ? a.value : '';
                            let line;
                            if (val === '' || val === 'true' || val === 'false') {
                                line = '  ' + key + ': "' + val + '"';
                            } else if (/[:{}\[\],&*#?|<>=!%@`]/.test(val) || /^\s|\s$/.test(val)) {
                                line = '  ' + key + ': "' + val.replace(/"/g, '\\"') + '"';
                            } else {
                                line = '  ' + key + ': ' + val;
                            }
                            crdOldYaml.push(line);
                        });
                        crdOldBlock.appendChild(buildYamlBlock(crdOldYaml.join('\n')));
                        let crdNewBlock = document.createElement('div');
                        crdNewBlock.className = 'analyzer-comparison-block new';
                        let crdNewH5 = document.createElement('h4');
                        crdNewH5.textContent = 'F5 NGINX Ingress Controller (migrated)';
                        crdNewBlock.appendChild(crdNewH5);
                        // Dynamically inject inline comments into CRD YAML
                        let crdYamlLines = res.yaml.split('\n');
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
                            res.entry.foundAnnotations.forEach(function(a) {
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
                        let unmatched = res.entry.foundAnnotations.filter(function(a) { return !usedAnnotations[a.annotation]; });
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
                        let annotatedYaml = annotatedLines.join('\n');
                        crdNewBlock.appendChild(buildYamlBlock(annotatedYaml, true));
                        crdComp.appendChild(crdOldBlock);
                        crdComp.appendChild(crdNewBlock);
                        groupDiv.appendChild(crdComp);
                    });
                    step3.appendChild(groupDiv);
                });

                applyFadeIn(step3);
                container.appendChild(step3);
            }

            // Informational notes (recognized values that don't need a swap or have no equivalent)
            if (migration.infoNotes && migration.infoNotes.length > 0) {
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
                cInfo.textContent = migration.infoNotes.length + ' note' + (migration.infoNotes.length !== 1 ? 's' : '');
                hInfo.appendChild(nInfo);
                hInfo.appendChild(tInfo);
                hInfo.appendChild(cInfo);
                stepInfo.appendChild(hInfo);
                migration.infoNotes.forEach(function(note) {
                    let card = document.createElement('div');
                    card.className = 'info-box note';
                    card.style.cssText = 'margin: 10px 0;';
                    let annCode = document.createElement('code');
                    annCode.textContent = 'nginx.ingress.kubernetes.io/' + note.annotation + ': ' + note.value;
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

            // Unsupported annotations (recognized but no migration path)
            if (migration.unsupportedEntries.length > 0) {
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
                t4.textContent = 'Unsupported Annotations';
                let c4 = document.createElement('span');
                c4.className = 'analyzer-step-count unsupported';
                let unsupCount = 0;
                migration.unsupportedEntries.forEach(function(e) { unsupCount += e.foundAnnotations.length; });
                c4.textContent = unsupCount + ' annotation' + (unsupCount !== 1 ? 's' : '');
                h4u.appendChild(n4);
                h4u.appendChild(t4);
                h4u.appendChild(c4);
                step4.appendChild(h4u);
                let d4 = document.createElement('div');
                d4.className = 'analyzer-step-desc';
                d4.textContent = 'These annotations are recognized but have no direct equivalent in the F5 NGINX Ingress Controller. Review each one and take the recommended action.';
                step4.appendChild(d4);

                migration.unsupportedEntries.forEach(function(entry) {
                    let card = document.createElement('div');
                    card.className = 'info-box warning';
                    card.style.cssText = 'margin: 10px 0;';
                    let title = document.createElement('strong');
                    title.textContent = entry.mapping.category;
                    card.appendChild(title);
                    let annList = entry.foundAnnotations.map(function(a) { return a.annotation; }).join(', ');
                    card.appendChild(document.createTextNode(' — '));
                    let annCode = document.createElement('code');
                    annCode.textContent = annList;
                    card.appendChild(annCode);
                    let desc = document.createElement('div');
                    desc.style.cssText = 'margin-top: 6px; font-size: 0.88rem;';
                    desc.textContent = entry.mapping.nic;
                    card.appendChild(desc);
                    if (entry.mapping.anchor) {
                        let link = document.createElement('a');
                        link.href = '#' + entry.mapping.anchor;
                        link.style.cssText = 'font-size: 0.82rem; margin-top: 4px; display: inline-block;';
                        link.textContent = 'See Reference Guide \u2192';
                        link.addEventListener('click', function(e) {
                            e.preventDefault();
                            let sidebarLink = document.querySelector('.sidebar-link[data-section="' + (entry.mapping.section === 'plus' ? 'plus-mappings' : 'mappings') + '"]');
                            if (sidebarLink) sidebarLink.click();
                            setTimeout(function() {
                                let target = document.getElementById(entry.mapping.anchor);
                                if (target) { let y = target.getBoundingClientRect().top + window.pageYOffset - 64; window.scrollTo({ top: y, behavior: scrollBehavior() }); }
                            }, 150);
                        });
                        card.appendChild(desc);
                        card.appendChild(link);
                    }
                    step4.appendChild(card);
                });

                applyFadeIn(step4);
                container.appendChild(step4);
            }

            // Unrecognized
            if (unrecognized.length > 0) {
                let unrecSection = document.createElement('div');
                unrecSection.className = 'analyzer-unrecognized-section';
                unrecSection.id = 'analyzer-unrecognized';
                let h4 = document.createElement('h4');
                h4.textContent = 'Unrecognized Annotations';
                unrecSection.appendChild(h4);
                let desc = document.createElement('p');
                desc.style.fontSize = '0.9rem';
                desc.style.color = '#666';
                desc.style.marginBottom = '10px';
                desc.textContent = 'These annotations were not found in the migration database. They may be custom, deprecated, or not yet mapped.';
                unrecSection.appendChild(desc);
                unrecognized.forEach(function(u) {
                    let uCard = document.createElement('div');
                    uCard.className = 'analyzer-card unrecognized';
                    let uHeader = document.createElement('div');
                    uHeader.className = 'analyzer-card-header';
                    let uFound = document.createElement('div');
                    uFound.className = 'found-annotations';
                    let key = 'nginx.ingress.kubernetes.io/' + u.annotation;
                    let val = u.value != null ? u.value : '';
                    let yamlLine = 'annotations:\n  ' + key + ': ' + (val === '' || val === 'true' || val === 'false' ? '"' + val + '"' : val);
                    uFound.appendChild(buildYamlBlock(yamlLine));
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
                contributeLink.textContent = 'Contribute a mapping on GitHub \u2192';
                contributeP.appendChild(contributeLink);
                unrecSection.appendChild(contributeP);
                applyFadeIn(unrecSection);
                container.appendChild(unrecSection);
            }

            // Export actions (Copy All + Download)
            if (migration.annotationSwaps.length > 0 || migration.configMapChanges.length > 0 || migration.crdResources.length > 0) {
                let allYamlParts = [];
                if (migration.annotationSwaps.length > 0) {
                    let swapLines = ['# Step 1: Annotation Swaps', 'annotations:'];
                    let copySwapsByCat = {};
                    migration.annotationSwaps.forEach(function(s) {
                        let cat = s.entry.mapping.category;
                        if (!copySwapsByCat[cat]) copySwapsByCat[cat] = [];
                        copySwapsByCat[cat].push(s);
                    });
                    let copyCatKeys = Object.keys(copySwapsByCat).sort();
                    copyCatKeys.forEach(function(cat) {
                        if (copyCatKeys.length > 1) swapLines.push('  # ' + cat);
                        copySwapsByCat[cat].forEach(function(s) { swapLines.push(formatYamlKV('  ', s.to, s.value)); });
                    });
                    allYamlParts.push(swapLines.join('\n'));
                }
                if (migration.configMapChanges.length > 0) {
                    let cmParts = ['# Step 2: ConfigMap Changes', 'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: nginx-config', 'data:'];
                    migration.configMapChanges.forEach(function(c) { cmParts.push(formatYamlKV('  ', c.to, c.value)); });
                    allYamlParts.push(cmParts.join('\n'));
                }
                if (migration.crdResources.length > 0) {
                    migration.crdResources.forEach(function(r) {
                        allYamlParts.push('# Step 3: ' + r.entry.mapping.category + ' (' + r.kind + ')\n' + r.yaml);
                    });
                }
                let allYaml = allYamlParts.join('\n---\n');
                let exportRow = document.createElement('div');
                exportRow.className = 'analyzer-export-actions';
                let copyAllBtn = document.createElement('button');
                copyAllBtn.className = 'analyzer-copy-all';
                copyAllBtn.style.marginTop = '0';
                let svgNS = 'http://www.w3.org/2000/svg';
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
                    function onCopied() {
                        copyAllBtn.textContent = '';
                        copyAllBtn.appendChild(clipSvg);
                        copyAllBtn.appendChild(document.createTextNode('Copied!'));
                        copyAllBtn.classList.add('copied');
                        setTimeout(function() {
                            copyAllBtn.textContent = '';
                            copyAllBtn.appendChild(clipSvg);
                            copyAllBtn.appendChild(document.createTextNode('Copy All Migration YAML'));
                            copyAllBtn.classList.remove('copied');
                        }, 2000);
                    }
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(allYaml).then(onCopied).catch(function() {
                            fallbackCopy(allYaml);
                            onCopied();
                        });
                    } else {
                        fallbackCopy(allYaml);
                        onCopied();
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
                    let header = '# NGINX Ingress Migration Tool — Generated Output\n# https://kubernetes.nginx.org/ingress-nginx-migration.html\n# Generated: ' + new Date().toISOString().split('T')[0] + '\n\n';
                    let blob = new Blob([header + allYaml], { type: 'application/x-yaml' });
                    let url = URL.createObjectURL(blob);
                    let a = document.createElement('a');
                    a.href = url;
                    a.download = 'nginx-ingress-migration.yaml';
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
            if (sorted.length > 0) {
                let nextBox = document.createElement('div');
                nextBox.className = 'analyzer-next-steps';
                let nextH4 = document.createElement('h4');
                nextH4.textContent = "What's Next?";
                nextBox.appendChild(nextH4);
                let nextUl = document.createElement('ul');
                let nextItems = [
                    { text: 'Review the full Migration Checklist', anchor: '#checklist' },
                    { text: 'Browse all OSS annotation mappings', anchor: '#mappings' }
                ];
                if (migration.crdResources.length > 0) nextItems.push({ text: 'Install the required CRDs', anchor: '#installation' });
                nextItems.push({ text: 'Check the F5 NGINX Ingress Controller docs', href: 'https://docs.nginx.com/nginx-ingress-controller/', external: true });
                nextItems.forEach(function(item) {
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

        // Sample YAML presets
        let SAMPLE_PRESETS = {
            simple:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: simple-app\n' +
'  annotations:\n' +
'    nginx.ingress.kubernetes.io/ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/proxy-body-size: "10m"\n' +
'    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"\n' +
'    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"\n' +
'    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"\n' +
'spec:\n' +
'  ingressClassName: nginx\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - app.example.com\n' +
'      secretName: app-tls\n' +
'  rules:\n' +
'    - host: app.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: app-service\n' +
'                port:\n' +
'                  number: 80',
            moderate:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: production-app\n' +
'  annotations:\n' +
'    nginx.ingress.kubernetes.io/ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/proxy-body-size: "50m"\n' +
'    nginx.ingress.kubernetes.io/proxy-buffer-size: "8k"\n' +
'    nginx.ingress.kubernetes.io/proxy-buffering: "on"\n' +
'    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"\n' +
'    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"\n' +
'    nginx.ingress.kubernetes.io/proxy-send-timeout: "120"\n' +
'    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"\n' +
'    nginx.ingress.kubernetes.io/load-balance: "ewma"\n' +
'    nginx.ingress.kubernetes.io/enable-access-log: "false"\n' +
'    nginx.ingress.kubernetes.io/enable-opentelemetry: "true"\n' +
'spec:\n' +
'  ingressClassName: nginx\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - app.example.com\n' +
'      secretName: app-tls\n' +
'  rules:\n' +
'    - host: app.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: api-service\n' +
'                port:\n' +
'                  number: 443',
            advanced:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: enterprise-app\n' +
'  annotations:\n' +
'    # SSL and security\n' +
'    nginx.ingress.kubernetes.io/ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/auth-tls-verify-client: "on"\n' +
'    nginx.ingress.kubernetes.io/auth-tls-secret: "default/ca-secret"\n' +
'    nginx.ingress.kubernetes.io/auth-tls-verify-depth: "2"\n' +
'    # Session affinity\n' +
'    nginx.ingress.kubernetes.io/affinity: "cookie"\n' +
'    nginx.ingress.kubernetes.io/session-cookie-name: "SERVERID"\n' +
'    nginx.ingress.kubernetes.io/session-cookie-expires: "172800"\n' +
'    nginx.ingress.kubernetes.io/session-cookie-max-age: "172800"\n' +
'    nginx.ingress.kubernetes.io/session-cookie-path: "/"\n' +
'    # WAF/ModSecurity (Plus)\n' +
'    nginx.ingress.kubernetes.io/enable-modsecurity: "true"\n' +
'    nginx.ingress.kubernetes.io/modsecurity-snippet: |\n' +
'      SecRuleEngine On\n' +
'      SecRule ARGS "@contains &lt;script&gt;" "id:1,deny,status:403"\n' +
'    # Rate limiting\n' +
'    nginx.ingress.kubernetes.io/limit-rps: "100"\n' +
'    nginx.ingress.kubernetes.io/limit-connections: "50"\n' +
'    # Proxy settings\n' +
'    nginx.ingress.kubernetes.io/proxy-body-size: "100m"\n' +
'    nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"\n' +
'    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"\n' +
'    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"\n' +
'    # CORS\n' +
'    nginx.ingress.kubernetes.io/enable-cors: "true"\n' +
'    nginx.ingress.kubernetes.io/cors-allow-origin: "*"\n' +
'    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"\n' +
'    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, Content-Type, X-Request-ID"\n' +
'    # ConfigMap settings\n' +
'    nginx.ingress.kubernetes.io/enable-access-log: "true"\n' +
'    nginx.ingress.kubernetes.io/enable-opentelemetry: "true"\n' +
'spec:\n' +
'  ingressClassName: nginx\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - secure.example.com\n' +
'      secretName: enterprise-tls\n' +
'  rules:\n' +
'    - host: secure.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: enterprise-service\n' +
'                port:\n' +
'                  number: 443'
        };

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
            let yaml = SAMPLE_PRESETS[preset] || SAMPLE_PRESETS.moderate;
            document.getElementById('yamlInput').value = yaml;
            document.getElementById('analyzerResults').textContent = '';
            document.getElementById('sampleDropdown').classList.remove('visible');
            let btn = document.querySelector('.sample-dropdown-btn');
            if (btn) btn.setAttribute('aria-expanded', 'false');
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
            p1.textContent = 'Paste your Ingress YAML above and click Analyze';
            empty.appendChild(p1);
            let p2 = document.createElement('p');
            p2.className = 'hint';
            p2.textContent = 'Drag & drop a .yaml file, or try "Load Sample" for an example';
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
            let annotationCount = (val.match(/nginx\.ingress\.kubernetes\.io\//g) || []).length;
            document.getElementById('statusLines').textContent = lineCount + ' line' + (lineCount !== 1 ? 's' : '');
            document.getElementById('statusDot').className = 'status-dot ' + (lineCount > 0 ? 'active' : 'inactive');
            let annStatus = document.getElementById('statusAnnotations');
            if (annotationCount > 0) {
                annStatus.style.display = '';
                document.getElementById('statusAnnotationCount').textContent = annotationCount + ' annotation' + (annotationCount !== 1 ? 's' : '') + ' detected';
            } else {
                annStatus.style.display = 'none';
            }
        }
        function updateYamlHighlight() {
            let textarea = document.getElementById('yamlInput');
            let highlight = document.getElementById('yamlHighlight');
            highlight.textContent = '';
            if (textarea.value) {
                highlight.appendChild(highlightYaml(textarea.value));
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
            if (e.key === 'Tab') {
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

            function closeMobileSidebar() {
                let sidebar = document.getElementById('sidebar');
                let backdrop = document.getElementById('sidebarBackdrop');
                let menuToggle = document.getElementById('menuToggle');
                if (sidebar) sidebar.classList.remove('open');
                if (backdrop) backdrop.classList.remove('visible');
                if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
                document.body.style.overflow = '';
            }

            let currentPage = 'getting-started';

            function showPage(id, opts) {
                opts = opts || {};
                let switching = (id !== currentPage);
                currentPage = id;

                // Toggle tool-page visibility
                document.querySelectorAll('.tool-page').forEach(function(p) { p.classList.remove('active'); });
                let page = document.getElementById('page-' + id);
                if (page) page.classList.add('active');

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

                // Update URL hash
                if (opts.updateHash !== false) {
                    history.replaceState(null, '', '#' + id);
                }

                // Announce page switch for screen readers
                let announcer = document.getElementById('page-announce');
                let pageNames = { 'getting-started': 'Getting Started', analyzer: 'Config Analyzer', reference: 'Reference Guide' };
                if (announcer && switching) {
                    announcer.textContent = 'Navigated to ' + (pageNames[id] || id);
                }

                // Update mobile breadcrumb
                let breadcrumb = document.getElementById('mobileBreadcrumb');
                if (breadcrumb) breadcrumb.textContent = pageNames[id] || id;

                // Only scroll to top when switching pages (unless caller handles scroll)
                if (switching && !opts.skipScroll) window.scrollTo(0, 0);
                closeMobileSidebar();
            }

            // Page link click handlers
            pageLinks.forEach(function(link) {
                link.addEventListener('click', function() {
                    showPage(this.getAttribute('data-page'));
                });
            });

            // Map sections to their parent pages
            let sectionPageMap = {
                overview: 'getting-started', 'why-migrate': 'getting-started', features: 'getting-started', installation: 'getting-started', checklist: 'getting-started', 'phased-migration': 'getting-started', resources: 'getting-started',
                differences: 'reference', 'mappings': 'reference', 'plus-mappings': 'reference', 'configmap-mappings': 'reference'
            };

            // Section link click handlers — switch to parent page + scroll
            sectionLinks.forEach(function(link) {
                link.addEventListener('click', function() {
                    let sectionId = this.getAttribute('data-section');
                    let targetPage = sectionPageMap[sectionId] || 'reference';
                    let wasOnTargetPage = (currentPage === targetPage);
                    // Ensure target page is visible (skip hash + scroll-to-top)
                    showPage(targetPage, { updateHash: false, skipScroll: true });
                    // Update hash to the section
                    history.replaceState(null, '', '#' + sectionId);

                    function scrollToSection() {
                        let target = document.getElementById(sectionId);
                        if (target) {
                            let topbarH = chromeHeight();
                            let y = target.getBoundingClientRect().top + window.pageYOffset - topbarH - 12;
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
                                let topbarH = chromeHeight();
                                let y = target.getBoundingClientRect().top + window.pageYOffset - topbarH - 12;
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
                                let parentPage = sectionPageMap[sectionId] || 'reference';
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

            // Restore page from URL hash on load
            let hash = location.hash.replace('#', '');
            if (hash) {
                let sectionLink = document.querySelector('.sidebar-link[data-section="' + hash + '"]');
                if (sectionLink) {
                    sectionLink.click();
                } else if (hash === 'getting-started' || hash === 'analyzer' || hash === 'reference') {
                    showPage(hash);
                }
            }
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
            let STORAGE_KEY = 'migrationChecklist';
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

            function toggle(li, index) {
                let state = loadState();
                let isChecked = li.classList.toggle('checked');
                li.setAttribute('aria-checked', isChecked ? 'true' : 'false');
                if (isChecked) { state[index] = true; } else { delete state[index]; }
                saveState(state);
            }

            // Restore saved state
            let state = loadState();
            for (let i = 0; i < items.length; i++) {
                if (state[i]) {
                    items[i].classList.add('checked');
                    items[i].setAttribute('aria-checked', 'true');
                }
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
    })();
