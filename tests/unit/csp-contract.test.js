// Every URL scheme the built artifact references must be permitted by the
// corresponding CSP directive, in every deployment config that ships a CSP.
//
// Why this file exists. Inlining the two typefaces as base64 `@font-face` sources
// shipped against `font-src 'self'`, and `'self'` does not cover the `data:` scheme
// — it has to be listed explicitly, exactly as the neighbouring `img-src data:`
// already did. Both fonts were blocked in the deployed configuration.
//
// The failure mode is what makes this worth a gate rather than a code review note.
// A blocked `@font-face` does not render tofu: the stack falls through to
// `-apple-system` / Menlo and produces perfectly acceptable text. That is
// bit-for-bit the bug the self-hosting change exists to fix, so the deployed app
// would have gone on rendering platform fonts, looked correct, and left no evidence
// except a console violation nobody reads. Meanwhile every local check passes,
// because the CSP lives only in the deploy configs — `npm run local`, a plain
// static server, and `file://` all serve the artifact with no CSP at all. Browser
// verification is only meaningful *through a server that sends the real header*.
//
// Deliberately generalized past fonts: it maps schemes to directives from where
// they appear in the artifact, so a future inlined `data:` image, a `blob:` worker,
// or a remote stylesheet is caught by the same assertion.
//
// Stays `.js` for the same reason as the other node-tooling specs: it reads repo
// files and builds the artifact through node: APIs, and the project has no
// @types/node (see CLAUDE.md / ADR-0002).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildArtifact } from '../../build/build.mjs';

const root = resolve(process.cwd());

/** Files that ship a Content-Security-Policy to a browser. Both must agree: the
 *  ClickHouse `<http_handlers>` rule and the Caddy container both serve the SPA,
 *  and a scheme allowed by one but not the other is a deployment-shaped bug that
 *  only shows up for whichever half a given user installed. */
const CSP_SOURCES = [
  'deploy/http_handlers.xml',
  'deploy/caddy/Caddyfile',
];

/** Pull the policy text out of an XML element or a Caddy `header` line. */
const readCsp = (file) => {
  const text = readFileSync(resolve(root, file), 'utf8');
  const xml = /<Content-Security-Policy>([\s\S]*?)<\/Content-Security-Policy>/.exec(text);
  if (xml) return xml[1].trim();
  const caddy = /Content-Security-Policy\s+"([^"]+)"/.exec(text);
  if (caddy) return caddy[1].trim();
  throw new Error(`no Content-Security-Policy found in ${file}`);
};

/** `{ directive: [source, ...] }` */
const parseCsp = (policy) => Object.fromEntries(
  policy.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [directive, ...sources] = part.split(/\s+/);
    return [directive, sources];
  }),
);

/** Schemes the built artifact references, grouped by the directive that governs
 *  them. Scans the WHOLE artifact, not just src/styles.css: the favicon lives in
 *  build/template.html and CodeMirror injects a `background-image: url(data:…)`
 *  from the JS bundle, so a CSS-only scan would miss both and report a false all-clear.
 *
 *  `url()` inside an `@font-face` block is a font; every other scheme-bearing
 *  reference here is an image (background-image, favicon, <img>). */
const artifactSchemes = (html) => {
  const out = { 'font-src': new Set(), 'img-src': new Set() };
  // Strip @font-face blocks first, recording their schemes, so the remaining
  // url()s can be attributed without ambiguity.
  const rest = html.replace(/@font-face\s*\{([^}]*)\}/g, (_, body) => {
    for (const m of body.matchAll(/url\(\s*["']?([a-zA-Z][a-zA-Z0-9+.-]*):/g)) {
      out['font-src'].add(`${m[1]}:`);
    }
    return '';
  });
  for (const m of rest.matchAll(/url\(\s*\\?["']?([a-zA-Z][a-zA-Z0-9+.-]*):/g)) {
    out['img-src'].add(`${m[1]}:`);
  }
  // Favicon and any <img>: `href=`/`src=` carrying an explicit scheme.
  for (const m of rest.matchAll(/(?:href|src)=["']([a-zA-Z][a-zA-Z0-9+.-]*):/g)) {
    // http(s) links are navigations (GitHub, docs), not subresource loads — CSP
    // governs those under navigate-to/frame-src, not img-src.
    if (m[1] !== 'http' && m[1] !== 'https' && m[1] !== 'mailto') out['img-src'].add(`${m[1]}:`);
  }
  return out;
};

describe('CSP permits every scheme the artifact references', () => {
  it('finds the schemes it is supposed to be checking', async () => {
    // Guards the extraction: if a refactor stops matching, the assertions below
    // would silently pass on an empty set — the same shape of hole that let
    // `font-src 'self'` through in the first place.
    const { html } = await buildArtifact();
    const schemes = artifactSchemes(html);
    expect([...schemes['font-src']]).toEqual(['data:']);
    // The favicon and CodeMirror's tab-highlight background are both data: URIs.
    expect([...schemes['img-src']]).toContain('data:');
  });

  for (const file of CSP_SOURCES) {
    it(`${file} permits them`, async () => {
      const { html } = await buildArtifact();
      const schemes = artifactSchemes(html);
      const csp = parseCsp(readCsp(file));

      const failures = [];
      for (const [directive, needed] of Object.entries(schemes)) {
        for (const scheme of needed) {
          const sources = csp[directive] || csp['default-src'] || [];
          // A scheme source has to be listed literally. `'self'` is an origin
          // match and never covers a non-network scheme like data: or blob:.
          if (!sources.includes(scheme)) {
            failures.push(`${directive} must list ${scheme} (has: ${sources.join(' ') || '<nothing>'})`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('keeps every shipped CSP in agreement on its directives', async () => {
    // connect-src legitimately differs (the Caddyfile interpolates
    // ${CONNECT_SRC}); everything else must match, or a scheme fix applied to one
    // deployment silently leaves the other broken.
    const policies = CSP_SOURCES.map((f) => parseCsp(readCsp(f)));
    const comparable = (csp) => Object.fromEntries(
      Object.entries(csp).filter(([d]) => d !== 'connect-src').map(([d, s]) => [d, s.join(' ')]),
    );
    const [first, ...others] = policies.map(comparable);
    for (const other of others) expect(other).toEqual(first);
  });

  it('still denies everything by default', async () => {
    // The value of this policy is `default-src 'none'`. A future fix must widen a
    // specific directive, never relax the default.
    for (const file of CSP_SOURCES) {
      expect(parseCsp(readCsp(file))['default-src']).toEqual(["'none'"]);
    }
  });
});
