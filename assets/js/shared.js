/* shared.js — chrome behavior shared by index.html and ingress-nginx-migration.html:
   dark-mode toggle, sidebar drawer, copy-to-clipboard, copyright year.
   Loaded before the per-page script (index.js / migration.js), which call these
   as globals. Classic script (not a module) so the functions stay global and
   resolve from each page's IIFE. */
'use strict';

/* ── Dark Mode ── */
function initDarkMode() {
    // Sync body class from documentElement (set by the inline <head> flash-prevention script)
    if (document.documentElement.classList.contains('dark-mode')) {
        document.body.classList.add('dark-mode');
    }
    updateDarkAriaLabel();
}

function updateDarkAriaLabel() {
    let btn = document.getElementById('darkToggle');
    if (!btn) return;
    let isDark = document.documentElement.classList.contains('dark-mode') || document.body.classList.contains('dark-mode');
    btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
}

/* ── Sidebar drawer (mobile) ── */
function openSidebar() {
    let sidebar = document.getElementById('sidebar');
    let backdrop = document.getElementById('sidebarBackdrop');
    let toggle = document.getElementById('menuToggle');
    if (sidebar) sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('visible');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    // Take the content behind the drawer out of the tab order / a11y tree.
    let main = document.querySelector('.main');
    if (main) main.setAttribute('inert', '');
    if (sidebar) { let firstLink = sidebar.querySelector('a, button'); if (firstLink) firstLink.focus(); }
}

function closeSidebar() {
    let sidebar = document.getElementById('sidebar');
    // No-op (and don't steal focus) when the drawer isn't open — e.g. Escape on desktop.
    if (!sidebar || !sidebar.classList.contains('open')) return;
    let backdrop = document.getElementById('sidebarBackdrop');
    let toggle = document.getElementById('menuToggle');
    sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('visible');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    let main = document.querySelector('.main');
    if (main) main.removeAttribute('inert');
    if (toggle) toggle.focus();
}

/* ── Copy to Clipboard ── */
function copyToClipboard(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
            showCopied(btn);
        }).catch(function() {
            fallbackCopy(text, btn);
        });
    } else {
        fallbackCopy(text, btn);
    }
}

function fallbackCopy(text, btn) {
    let ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta);
    try {
        ta.select();
        document.execCommand('copy');
        showCopied(btn);
    } catch (e) { /* silent */ }
    finally {
        document.body.removeChild(ta);
    }
}

function showCopied(btn) {
    if (!btn) return;
    if (btn._copyTimeout) clearTimeout(btn._copyTimeout);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    let announcer = document.getElementById('page-announce');
    if (announcer) announcer.textContent = 'Code copied to clipboard';
    btn._copyTimeout = setTimeout(function() {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
        if (announcer) announcer.textContent = '';
    }, 2000);
}

/* ── Shared chrome wiring ── */
document.addEventListener('DOMContentLoaded', function() {
    initDarkMode();

    // Copyright year
    let yearEl = document.getElementById('copyright-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    // Dark mode toggle
    let darkToggle = document.getElementById('darkToggle');
    if (darkToggle) {
        darkToggle.addEventListener('click', function() {
            let isDark = !document.body.classList.contains('dark-mode');
            document.documentElement.classList.toggle('dark-mode', isDark);
            document.body.classList.toggle('dark-mode', isDark);
            try { localStorage.setItem('darkMode', isDark ? '1' : '0'); } catch (e) { /* storage blocked (e.g. private mode) */ }
            updateDarkAriaLabel();
        });
    }

    // Menu toggle (sidebar drawer)
    let menuToggle = document.getElementById('menuToggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', function() {
            let sidebar = document.getElementById('sidebar');
            if (sidebar && sidebar.classList.contains('open')) {
                closeSidebar();
            } else {
                openSidebar();
            }
        });
    }

    // Sidebar backdrop click + Escape key
    let backdrop = document.getElementById('sidebarBackdrop');
    if (backdrop) {
        backdrop.addEventListener('click', closeSidebar);
    }
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeSidebar();
    });
});
