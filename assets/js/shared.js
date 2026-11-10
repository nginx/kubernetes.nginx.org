/* shared.js — behavior shared by index.html and the migration pages:
   dark-mode toggle, sidebar drawer, copy-to-clipboard, copyright year.
   Loaded before the per-page scripts (index.js / migration-*.js), which call these
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
    updateThemeColorMeta();
}

// The <head> ships a media-matched theme-color pair that follows the OS
// preference; the site's dark mode is class-based and user-togglable, so set
// both metas to the active mode's color to keep the browser's own UI in sync.
function updateThemeColorMeta() {
    let isDark = document.documentElement.classList.contains('dark-mode') || document.body.classList.contains('dark-mode');
    document.querySelectorAll('meta[name="theme-color"]').forEach(function(m) {
        m.setAttribute('content', isDark ? '#0F1E57' : '#FFFFFF');
    });
}

// One writer for the theme: both class hosts, the toggle's state, and the
// browser-UI colour. The toggle and the OS-change listener both come through here.
function applyTheme(isDark) {
    document.documentElement.classList.toggle('dark-mode', isDark);
    document.body.classList.toggle('dark-mode', isDark);
    updateDarkAriaLabel();
    updateThemeColorMeta();
}

function updateDarkAriaLabel() {
    let btn = document.getElementById('darkToggle');
    if (!btn) return;
    let isDark = document.documentElement.classList.contains('dark-mode') || document.body.classList.contains('dark-mode');
    // Constant accessible name + aria-pressed state — pairing an action-style
    // name ("Switch to light mode") with a pressed state reads contradictorily.
    btn.setAttribute('aria-label', 'Dark mode');
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
}

/* ── Screen-reader announcements ── */
let _announceTimeout = null;
// Single writer for the #page-announce live region: clears first (so identical
// consecutive messages re-announce) and cancels any pending write, so a stale
// message can't clobber a newer one.
function announce(text) {
    let announcer = document.getElementById('page-announce');
    if (!announcer) return;
    if (_announceTimeout) clearTimeout(_announceTimeout);
    announcer.textContent = '';
    _announceTimeout = setTimeout(function() {
        announcer.textContent = text;
        _announceTimeout = null;
    }, 50);
}

/* ── Moving focus to content ── */
// Land keyboard and screen-reader focus on a non-interactive target — a
// heading, a results region — after an in-page jump. Without this a jump
// scrolled the page but left focus behind on the control that triggered it,
// or on a page container when that control's page was hidden, so the next
// Tab started from the wrong place. tabindex=-1 makes the target focusable by
// script without adding it to the Tab order; preventScroll leaves the scroll
// to the caller, which knows the offset the fixed header needs.
function focusTarget(el) {
    if (!el) return;
    if (!el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
        el.setAttribute('tabindex', '-1');
    }
    el.focus({ preventScroll: true });
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
// `announceText` overrides the screen-reader message for buttons that copy
// something other than a code snippet (e.g. the analyzer's Copy All).
function copyToClipboard(text, btn, announceText) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
            showCopied(btn, announceText);
        }).catch(function() {
            fallbackCopy(text, btn, announceText);
        });
    } else {
        fallbackCopy(text, btn, announceText);
    }
}

// Give a button a dedicated label node and return it. Buttons that carry an
// icon must not have their whole textContent rewritten on copy — that deletes
// the icon — so the label is isolated here and the helpers below target it.
function addCopyLabel(btn, text) {
    let label = document.createElement('span');
    label.className = 'copy-label';
    label.textContent = text;
    btn.appendChild(label);
    return label;
}

// The node whose text the copy helpers rewrite: the dedicated label if the
// button has one, otherwise the button itself (plain text-only copy buttons).
function copyLabelNode(btn) {
    return btn.querySelector('.copy-label') || btn;
}

// Returns whether the copy actually succeeded — execCommand('copy') signals
// failure by returning false, not by throwing.
function fallbackCopy(text, btn, announceText) {
    let ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta);
    let ok = false;
    try {
        ta.select();
        ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    finally {
        document.body.removeChild(ta);
    }
    if (btn) { if (ok) showCopied(btn, announceText); else showCopyFailed(btn, announceText); }
    return ok;
}

// The original label, remembered on first use so the reset restores whatever
// the button actually said rather than assuming 'Copy'.
function restingLabel(btn) {
    let node = copyLabelNode(btn);
    if (btn._copyRestLabel === undefined) btn._copyRestLabel = node.textContent;
    return btn._copyRestLabel;
}

function showCopied(btn, announceText) {
    if (!btn) return;
    if (btn._copyTimeout) clearTimeout(btn._copyTimeout);
    let node = copyLabelNode(btn), rest = restingLabel(btn);
    node.textContent = 'Copied!';
    btn.classList.add('copied');
    announce(announceText || 'Code copied to clipboard');
    btn._copyTimeout = setTimeout(function() {
        node.textContent = rest;
        btn.classList.remove('copied');
    }, 2000);
}

function showCopyFailed(btn) {
    if (!btn) return;
    if (btn._copyTimeout) clearTimeout(btn._copyTimeout);
    let node = copyLabelNode(btn), rest = restingLabel(btn);
    node.textContent = 'Failed';
    // A cancelled success timer would otherwise leave the class behind forever.
    btn.classList.remove('copied');
    announce('Copy failed');
    btn._copyTimeout = setTimeout(function() {
        node.textContent = rest;
    }, 2000);
}

/* ── Shared wiring ── */
document.addEventListener('DOMContentLoaded', function() {
    initDarkMode();

    // Event banner: the top bar sits at --banner-h, so that has to be the
    // banner's real height. shared.css gives a per-breakpoint estimate for
    // readers without JS; the copy wraps at widths no breakpoint can predict,
    // so it is measured here and kept current as the viewport changes.
    let banner = document.getElementById('eventBanner');
    if (banner && document.body.classList.contains('has-banner') && 'ResizeObserver' in window) {
        new ResizeObserver(function() {
            document.documentElement.style.setProperty('--banner-h', banner.getBoundingClientRect().height + 'px');
        }).observe(banner);
    }

    // Copyright year
    let yearEl = document.getElementById('copyright-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    // Dark mode toggle
    let darkToggle = document.getElementById('darkToggle');
    if (darkToggle) {
        darkToggle.addEventListener('click', function() {
            let isDark = !document.body.classList.contains('dark-mode');
            applyTheme(isDark);
            try { localStorage.setItem('darkMode', isDark ? '1' : '0'); } catch (e) { /* storage blocked (e.g. private mode) */ }
        });
    }

    // Follow a live OS theme change, but only for a reader who has never
    // chosen one here: the <head> script picks the OS theme on load when
    // localStorage holds no choice, and until now nothing kept it in step
    // afterwards. Read at change time, so a toggle mid-session wins.
    let schemeMq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    let onSchemeChange = function(e) {
        let stored = null;
        try { stored = localStorage.getItem('darkMode'); } catch (err) { /* storage blocked */ }
        if (stored === null) applyTheme(e.matches);
    };
    if (schemeMq && schemeMq.addEventListener) schemeMq.addEventListener('change', onSchemeChange);
    else if (schemeMq && schemeMq.addListener) schemeMq.addListener(onSchemeChange);

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

    // Close the drawer when the viewport leaves the mobile breakpoint, so the
    // backdrop, scroll lock, and inert state don't linger while the menu toggle
    // is hidden (e.g. rotating a tablet with the drawer open).
    let drawerMq = window.matchMedia('(max-width: 900px)');
    let onDrawerChange = function(e) { if (!e.matches) closeSidebar(); };
    if (drawerMq.addEventListener) drawerMq.addEventListener('change', onDrawerChange);
    else if (drawerMq.addListener) drawerMq.addListener(onDrawerChange);
});
