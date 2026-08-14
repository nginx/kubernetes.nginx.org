# Fonts

`InterVariable-subset.woff2` — the site's only webfont. Inter is the typeface specified by
the **F5 Design System (F5DS)**, the design system for F5 Distributed Cloud product UI; this
site follows its type standard rather than the F5 marketing brand faces (Neusa Next Pro Wide /
Proxima Nova), which are license-gated on brand.f5.com and could never be self-hosted here.

Self-hosted rather than loaded from a CDN, which keeps the repo's no-third-party-runtime
-dependency rule intact. NGINX's own docs property does the same — `nginxinc/nginx-hugo-theme`
carries `static/css/inter/font-files/InterVariable.woff2` — though it ships the file unsubset
and without the license.

## Provenance

| | |
|---|---|
| Upstream | [rsms/inter](https://github.com/rsms/inter) release **v4.1** (2024-11-16) |
| Source file | `web/InterVariable.woff2` from `Inter-4.1.zip`, 352,240 bytes |
| License | SIL Open Font License 1.1 — `OFL.txt`, copied verbatim from the release's `LICENSE.txt` |

The OFL requires the license to travel with the font, so `OFL.txt` must stay alongside the
woff2. It is not referenced by any stylesheet; it exists to satisfy the license.

## What the subset contains

One variable file covering the whole 100–900 weight range, so every weight the site uses comes
from a single 112 KB download. Both axes survive subsetting (`wght` 100–900, `opsz` 14–32), as
do all 38 OpenType feature tables.

Glyph coverage is the Google-Fonts `latin` range plus the arrows, geometric shapes, and check
marks the site actually renders — `→` alone appears 29 times in the migration tool's mapping
tables and is **not** in either the `latin` or `latin-ext` range, so a stock subset would drop
it. Note `⚙`, `☐`, and `☑` are not in Inter at all and fall back to a system font; that is
upstream behaviour, not a subsetting artifact.

| Build | Bytes | Glyphs |
|---|---|---|
| Upstream v4.1 | 352,240 | 2,926 |
| **This subset** | **112,148** | **879** |

## Regenerating

Needed when upgrading Inter, or if the site starts rendering a character outside the ranges
below (the symptom is one glyph rendering in a different face). Requires `fonttools`
(`brew install fonttools`).

```sh
curl -sLO https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
unzip -o -j Inter-4.1.zip web/InterVariable.woff2 LICENSE.txt -d inter

pyftsubset inter/InterVariable.woff2 \
  --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD,U+2190-21FF,U+2260,U+2264-2265,U+25A0-25FF,U+2713-2718,U+2610-2611' \
  --layout-features='*' \
  --flavor=woff2 \
  --output-file=assets/fonts/InterVariable-subset.woff2

cp inter/LICENSE.txt assets/fonts/OFL.txt
```

`--layout-features='*'` is load-bearing: the default feature set drops `calt`, `tnum`, and the
`ss0*` stylistic sets that `shared.css` enables.

To find every non-ASCII character the site renders (the input to the `--unicodes` list):

```sh
python3 - <<'EOF'
import glob, collections
c = collections.Counter()
for p in ['index.html', 'ingress-nginx-migration.html'] + glob.glob('assets/[cj]s*/*'):
    for ch in open(p, encoding='utf-8').read():
        if ord(ch) > 0x7F: c[ch] += 1
for ch, n in c.most_common(): print(f"U+{ord(ch):04X} {ch!r} x{n}")
EOF
```

Ignore `═` and `─` in that output — they are section dividers in CSS/JS comments, never
rendered, and deliberately outside the subset.

## Metric fallback

`shared.css` pairs the webfont with an `'Inter Fallback'` face built on local Arial with metric
overrides, so text laid out before the woff2 arrives occupies the same space and does not shift
on swap. Those override values are derived from these exact files; if you regenerate the subset,
recompute them:

```sh
python3 - <<'EOF'
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
S = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 "
def avg(f):
    upm, cm, hm = f['head'].unitsPerEm, f.getBestCmap(), f['hmtx']
    w = [hm[cm[ord(c)]][0]/upm for c in S if ord(c) in cm]
    return sum(w)/len(w)
def m(f):
    h, upm = f['hhea'], f['head'].unitsPerEm
    return h.ascender/upm, -h.descender/upm, h.lineGap/upm
for wght, arial in ((400, 'Arial.ttf'), (700, 'Arial Bold.ttf')):
    inst = instancer.instantiateVariableFont(
        TTFont('assets/fonts/InterVariable-subset.woff2'), {'wght': wght, 'opsz': 14})
    a, d, g = m(inst)
    sa = avg(inst) / avg(TTFont(f'/System/Library/Fonts/Supplemental/{arial}'))
    print(f"{wght}: size-adjust {sa*100:.2f}%  ascent {a/sa*100:.2f}%  "
          f"descent {d/sa*100:.2f}%  line-gap {g/sa*100:.2f}%")
EOF
```
