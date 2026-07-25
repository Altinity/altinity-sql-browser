// Inline the two brand typefaces into the single-file artifact as @font-face
// rules with base64 `data:` sources.
//
// Why this exists: DESIGN.md names Inter (interface) and JetBrains Mono (SQL,
// values, identifiers, measurement) as the product's typefaces, but for a long
// while the stylesheet only *referenced* them by name. With no @font-face and
// no CDN link (hard rule 4 forbids third-party requests), they rendered only for
// the minority of users who happened to have them installed locally — everyone
// else silently got the platform UI face and Menlo/Consolas. The design contract
// was unenforceable. These rules make it real without adding a network request.
//
// Subset: **latin only**, upright only, variable weight axis.
//   • latin covers the whole product UI and the ASCII identifiers/SQL that make
//     up the overwhelming majority of what the data font renders.
//   • `unicode-range` is kept so codepoints *outside* the subset (Cyrillic, CJK,
//     and the ⌘/↵/→ glyphs, none of which are in the latin range) fall through
//     the stack to the platform font instead of rendering tofu. A Cyrillic result
//     cell getting the system mono is correct behavior, not a gap.
//   • Italic faces are deliberately NOT shipped: they would roughly double the
//     font payload to serve eight secondary uses (schema comments, stale-value
//     hints, Markdown <em>). The browser synthesizes an oblique for those.
//
// Variable (`wght 100 900`) rather than four static cuts: one file per family
// covers 400/500/600/700, which is cheaper than four subsets and keeps a single
// decode.
//
// Both faces are SIL OFL 1.1; their notices ship in THIRD-PARTY-NOTICES.md.
// Source packages are **dev** dependencies (@fontsource-variable/*) — the same
// arrangement as Ajv, which is dev-only and contributes generated output to the
// artifact rather than shipping its engine.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// The latin subset range, copied from @fontsource-variable/*/wght.css. Identical
// for both families (both are cut from the same Google Fonts subset definition).
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,'
  + 'U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,'
  + 'U+FEFF,U+FFFD';

// `family` is the name src/styles.css already references in --ui / --mono, so
// declaring it here shadows any same-named font installed on the user's machine
// and makes rendering deterministic across platforms — which is the point.
export const FONTS = [
  {
    family: 'Inter',
    file: 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  },
  {
    family: 'JetBrains Mono',
    file: 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  },
];

/** Total woff2 bytes the artifact is allowed to carry, before base64 expansion.
 *  Asserted by tests/unit/typography-contract.test.ts so a future subset change
 *  (adding latin-ext, or an italic cut) has to be a deliberate, reviewed edit
 *  rather than a silent 40 KB of artifact growth. */
export const FONT_BYTE_BUDGET = 96 * 1024;

/** Read the woff2 files and return the CSS text to splice in place of the
 *  `/*__FONTS__*\/` token at the top of src/styles.css. Returns the rules plus
 *  the raw byte total so the build and the size report can both report it. */
export async function buildFontFaces() {
  let rawBytes = 0;
  const rules = [];
  for (const { family, file } of FONTS) {
    const buf = await readFile(resolve(root, file));
    rawBytes += buf.byteLength;
    rules.push(`@font-face{`
      + `font-family:'${family}';`
      + `font-style:normal;`
      + `font-weight:100 900;`
      + `font-display:swap;`
      + `src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');`
      + `unicode-range:${LATIN}`
      + `}`);
  }
  return { css: rules.join('\n'), rawBytes };
}
