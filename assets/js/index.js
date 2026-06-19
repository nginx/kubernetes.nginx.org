    /* index.js — behavior specific to the landing page (index.html): version
       auto-fetch, SPA product switching, entrance animation, YouTube posters.
       Shared chrome (dark mode, sidebar drawer, copy-to-clipboard, copyright
       year) lives in shared.js, which loads first and exposes those globals. */
    (function() {
        'use strict';

        /* ── Constants ── */
        let PRODUCTS = ['home', 'nginx-ingress-controller', 'nginx-gateway-fabric', 'migration-tool', 'ingress2gateway'];
        let PAGE_NAMES = {
            'home': 'Home',
            'nginx-ingress-controller': 'NGINX Ingress Controller',
            'nginx-gateway-fabric': 'NGINX Gateway Fabric',
            'migration-tool': 'Migration Tool',
            'ingress2gateway': 'ingress2gateway'
        };

        /* ── Auto-Fetch Versions ── */
        let VERSION_CONFIG = {
            nic: { repo: 'nginx/kubernetes-ingress',        fallback: { release: 'v5.5.1', helm: 'v2.6.1' } },
            ngf: { repo: 'nginx/nginx-gateway-fabric',      fallback: { release: 'v2.6.5', helm: 'v2.6.5' } },
            i2g: { repo: 'kubernetes-sigs/ingress2gateway',  fallback: { release: 'v1.1.0' } }
        };
        // Bump the cache key suffix when VERSION_CONFIG shape or applyVersions logic changes
        // so users don't apply stale payloads from previous schemas.
        let VERSION_CACHE_KEY = 'nginx_k8s_versions_v2';
        let VERSION_CACHE_TTL = 3600000; // 1 hour

        function readVersionCache() {
            try {
                let raw = localStorage.getItem(VERSION_CACHE_KEY);
                if (!raw) return null;
                let obj = JSON.parse(raw);
                if (obj && obj.ts && (Date.now() - obj.ts < VERSION_CACHE_TTL)) return obj.data;
            } catch (e) { /* corrupt or private browsing */ }
            return null;
        }

        function writeVersionCache(data) {
            try { localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data })); }
            catch (e) { /* quota or private browsing */ }
        }

        function applyVersions(data) {
            let els = document.querySelectorAll('[data-version]');
            for (let i = 0; i < els.length; i++) {
                let el = els[i];
                let parts = el.getAttribute('data-version').split('.');
                let product = parts[0], field = parts[1];
                if (data[product] && data[product][field]) {
                    let ver = data[product][field];
                    let fmt = el.getAttribute('data-version-format');
                    let vTag = ver.charAt(0) === 'v' ? ver : 'v' + ver;
                    if (fmt === 'bare') {
                        el.textContent = ver.replace(/^v/, '');
                    } else if (fmt === 'atv') {
                        el.textContent = '@' + vTag;
                    } else {
                        el.textContent = vTag;
                    }
                    if (el.tagName === 'A' && field === 'release' && VERSION_CONFIG[product]) {
                        el.href = 'https://github.com/' + VERSION_CONFIG[product].repo + '/releases/tag/' + vTag;
                    }
                }
            }
        }

        // Fetch the chart `version:` from a project's Helm chart at a specific tag.
        // Returns `null` if the chart can't be fetched or the version line is missing —
        // callers fall back to their own default. We use this for NIC because the chart
        // version isn't aligned with the controller release tag.
        function fetchChartVersion(repo, chartPath, tag) {
            let url = 'https://raw.githubusercontent.com/' + repo + '/' + tag + '/' + chartPath + '/Chart.yaml';
            return fetch(url).then(function(res) {
                if (!res.ok) return null;
                return res.text();
            }).then(function(text) {
                if (!text) return null;
                let m = text.match(/^version:\s*["']?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)["']?/m);
                return m ? 'v' + m[1] : null;
            }).catch(function() { return null; });
        }

        function fetchVersions() {
            let cached = readVersionCache();
            if (cached) { applyVersions(cached); return; }

            let data = {};

            function applyFallback(key) {
                data[key] = {};
                let fb = VERSION_CONFIG[key].fallback;
                for (let f in fb) { if (fb.hasOwnProperty(f)) data[key][f] = fb[f]; }
            }

            function loadProduct(key) {
                let cfg = VERSION_CONFIG[key];
                data[key] = {};
                return fetch('https://api.github.com/repos/' + cfg.repo + '/releases/latest')
                    .then(function(res) {
                        if (!res.ok) throw new Error(res.status);
                        return res.json();
                    })
                    .then(function(json) {
                        // Tag must be SemVer with optional `v` prefix (e.g. v5.4.2 or 1.0.0).
                        // Repos that publish prefixed tags (e.g. controller-v1.15.1) need their own
                        // VERSION_CONFIG entry with a bespoke parser.
                        let tag = json.tag_name;
                        if (!tag || !/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error('bad tag');
                        let vTag = tag.charAt(0) === 'v' ? tag : 'v' + tag;
                        data[key].release = vTag;

                        if (key === 'nic') {
                            // NIC's Helm chart version is decoupled from the controller release tag,
                            // so read it from the chart's Chart.yaml at that tag.
                            return fetchChartVersion(cfg.repo, 'charts/nginx-ingress', vTag).then(function(helm) {
                                data[key].helm = helm || cfg.fallback.helm || cfg.fallback.release;
                            });
                        }
                        if (key === 'ngf') {
                            // NGF tags the chart with the same version as the controller release.
                            data[key].helm = vTag;
                        }
                    })
                    .catch(function() { applyFallback(key); });
            }

            Promise.all(Object.keys(VERSION_CONFIG).map(loadProduct)).then(function() {
                writeVersionCache(data);
                applyVersions(data);
            });
        }

        /* ── Product Switching ── */
        function showProductFn(id, pushHash) {
            if (PRODUCTS.indexOf(id) === -1) return;
            if (typeof pushHash === 'undefined') pushHash = true;

            // Update sidebar active state
            document.querySelectorAll('.sidebar-link').forEach(function(l) {
                l.classList.remove('active');
                l.removeAttribute('aria-current');
            });
            let activeLink = document.querySelector('.sidebar-link[data-product="' + id + '"]');
            if (activeLink) {
                activeLink.classList.add('active');
                activeLink.setAttribute('aria-current', 'page');
            }

            // Update pages
            document.querySelectorAll('.product-page').forEach(function(p) {
                p.classList.remove('active');
            });
            let page = document.getElementById('page-' + id);
            if (page) {
                page.classList.add('active');
                animatePageEntrance(page);
            }

            // Announce for screen readers
            let announcer = document.getElementById('page-announce');
            if (announcer) {
                announcer.textContent = 'Navigated to ' + PAGE_NAMES[id];
            }

            // Update URL hash
            if (pushHash) {
                history.pushState(null, '', '#' + id);
            }

            // Update mobile breadcrumb
            let breadcrumb = document.getElementById('mobileBreadcrumb');
            if (breadcrumb) {
                breadcrumb.textContent = PAGE_NAMES[id];
            }

            // Close mobile sidebar
            closeSidebar();

            // Scroll to top
            window.scrollTo(0, 0);
        }

        /* ── Entrance Animation ── */
        let animationTimers = [];
        let prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let _animatingPage = null;
        function animatePageEntrance(pageEl) {
            animationTimers.forEach(function(id) { clearTimeout(id); });
            animationTimers = [];
            // Strip leftover animate-in/visible state from the previously animating page so a
            // rapid back-and-forth doesn't leave items invisible on the page we just came from.
            if (_animatingPage && _animatingPage !== pageEl) {
                _animatingPage.querySelectorAll('.animate-in').forEach(function(el) {
                    el.classList.remove('animate-in', 'visible');
                });
            }
            _animatingPage = pageEl;
            let items = pageEl.querySelectorAll('.feature-card, .code-section, .info-box, .cta-row, .key-details, .preview-card, .compat-table, .annotation-grid, .section-heading, .project-card');
            if (prefersReducedMotion) {
                items.forEach(function(el) { el.classList.remove('animate-in'); });
                return;
            }
            items.forEach(function(el, i) {
                el.classList.add('animate-in');
                el.classList.remove('visible');
                animationTimers.push(setTimeout(function() {
                    el.classList.add('visible');
                }, 40 + i * 40));
            });
        }

        /* ── Copy to Clipboard ── */
        function copyCodeBlock(btn) {
            let block = btn.closest('.code-block');
            if (!block) return;
            let code = block.querySelector('code');
            if (!code) return;
            let text = code.textContent;
            copyToClipboard(text, btn);
        }

        /* ── Hash Routing ── */
        function handleHash() {
            let hash = location.hash.slice(1);
            // Treat an empty or unknown hash as Home, so Back/Forward to the bare
            // URL restores the landing view instead of leaving the last product shown.
            let id = PRODUCTS.indexOf(hash) !== -1 ? hash : 'home';
            showProductFn(id, false);
        }

        window.addEventListener('hashchange', handleHash);
        window.addEventListener('popstate', handleHash);

        /* ── Event Listeners ── */
        document.addEventListener('DOMContentLoaded', function() {
            // Sidebar link click handlers
            document.querySelectorAll('.sidebar-link[data-product]').forEach(function(link) {
                link.addEventListener('click', function() {
                    let product = this.getAttribute('data-product');
                    showProductFn(product);
                });
            });

            // YouTube poster click-to-play — swaps the poster img for the real iframe on first activation.
            document.querySelectorAll('.feature-card[data-yt-id]').forEach(function(card) {
                let poster = card.querySelector('.video-poster');
                if (!poster) return;
                function activate() {
                    let id = card.getAttribute('data-yt-id');
                    let title = card.getAttribute('data-yt-title') || 'YouTube video';
                    let iframe = document.createElement('iframe');
                    iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1';
                    iframe.title = title;
                    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
                    iframe.allowFullscreen = true;
                    poster.replaceWith(iframe);
                }
                poster.addEventListener('click', activate);
                poster.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
                });
            });

            // Project cards are real anchors — let modifier-clicks (cmd/ctrl/middle/shift)
            // open in a new tab, but intercept plain clicks to use the SPA route so we
            // skip a full page reload and pushState the hash ourselves.
            document.querySelectorAll('.project-card[data-navigate]').forEach(function(card) {
                card.addEventListener('click', function(e) {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
                    e.preventDefault();
                    showProductFn(this.getAttribute('data-navigate'));
                });
            });

            // Brand click goes to home
            let brand = document.querySelector('.topbar-brand');
            if (brand) {
                brand.addEventListener('click', function(e) {
                    e.preventDefault();
                    showProductFn('home');
                });
            }

            // Copy button click handlers
            document.querySelectorAll('.copy-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    copyCodeBlock(this);
                });
            });

            // Restore from hash or default to home
            let hash = location.hash.slice(1);
            if (PRODUCTS.indexOf(hash) !== -1) {
                showProductFn(hash, false);
            } else {
                showProductFn('home', false);
            }

            // Fetch latest versions from GitHub
            fetchVersions();
        });
    })();
