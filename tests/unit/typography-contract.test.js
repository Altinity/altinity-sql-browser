// The typography contract: src/styles.css must express its type system through
// the --text-* / --fw-* / --lh-* tokens, those tokens must agree with DESIGN.md,
// and the colour tokens the type sits on must clear WCAG 2.2 AA.
//
// Why this file exists. The repo already holds every module at 100% per-file
// coverage, and that gate found none of the following, because none of it is
// behaviour:
//   • 231 raw font-size literals across 22 distinct values, 11 of them inside a
//     4px range, including five below the documented 11px floor;
//   • --fg-faint at 2.55–3.66:1 in both themes, carrying most of the smallest
//     text in the product;
//   • the accent at 3.83:1 as text on dark backgrounds, and 4.10:1 on light chips;
//   • six surfaces (workspace-not-found, workspace-loading, two dashboard empty
//     states, the linked-tab conflict chooser, and the query-tab external-change
//     marker) with NO css rule at all, so they rendered in user-agent typography —
//     32px h1s, 13.333px Arial buttons with `2px outset` borders.
// conflict-resolution.ts had a passing unit test the entire time it shipped
// unstyled. Behaviour coverage cannot see a missing stylesheet, so the contract
// gets its own gate.
//
// Stays `.js` rather than `.ts` for the same reason as schema-build.test.js and
// size-report.test.js: it reads repo files through node: APIs, and the project
// has no @types/node (a deliberate deferral — see CLAUDE.md / ADR-0002).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FONTS, FONT_BYTE_BUDGET, buildFontFaces } from '../../build/fonts.mjs';

const root = resolve(process.cwd());
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const design = readFileSync(resolve(root, 'DESIGN.md'), 'utf8');

/** The `:root` block, which is where every token must be defined. */
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));

/** Declarations only — comments stripped, so prose that mentions a px value
 *  (and the token definitions' own trailing comments) can never be mistaken for
 *  a declaration. */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Everything after the token block: the rules that must consume tokens. */
const rules = declarations.slice(declarations.indexOf('*, *::before'));

const tokenValues = (prefix) => {
  const out = {};
  for (const m of rootBlock.matchAll(new RegExp(`(--${prefix}-[\\w-]+):\\s*([^;]+);`, 'g'))) {
    out[m[1]] = m[2].trim();
  }
  return out;
};

const relativeLuminance = (hex) => {
  const h = hex.replace('#', '');
  const channel = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
};

const contrast = (a, b) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Composite a translucent colour over an opaque one, so a token defined as
 *  rgba() can still be measured against the plane it actually sits on. */
const over = (rgba, base) => {
  const [r, g, b, a = 1] = rgba.match(/[\d.]+/g).map(Number);
  const bs = base.replace('#', '');
  const mix = (i, ch) => Math.round(ch * a + parseInt(bs.slice(i, i + 2), 16) * (1 - a));
  return `#${[mix(0, r), mix(2, g), mix(4, b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

/** Pull a token's value out of a theme block ([data-theme='dark'] or ['light']),
 *  falling back to the :root definition. rgba() values (the warn/error tints) are
 *  composited over that theme's canvas so they can be compared as real colours. */
const themeToken = (theme, name) => {
  const start = declarations.indexOf(`[data-theme='${theme}'] {`);
  const block = declarations.slice(start, declarations.indexOf('\n}', start));
  const find = (text) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6}|rgba?\\([^)]+\\));`).exec(text);
  const hit = find(block) || find(rootBlock);
  if (!hit) throw new Error(`no value for ${name} in ${theme} or :root`);
  if (!hit[1].startsWith('rgb')) return hit[1];
  // Canvas for this theme, which every translucent tint is layered on.
  const canvas = find.call(null, block) && /--bg:\s*(#[0-9A-Fa-f]{6})/.exec(block);
  return over(hit[1], canvas ? canvas[1] : '#FFFFFF');
};

// Applied WITHIN each ramp: the interface and document ramps never meet in one
// block, so 14 (headline) sitting 1px under 15 (doc-h3) is not a hierarchy.
const RAMPS = {
  interface: ['--text-nano', '--text-micro', '--text-label', '--text-body', '--text-headline', '--text-title'],
  document: ['--text-doc-h3', '--text-doc-h2', '--text-doc-h1'],
};
const DISPLAY = ['--text-mark', '--text-metric', '--text-metric-tile'];

describe('type scale tokens', () => {
  it('defines the ramp DESIGN.md documents, and nothing undocumented', () => {
    // The frontmatter used to declare four discrete sizes while the prose declared
    // five roles across ranges and the code shipped 22 values — three disagreeing
    // systems, which is why the mechanical detector produced 47 findings of which
    // a third were false. One source of truth now.
    expect(tokenValues('text')).toEqual({
      // Interface ramp — six steps.
      '--text-nano': '9px',
      '--text-micro': '10.5px',
      '--text-label': '11.5px',
      '--text-body': '12.5px',
      '--text-headline': '14px',
      '--text-title': '16px',
      // Document ramp — Read surfaces only.
      '--text-doc-h3': '15px',
      '--text-doc-h2': '17px',
      '--text-doc-h1': '20px',
      // Display.
      '--text-mark': '22px',
      '--text-metric': 'clamp(24px, 4vw, 38px)',
      '--text-metric-tile': 'clamp(16px, 14cqi, 38px)',
    });
  });

  for (const [name, tokens] of Object.entries(RAMPS)) {
    it(`admits no step finer than 1px inside the ${name} ramp`, () => {
      // The rule this whole contract exists to enforce. At these sizes a 0.5px
      // step buys ~0.26px of x-height — sub-device-pixel at 1×, and smaller than
      // the difference between the platform fallback faces, so it cannot carry
      // hierarchy; it only records that nobody decided. The ramp this replaced had
      // 22 values with 9/9.5, 10/10.5 and 13.5/14/14.5 all coexisting.
      const t = tokenValues('text');
      const steps = tokens.map((token) => ({ token, px: parseFloat(t[token]) }));
      // Declared in ascending order, so a sort would hide an ordering mistake.
      expect(steps.map((s) => s.px)).toEqual([...steps.map((s) => s.px)].sort((a, b) => a - b));
      const tooClose = steps.slice(1)
        .map((step, i) => ({ lower: steps[i].token, upper: step.token, gap: step.px - steps[i].px }))
        .filter(({ gap }) => gap < 1);
      expect(tooClose).toEqual([]);
    });
  }

  it('covers every size token by exactly one ramp or the display set', () => {
    // Stops a new token being added without deciding which ramp owns it — which
    // would put it outside the ≥1px gate above.
    const classified = [...RAMPS.interface, ...RAMPS.document, ...DISPLAY].sort();
    expect(Object.keys(tokenValues('text')).sort()).toEqual(classified);
  });

  it('declares every weight and line height as a token', () => {
    expect(tokenValues('fw')).toEqual({
      '--fw-regular': '400',
      '--fw-medium': '500',
      '--fw-semibold': '600',
      '--fw-bold': '700',
    });
    expect(tokenValues('lh')).toEqual({
      '--lh-flush': '1',
      '--lh-metric': '1.08',
      '--lh-tight': '1.25',
      '--lh-label': '1.3',
      '--lh-data': '1.45',
      '--lh-body': '1.5',
      '--lh-editor': '22px',
    });
  });

  it('agrees with the DESIGN.md typography frontmatter', () => {
    // Keeps the machine-readable design system and the shipped tokens in lockstep,
    // so the Impeccable detector stops reporting legitimate sizes as drift.
    const frontmatterSize = (role) => {
      const block = design.slice(design.indexOf(`  ${role}:`));
      return /fontSize: "([^"]+)"/.exec(block)[1];
    };
    const t = tokenValues('text');
    expect(frontmatterSize('title')).toBe(t['--text-title']);
    expect(frontmatterSize('body')).toBe(t['--text-body']);
    // label and data deliberately share one step — sans vs mono is the difference,
    // not size. The frontmatter has always declared both at 11.5px; the code now
    // agrees instead of shipping 11px labels against an 11.5px declaration.
    expect(frontmatterSize('label')).toBe(t['--text-label']);
    expect(frontmatterSize('data')).toBe(t['--text-label']);
  });
});

describe('stylesheet uses the tokens', () => {
  const values = (prop) => [...rules.matchAll(new RegExp(`${prop}:([^;}]+)`, 'g'))].map((m) => m[1].trim());

  it('sets no font-size outside the token set', () => {
    // Two admissible non-token values, each exactly once:
    //   `.92em`   — `.md-view code`, which must track whichever prose size encloses
    //               it, so it is relative by design;
    //   `inherit` — the h1–h6 reset that neutralises user-agent heading sizing.
    // Pinning the counts means neither can be copied to a third site without a
    // deliberate edit here.
    const sizes = values('font-size');
    const offRamp = sizes.filter((v) => !v.startsWith('var(--text-') && v !== '.92em' && v !== 'inherit');
    expect(offRamp).toEqual([]);
    expect(sizes.filter((v) => v === '.92em')).toHaveLength(1);
    expect(sizes.filter((v) => v === 'inherit')).toHaveLength(1);
  });

  it('sets no font-weight or line-height outside the token set', () => {
    expect(values('font-weight').filter((v) => !v.startsWith('var(--fw-'))).toEqual([]);
    // The status bar's 15px line box is a layout strut that fixes the bar height,
    // not a ratio on the type ramp — it stays literal and named here.
    expect(values('line-height').filter((v) => !v.startsWith('var(--lh-') && v !== '15px')).toEqual([]);
  });

  it('never reintroduces a `font:` shorthand carrying a literal size', () => {
    // The shorthand hid nine literal sizes from the first sweep of this cleanup,
    // and it silently resets font-style/variant/stretch and line-height as a side
    // effect. `font: inherit` is fine — it defers to a tokenized ancestor.
    const shorthands = [...rules.matchAll(/[^-]font:([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => v !== 'inherit');
    expect(shorthands).toEqual([]);
  });

  it('uses only the two declared font families', () => {
    expect([...new Set(values('font-family'))].sort()).toEqual(['inherit', 'var(--mono)', 'var(--ui)']);
  });

  it('anchors an explicit base size on body so nothing inherits the UA 16px', () => {
    // Without this, any element the stylesheet forgets to size renders at the
    // browser default — the mechanism behind every user-agent-typography surface
    // this cleanup fixed. Anchor on the newline so `html, body {` can't match.
    const at = rules.indexOf('\nbody {');
    const body = rules.slice(at, rules.indexOf('}', at));
    expect(body).toMatch(/font-size:\s*var\(--text-/);
  });

  it('neutralises user-agent heading sizing', () => {
    // The UA sheet sizes h1–h6 in em multiples of the inherited size. An unclassed
    // <h2> in .dash-empty rendered at 19.5px/700 and an unclassed <h1> in
    // .workspace-not-found at 32px/700 purely from these defaults.
    expect(rules).toMatch(/h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*font-size:\s*inherit/);
  });
});

describe('every text-bearing class the UI renders has a rule', () => {
  it('leaves no class group entirely unstyled', () => {
    // A `class:` attribute whose every class is absent from the stylesheet means
    // that element renders in user-agent chrome. This is what shipped the conflict
    // chooser as 13.333px Arial buttons with outset borders — on the dialog that
    // decides whether to overwrite another tab's saved work — and what left the
    // query tab's external-change marker as an unstyled stray '!' character.
    const sources = [
      'src/ui/conflict-resolution.ts', 'src/ui/app.ts', 'src/ui/dashboard.ts',
      'src/ui/doc-pane.ts', 'src/ui/shortcuts.ts', 'src/ui/kpi-panel.ts',
      'src/ui/explain-graph.ts', 'src/ui/tabs.ts',
    ].map((f) => readFileSync(resolve(root, f), 'utf8')).join('\n');

    const styled = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    const unstyled = [...sources.matchAll(/class:\s*'([^']+)'/g)]
      .map((m) => m[1].split(/\s+/).filter(Boolean))
      // A group is fine if ANY class in it is styled — modifier hooks like
      // `docs-state docs-loading` legitimately carry no rules of their own.
      .filter((group) => group.length && !group.some((c) => styled.has(c)))
      .map((group) => group.join(' '));

    // Deliberate semantic hooks: each is a wrapper or inner span whose typography
    // is owned by a styled ancestor or sibling, verified individually —
    //   surface-label / exp-label : plain spans inside styled parents
    //   shortcut-section          : <section> wrapper; its children are styled
    //   docs-field*               : wrapper; .docs-field-label/-text are styled
    //   kpi-value-number          : span inside the styled .kpi-value
    // Anything NOT on this list renders in user-agent chrome.
    const ALLOWED = new Set([
      'surface-label', 'shortcut-section', 'exp-label', 'kpi-value-number',
      'docs-field', 'docs-field docs-syntax', 'docs-field docs-facts', 'docs-field docs-related',
    ]);
    expect([...new Set(unstyled)].filter((g) => !ALLOWED.has(g))).toEqual([]);
  });
});

describe('corner radii', () => {
  it('defines four steps plus a pill, and nothing else', () => {
    expect(tokenValues('r')).toEqual({
      '--r-xs': '3px',
      '--r-sm': '5px',
      '--r-md': '8px',
      '--r-lg': '12px',
      '--r-pill': '999px',
    });
  });

  it('sets no literal radius outside the token set', () => {
    // The stylesheet had drifted to fourteen radius values against a documented
    // four-step scale — 4/5/6/7px all in play for the same kind of control, and
    // `.dash-tile` at 10px while DESIGN.md said tiles are 8px. A radius states what
    // KIND of surface a box is; fourteen values state nothing.
    const bad = [...rules.matchAll(/border(?:-[a-z]+)?-radius:([^;}]+)/g)]
      .map((m) => m[1].trim())
      // `0` is a deliberate square-corner reset; a multi-corner value is allowed
      // as long as each corner it names is a token (the flush-topped combo footer).
      .filter((v) => v !== '0' && !/^(var\(--r-[\w-]+\)|0)( (var\(--r-[\w-]+\)|0))*$/.test(v));
    expect(bad).toEqual([]);
  });

  it('uses a pill token rather than a px radius where the radius is the shape', () => {
    // A capsule written as `border-radius: 18px` silently stops being a capsule the
    // moment the box grows past 36px tall. --r-pill cannot.
    expect(tokenValues('r')['--r-pill']).toBe('999px');
    expect([...rules.matchAll(/border-radius:\s*var\(--r-pill\)/g)].length).toBeGreaterThan(0);
  });
});

describe('elevation', () => {
  it('defines one token per documented shadow entry', () => {
    // DESIGN.md §4 documents Micro Lift / Popover / Dialog / Drawer, plus a float
    // for transient surfaces. The stylesheet had fourteen distinct shadows across
    // eleven black alphas, so two popovers could differ for no reason at all.
    expect(Object.keys(tokenValues('shadow')).sort()).toEqual([
      '--shadow-dialog', '--shadow-drawer', '--shadow-float', '--shadow-lift', '--shadow-popover',
    ]);
    expect(Object.keys(tokenValues('ring')).sort()).toEqual(['--ring-error', '--ring-warn']);
    expect(rootBlock).toMatch(/--ring:\s*0 0 0 3px color-mix/);
  });

  it('sets no raw shadow colour outside the tokens', () => {
    const raw = [...rules.matchAll(/box-shadow:([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => /rgba?\(/.test(v));
    expect(raw).toEqual([]);
  });
});

describe('no token is referenced with a literal fallback', () => {
  it('never writes var(--token, #hex)', () => {
    // `var(--success, #238636)` and `var(--danger, #cf222e)` shipped for a long
    // time against tokens that were NEVER DEFINED, so those colours silently
    // ignored the theme and quietly failed AA. A hex fallback turns a missing
    // token from a visible bug into an invisible one.
    const withHexFallback = [...declarations.matchAll(/var\(\s*--[\w-]+\s*,\s*(#[0-9A-Fa-f]{3,8}|rgba?\()/g)]
      .map((m) => m[0]);
    expect(withHexFallback).toEqual([]);
  });

  it('resolves every var(--token) reference to a defined token', () => {
    // Catches the inverse too: a reference to a token nobody declares.
    const defined = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
    // Set from JS at runtime, so they are legitimately absent from :root.
    //   --var-input-ch          : src/ui/var-field.ts (type-aware input width, #345)
    //   --dash-time-crosshair-x     : src/ui/dashboard-chart-interaction.ts
    //   --dash-time-crosshair-color : ditto (per-series crosshair colour)
    // Both carry their own fallback, so they degrade rather than resolve to nothing.
    const EXTERNAL = new Set([
      '--var-input-ch', '--dash-time-crosshair-x', '--dash-time-crosshair-color',
    ]);
    const referenced = new Set([...rules.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    const dangling = [...referenced].filter((t) => !defined.has(t) && !EXTERNAL.has(t));
    expect(dangling).toEqual([]);
  });
});

describe('the colours the type sits on meet WCAG 2.2 AA', () => {
  // 1.4.3 Contrast (Minimum): 4.5:1 for normal text. Nothing in this product's
  // ramp reaches the 18.66px-bold or 24px "large text" exemption except the KPI
  // metric, which sits on --fg, so 4.5 is the bar everywhere that matters.
  const BACKGROUNDS = ['--bg', '--bg-header', '--bg-side', '--bg-th', '--bg-chip', '--bg-modal', '--bg-input'];
  const FOREGROUNDS = ['--fg', '--fg-mute', '--fg-faint', '--accent-text'];

  for (const theme of ['dark', 'light']) {
    it(`holds every foreground/background pair at 4.5:1 in the ${theme} theme`, () => {
      const failures = [];
      for (const fg of FOREGROUNDS) {
        for (const bg of BACKGROUNDS) {
          const ratio = contrast(themeToken(theme, fg), themeToken(theme, bg));
          if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('keeps the tertiary tier weaker than the secondary tier', () => {
    // --fg-faint had to move a long way to reach AA; it must still read as the
    // quietest tier or the three-step tonal hierarchy collapses into two.
    for (const theme of ['dark', 'light']) {
      const bg = themeToken(theme, '--bg');
      expect(contrast(themeToken(theme, '--fg-faint'), bg))
        .toBeLessThan(contrast(themeToken(theme, '--fg-mute'), bg));
      expect(contrast(themeToken(theme, '--fg-mute'), bg))
        .toBeLessThan(contrast(themeToken(theme, '--fg'), bg));
    }
  });

  it('keeps white legible on the accent and error fills', () => {
    expect(contrast('#FFFFFF', '#0079AD')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#FFFFFF', themeToken('light', '--error-fg'))).toBeGreaterThanOrEqual(4.5);
  });

  // Semantic and log-level tokens are checked against the surfaces they can
  // ACTUALLY land on, not the full cross-product. Testing every token against
  // every background reports failures that no user can reach (a log level never
  // renders on a chip) and pressures a correct palette into changing for nothing.
  const SEMANTIC_EXPOSURE = {
    '--error-fg': ['--bg', '--bg-table', '--bg-modal', '--bg-chip'],
    '--warn-fg': ['--bg', '--bg-table', '--bg-modal', '--warn-bg'],
    '--success-fg': ['--bg', '--bg-table', '--bg-modal', '--bg-chip'],
    '--num': ['--bg-table', '--bg'],
    '--log-fatal': ['--bg', '--bg-table'],
    '--log-error': ['--bg', '--bg-table'],
    '--log-warn': ['--bg', '--bg-table'],
    '--log-info': ['--bg', '--bg-table'],
    '--log-debug': ['--bg', '--bg-table'],
    '--log-trace': ['--bg', '--bg-table'],
  };

  for (const theme of ['dark', 'light']) {
    it(`holds every semantic colour at 4.5:1 where it renders in the ${theme} theme`, () => {
      const failures = [];
      for (const [fg, backgrounds] of Object.entries(SEMANTIC_EXPOSURE)) {
        for (const bg of backgrounds) {
          const ratio = contrast(themeToken(theme, fg), themeToken(theme, bg));
          if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe('the artifact carries its own typefaces', () => {
  it('declares an @font-face for each family the stacks name first', async () => {
    const { css: faces } = await buildFontFaces();
    for (const { family } of FONTS) {
      expect(faces).toContain(`font-family:'${family}'`);
      // Declared as a variable weight range, so one file serves 400/500/600/700.
      expect(faces).toMatch(new RegExp(`font-family:'${family}';[^@]*font-weight:100 900`));
      expect(faces).toMatch(new RegExp(`font-family:'${family}';[^@]*data:font/woff2;base64,`));
    }
    // The stylesheet must name them first, or self-hosting buys nothing.
    expect(rootBlock).toMatch(/--ui:\s*'Inter'/);
    expect(rootBlock).toMatch(/--mono:\s*'JetBrains Mono'/);
    // The splice point has to survive, or the faces silently stop shipping.
    expect(css).toContain('/*__FONTS__*/');
  });

  it('keeps a unicode-range so out-of-subset codepoints fall back', async () => {
    // Latin-only subsets. Without unicode-range a Cyrillic or CJK result cell
    // would render tofu instead of deferring to the platform font.
    const { css: faces } = await buildFontFaces();
    expect([...faces.matchAll(/unicode-range:/g)]).toHaveLength(FONTS.length);
  });

  it('stays inside the font byte budget', async () => {
    // Hard rule 4: the artifact is one self-contained file served from ClickHouse,
    // so font weight is a deliberate cost. Adding latin-ext or an italic cut has
    // to be a reviewed edit to this budget, not a silent 40 KB.
    const { rawBytes } = await buildFontFaces();
    expect(rawBytes).toBeLessThanOrEqual(FONT_BYTE_BUDGET);
  });
});
