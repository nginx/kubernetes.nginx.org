#!/usr/bin/env bash
# Render a page and write a PNG, plus an optional DOM measurement.
#
# None of the nine checks can see a rendered page; AGENTS.md says so and then
# says "render and look". This is the missing half of that instruction.
#
# Lives under .github/ because GitHub Pages publishes this branch.
#
#   .github/scripts/shot.sh index.html                        # light, desktop
#   .github/scripts/shot.sh index.html --dark
#   .github/scripts/shot.sh index.html#ingress2gateway        # a specific view
#   .github/scripts/shot.sh ingress-nginx-migration.html --width 900
#   .github/scripts/shot.sh index.html --measure '.sidebar-link-name'
#
# It refuses to pretend, because the failure this exists to prevent is an agent
# reporting "verified visually" on the strength of a command that never rendered
# anything. No browser is exit 3; a page that did not load is exit 4, checked
# before rendering rather than inferred from the artifact afterwards.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${SHOT_OUT:-${TMPDIR:-/tmp}}"
PORT="${SHOT_PORT:-8899}"

TARGET="${1:-index.html}"; shift || true
WIDTH=1400; HEIGHT=""; DARK=0; MEASURE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dark) DARK=1 ;;
    --width) WIDTH="$2"; shift ;;
    --height) HEIGHT="$2"; shift ;;
    --measure) MEASURE="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── Find a browser. Do not assume PATH: on macOS Chrome is not on it, and on a
#    containerised runner there may be no browser at all.
CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome 2>/dev/null)" \
  "$(command -v chromium 2>/dev/null)" \
  "$(command -v chromium-browser 2>/dev/null)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && CHROME="$candidate" && break
done

if [ -z "$CHROME" ]; then
  cat >&2 <<'MSG'
NO-BROWSER: no Chrome or Chromium found.

This machine cannot render the page. Say so explicitly in your summary and fall
back to diffing structured output against a pristine worktree — do NOT report
the static checks as visual verification. They cannot see layout, and that is
the entire reason this script exists.
MSG
  exit 3
fi

# ── Serve the repo. file:// mostly works because every asset path is relative,
#    but a server is closer to production and avoids origin differences.
python3 -m http.server "$PORT" --directory "$ROOT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1

WORK="$(mktemp -d)"
PAGE="${TARGET%%#*}"
HASH=""
case "$TARGET" in *#*) HASH="#${TARGET#*#}" ;; esac

# ── Theme. Headless Chrome reports prefers-color-scheme: dark on at least some
#    machines, so an unmodified run may render the DARK theme — and
#    --force-dark-mode does NOT drive this site, whose dark mode is a class
#    toggled from localStorage. Seeding the key ahead of the inline
#    flash-prevention script is what actually decides the theme.
SEED="0"; [ "$DARK" = "1" ] && SEED="1"
python3 - "$ROOT/$PAGE" "$WORK/page.html" "$SEED" "$MEASURE" <<'PY'
import sys
src, dst, seed, measure = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
html = open(src, encoding='utf-8').read()
inject = ("<script>try{localStorage.setItem('darkMode','%s')}catch(e){}</script>\n    " % seed)
marker = "<script>try{let s=localStorage.getItem('darkMode')"
html = html.replace(marker, inject + marker, 1)

# Publish the laid-out document height as an attribute, so a --dump-dom pass
# can read it and size the screenshot window to the whole page.
html = html.replace('</body>', """
<script>
window.addEventListener('load', function () { setTimeout(function () {
  document.body.setAttribute('data-doc-height',
    String(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)));
}, 350); });
</script>
</body>""", 1)
if measure:
    probe = """
<script>
window.addEventListener('load', function () { setTimeout(function () {
  var out = [];
  document.querySelectorAll(%s).forEach(function (e) {
    var r = e.getBoundingClientRect();
    out.push({ text: (e.textContent || '').trim().slice(0, 60),
               w: +r.width.toFixed(1), h: +r.height.toFixed(1),
               x: +r.left.toFixed(1), y: +r.top.toFixed(1),
               clipped: e.scrollWidth > Math.ceil(r.width) + 1 });
  });
  var d = document.createElement('div');
  d.id = 'SHOT_MEASURE';
  d.textContent = JSON.stringify({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    nodes: out
  });
  document.body.appendChild(d);
}, 400); });
</script>
""" % repr(measure).replace("'", '"')
    html = html.replace('</body>', probe + '</body>')
open(dst, 'w', encoding='utf-8').write(html)
PY
cp "$WORK/page.html" "$ROOT/.shot-tmp.html"
trap 'kill $SERVER 2>/dev/null; rm -f "$ROOT/.shot-tmp.html"' EXIT

URL="http://localhost:$PORT/.shot-tmp.html$HASH"
STAMP="$(basename "$PAGE" .html)$([ "$DARK" = 1 ] && echo -dark)-${WIDTH}"
PNG="$OUT_DIR/$STAMP.png"

# ── Prove the page is actually being served, and served by US, before rendering
#    anything. A non-empty PNG is not evidence: Chrome screenshots a connection
#    error or someone else's 404 as happily as a page, so if the port was
#    already taken — or the server failed to bind — the run reports success and
#    hands back a picture of nothing. Grep for a string only the injected copy
#    can contain.
if ! python3 - "$URL" <<'PY'
import sys, urllib.request
try:
    body = urllib.request.urlopen(sys.argv[1], timeout=5).read().decode('utf-8', 'replace')
except Exception as exc:
    print(exc, file=sys.stderr)
    sys.exit(1)
sys.exit(0 if 'data-doc-height' in body else 1)
PY
then
  cat >&2 <<MSG
FAILED: $URL is not serving this repo's page.

Something else is answering on port $PORT, or the server could not bind to it.
Nothing was rendered, so do NOT report a visual check. Set SHOT_PORT to a free
port and run again.
MSG
  exit 4
fi

# `timeout` because Chrome does not always exit after writing its artifact; the
# PNG is complete regardless, so a timeout here is not a failure.
TIMEOUT=""
command -v timeout >/dev/null && TIMEOUT="timeout 30"
command -v gtimeout >/dev/null && TIMEOUT="gtimeout 30"

# --screenshot captures the VIEWPORT, not the page, and it captures it at scroll
# position zero. Deep-linking to a hash scrolls the document, so a fixed-height
# capture of a 4,751px page comes back almost entirely blank — the content has
# moved out of the captured band. Sizing the window to the document avoids both
# problems at once, so unless a height was asked for explicitly, measure first.
if [ -z "$HEIGHT" ]; then
  DOC_H="$($TIMEOUT "$CHROME" --headless=new --disable-gpu --no-sandbox \
    --window-size="$WIDTH,1200" --virtual-time-budget=6000 --dump-dom "$URL" 2>/dev/null \
    | grep -o 'data-doc-height="[0-9]*"' | head -1 | grep -o '[0-9]*')"
  if [ -n "${DOC_H:-}" ] && [ "$DOC_H" -gt 1200 ] 2>/dev/null; then
    # Cap it: a 30,000px PNG is not something anyone reads, and some builds
    # refuse to allocate it.
    HEIGHT=$([ "$DOC_H" -gt 8000 ] && echo 8000 || echo "$DOC_H")
    [ "$DOC_H" -gt 8000 ] && echo "note: page is ${DOC_H}px tall; capturing the first 8000px." >&2
  else
    HEIGHT=1200
  fi
fi

$TIMEOUT "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size="$WIDTH,$HEIGHT" --virtual-time-budget=6000 \
  --screenshot="$PNG" "$URL" >/dev/null 2>&1

if [ -n "$MEASURE" ]; then
  $TIMEOUT "$CHROME" --headless=new --disable-gpu --no-sandbox \
    --window-size="$WIDTH,$HEIGHT" --virtual-time-budget=6000 \
    --dump-dom "$URL" 2>/dev/null \
    | grep -o '<div id="SHOT_MEASURE">[^<]*' | sed 's/<div id="SHOT_MEASURE">//' \
    | python3 -m json.tool 2>/dev/null || echo "(measurement probe produced nothing)"
fi

if [ ! -s "$PNG" ]; then
  echo "FAILED: no PNG written. The page may not have loaded from $URL" >&2
  exit 1
fi

echo "wrote $PNG  (${WIDTH}x${HEIGHT}, $([ "$DARK" = 1 ] && echo dark || echo light))"
if [ "$WIDTH" -lt 500 ]; then
  cat <<'MSG'

NOTE: macOS clamps the headless viewport to roughly 500px, so a width below
that renders at 500 and crops the PNG — which looks exactly like horizontal
overflow that is not there. Use --measure with an iframe probe for phone
widths, or trust the CSS breakpoints rather than the image.
MSG
fi
