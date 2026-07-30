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
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { FONTS, FONT_BYTE_BUDGET, buildFontFaces } from '../../build/fonts.mjs';
import { buildArtifact } from '../../build/build.mjs';

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

/** Every class name that has a real SELECTOR somewhere in the stylesheet.
 *
 *  Built from `declarations`, never from raw `css`, for exactly the reason the
 *  comment above gives about px values: this file is heavily commented, and
 *  those comments cross-reference sibling rules by name (e.g. `.dash-tree-confirm`'s
 *  prose points at "`.qtab-close-confirm*` and `.dash-tile-confirm*`"). Scanning
 *  raw CSS counted that prose as styling, so a class whose real rule was deleted
 *  still looked styled as long as ANY comment mentioned it — the whole
 *  "no class the UI renders may be left with no CSS rule" gate silently passed.
 *  Demonstrated on `.qtab-close-confirm`: deleting both of its real rules while
 *  leaving the comment kept all 338 assertions in this file green. */
const styledClassNames = (source = declarations) =>
  new Set([...source.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

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

  // Three tiers carry an explicit restriction in DESIGN.md, and until now nothing
  // enforced any of them: the checks above verify a declaration uses *some* --text-*
  // token, which is syntax, not semantics. Both DOM state badges were sitting on
  // --text-nano — one because the mechanical 9px->token mapping put it there, one
  // because it was authored in the same change that wrote the rule forbidding it.
  // A tier whose whole point is "only here" needs the "only here" asserted.
  const sizedBy = (token) => {
    const out = [];
    // Walk selector/body pairs so each declaration can be attributed to its rule.
    for (const m of rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (m[2].includes(`font-size: var(${token})`)) out.push(m[1].trim().split('\n').pop().trim());
    }
    return out;
  };

  it('confines --text-nano to SVG text inside the zoomable graphs', () => {
    // DESIGN.md's Zoomable-Surface Exception: 9px is admissible only as SVG text in
    // the EXPLAIN pipeline graph and schema graph, which pan and zoom and whose
    // layout (core/dot-layout.js) is measured against that size. The floor for
    // anything read WITHOUT zooming is --text-micro.
    const users = sizedBy('--text-nano');
    expect(users.length).toBeGreaterThan(0);
    const offSurface = users.filter((sel) => !/^\.(explain-graph|schema-graph)\b/.test(sel));
    expect(offSurface).toEqual([]);
  });

  it('confines the display tier to the login mark and the KPI metric', () => {
    // "The Compact Scale Rule": nothing in the application shell may exceed
    // --text-title. --text-mark and the two metric clamps are the only sanctioned
    // exceptions, and each has exactly one home.
    expect(sizedBy('--text-mark').every((sel) => /login-logo/.test(sel))).toBe(true);
    for (const token of ['--text-metric', '--text-metric-tile']) {
      expect(sizedBy(token).every((sel) => /kpi-value/.test(sel))).toBe(true);
    }
  });

  it('confines the document ramp to Read surfaces', () => {
    // The document ramp exists because reference docs and Markdown panels are prose
    // the user reads. Letting it leak into operable chrome would reintroduce exactly
    // the oversized-shell-typography problem the Compact Scale Rule forbids.
    const READ = /^\.(md-view|docs-)/;
    for (const token of ['--text-doc-h1', '--text-doc-h2', '--text-doc-h3']) {
      const strayed = sizedBy(token).filter((sel) => !READ.test(sel));
      expect(strayed).toEqual([]);
    }
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
    // app-shell.ts and workbench/workbench-shell.ts hold markup #425 carved OUT of
    // app.ts, which is on this list — so the split silently moved the application
    // frame, the sidebar, and the two surface hosts out of this gate's view. A
    // curated list has that failure mode; the fix is to follow the markup.
    const sources = [
      'src/ui/conflict-resolution.ts', 'src/ui/app.ts',
      'src/ui/workbench/workbench-shell.ts', 'src/ui/dashboard.ts',
      'src/ui/doc-pane.ts', 'src/ui/shortcuts.ts', 'src/ui/kpi-panel.ts',
      'src/ui/explain-graph.ts', 'src/ui/tabs.ts',
      // #426 moved the upper sidebar pane's markup into these two modules. They
      // are listed for exactly the reason the comment above gives: app-shell.ts
      // is gated, and carving its markup out into unlisted files would silently
      // move the sidebar back out of this gate's view.
      'src/ui/sidebar-upper.ts', 'src/ui/dashboard-tree.ts',
      // #577 state S2 — the vanilla shell (`app-shell.ts`) and the vanilla right
      // inspector are GONE; their markup now lives in these three modules. They
      // are listed for exactly the reason the comment at the top of this list
      // gives: deleting a gated file and carving its markup into unlisted ones
      // silently moves the whole application frame back out of this gate's view,
      // which is the failure mode that shipped the 13px Arial conflict dialog.
      'src/ui/shell/shell-view.ts', 'src/ui/shell/right-inspector-view.ts',
      'src/ui/shell/shell-host.ts',
      // #457 deleted `src/ui/variable-editor.ts` (the per-variable option-SQL
      // drawer #447 had carved out of the tree's markup) — option SQL is edited in
      // the main editor now, whose markup is already covered by app-shell.ts,
      // workbench/workbench-shell.ts and tabs.ts above.
      //
      // #459: the shared variable bar builds the Dashboard's and the detached
      // view's `{name:Type}` rows — markup dashboard.ts (gated above) delegates
      // rather than renders, so it was outside this gate for the same
      // carved-out-markup reason the comment opens with. Adding it here is what
      // makes an emitter/rule drift on a class like `.dash-variable-time`
      // detectable at all.
      'src/ui/variable-bar.ts',
      // #429 phase 3: `openDialogShell`/`openNameDialog` moved out of
      // file-menu.ts (not itself in this list) into their own module so the
      // Dashboard tree's rename pencil can reuse them — listed here so the
      // `.fm-dialog-*` markup they build stays under this gate's view.
      'src/ui/dialog-shell.ts',
      // #483: the Library assignment chooser renders confirmation prose and
      // action rows outside saved-history.ts, so it must stay in this gate.
      'src/ui/library-assign-menu.ts',
    ].map((f) => readFileSync(resolve(root, f), 'utf8')).join('\n');

    const styled = styledClassNames();
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
    //   dash-row                  : flow@1 row wrapper; grid set INLINE (below)
    // Anything NOT on this list renders in user-agent chrome.
    //
    // `dash-row` (#554 review): surfaced the moment this scan stopped counting
    // comment prose as styling — it had no rule and never has, and was only
    // ever "covered" by the two `src/styles.css` comments that name it. That is
    // correct by design, not an oversight to paper over: `.dash-grid`'s comment
    // spells out that each row "is itself the grid that owns its column count …
    // set inline by the flow renderer", and that the container must NOT impose
    // `grid-template-columns` or the rows lay out side by side. A `.dash-row`
    // rule would either duplicate the inline style or reintroduce that bug, so
    // this is a genuine inline-presentation hook.
    const ALLOWED = new Set([
      'surface-label', 'shortcut-section', 'exp-label', 'kpi-value-number', 'dash-row',
      'docs-field', 'docs-field docs-syntax', 'docs-field docs-facts', 'docs-field docs-related',
    ]);
    expect([...new Set(unstyled)].filter((g) => !ALLOWED.has(g))).toEqual([]);
  });
});

describe('openMenu extension classes have CSS rules', () => {
  // #498: openMenu()/openConfirmMenu() consumers supply component-specific
  // classes through the `menuClass`/`extraClass` OPTIONS rather than an `h()`
  // `class:` literal, so the generic scanner above never sees them — and
  // openMenu always layers on generic `.file-menu`/`.fm-item`/`.fm-section`
  // chrome, so a missing consumer rule would not even produce a fully
  // unstyled browser-default dialog the way the generic scanner's failure
  // mode does. Kept as its OWN test (not folded into the generic scanner
  // above) precisely because it needs different extraction (menuClass/
  // extraClass properties, not a `class:` attribute) and no `ALLOWED`
  // leniency: every literal found here must resolve to a real rule.
  //
  // Scans ALL of `src/ui/**/*.ts` — not a curated file list — so a future
  // menu consumer is covered automatically without anyone remembering to add
  // it here.
  function collectUiFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectUiFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }
  const uiSource = collectUiFiles(resolve(root, 'src/ui'))
    .map((f) => readFileSync(f, 'utf8')).join('\n');

  // `ui/confirm-menu.ts`'s `openConfirmMenu` is the one indirection the plain
  // `menuClass`/`extraClass` pattern cannot see through: its own options are
  // named `menuClass` (caught directly), `goClass`, and `cancelClass` — the
  // latter two become `extraClass` INSIDE confirm-menu.ts, so the literal
  // value lives at the CALL site (dashboard-tree.ts's `dash-tree-confirm*`,
  // tabs.ts's `qtab-close-confirm*`, dashboard.ts's `dash-tile-confirm*`),
  // under different property names than the ones that reach openMenu.
  function literalClassGroups(source) {
    const groups = [];
    for (const pattern of [
      /\b(?:menuClass|extraClass):\s*'([^']+)'/g,
      /\b(?:goClass|cancelClass):\s*'([^']+)'/g,
    ]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source))) {
        groups.push(match[1].split(/\s+/).filter(Boolean));
      }
    }
    return groups;
  }

  const styledClasses = styledClassNames();

  it('every literal menuClass/extraClass value (incl. openConfirmMenu goClass/cancelClass) has a stylesheet rule', () => {
    const groups = literalClassGroups(uiSource);
    // The scan itself must find something, or this test would pass vacuously
    // if the extraction regex ever stopped matching anything at all.
    expect(groups.length).toBeGreaterThan(0);
    const missing = new Set();
    for (const group of groups) {
      for (const cls of group) {
        if (!styledClasses.has(cls)) missing.add(cls);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('sabotage check: a class missing its CSS rule fails the contract above', () => {
    const groups = literalClassGroups(uiSource);
    const found = new Set(groups.flat());
    // `dash-tile-menu-danger` (#537, the tile menu's destructive row —
    // `extraClass` arriving directly, not through goClass/cancelClass) is
    // real, single-purpose, and currently styled: a safe target to remove.
    const target = 'dash-tile-menu-danger';
    expect(found.has(target)).toBe(true);
    const sabotagedCss = declarations.replace(/\.dash-tile-menu-danger\s*\{[^}]*\}\n?/, '');
    expect(sabotagedCss).not.toEqual(declarations); // the removal must actually have taken effect
    const missing = [...found].filter((cls) => !styledClassNames(sabotagedCss).has(cls));
    expect(missing).toEqual([target]);
  });

  // The regression this gate has to survive, and did NOT before (#554 review).
  // The sabotage above picks a class no comment happens to name, so it passed
  // while the general contract leaked: every confirm menu's prose
  // cross-references its siblings by name, so `.dash-tree-confirm`'s comment
  // mentions "`.qtab-close-confirm*` and `.dash-tile-confirm*`" and vice versa.
  // Scanning raw CSS let that prose stand in for a rule. Verified against the
  // real stylesheet: deleting BOTH real `.qtab-close-confirm` rules while
  // leaving the comment kept all 338 assertions in this file green.
  it('sabotage check: a comment naming a class does not stand in for its rule', () => {
    const target = 'qtab-close-confirm';
    expect(literalClassGroups(uiSource).flat()).toContain(target);
    // The masking is real in the shipped stylesheet, not hypothetical: the
    // sibling confirm menu's prose names this class.
    expect(css).toMatch(new RegExp(`\\.${target}\\*`));

    // Build the bait deterministically rather than regex-surgering the real
    // file: strip the class's rules from the COMMENT-FREE text (so no prose can
    // confuse the match), then prepend a comment that names it. This is exactly
    // the shape `src/styles.css` has today.
    const withoutRules = declarations.replace(
      new RegExp(`\\.${target}(?![\\w-])[^{}]*\\{[^}]*\\}\\n?`, 'g'), '',
    );
    expect(withoutRules).not.toEqual(declarations);
    const baited = `/* see \`.${target}*\` for the sibling rule */\n${withoutRules}`;

    // The OLD raw-CSS scan was fooled by precisely that comment — it still
    // called the class styled. Pinned so the regression cannot come back
    // unnoticed.
    expect(new Set([...baited.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])).has(target))
      .toBe(true);
    // The comment-stripped scan this file now uses is not fooled.
    expect(styledClassNames(baited.replace(/\/\*[\s\S]*?\*\//g, '')).has(target)).toBe(false);
  });

  // Existing generic scanner keeps covering these directly, unaffected by the
  // menuClass/extraClass extraction above (#498 acceptance: they stay covered).
  it('still covers .file-menu / .fm-item / .fm-section directly (unaffected by this test)', () => {
    for (const cls of ['file-menu', 'fm-item', 'fm-section']) {
      expect(styledClasses.has(cls), cls).toBe(true);
    }
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
    expect(Object.keys(tokenValues('ring')).sort()).toEqual(['--ring-error', '--ring-nav', '--ring-warn']);
    expect(rootBlock).toMatch(/--ring:\s*0 0 0 3px color-mix/);
  });

  it('mixes every ring halo in one colour space at one alpha', () => {
    // The ring family's whole claim is that a ring's HUE says which kind of state
    // has focus, which only holds if nothing else about the halo varies. Asserted
    // on the definitions rather than left to review: #425's navigation highlight
    // was written as `color-mix(in srgb, var(--accent) 25%, transparent)` beside
    // this family's `in oklab … 22%` — the same halo in two spellings, already a
    // 3% step apart before anyone had a reason.
    // Read from the comment-stripped source, so the `in srgb, … 25%` quoted in
    // this family's own explanatory comment cannot be mistaken for a declaration.
    const bare = declarations.slice(declarations.indexOf(':root {'), declarations.indexOf('\n}', declarations.indexOf(':root {')));
    const halos = [...bare.matchAll(/--ring[\w-]*:[^;]+/g)]
      .flatMap((m) => [...m[0].matchAll(/color-mix\((?:[^()]|\([^()]*\))*\)/g)].map((c) => c[0]))
      .map((mix) => mix.replace(/var\(--[\w-]+\)/, 'HUE'));
    expect(halos.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(halos)]).toEqual(['color-mix(in oklab, HUE 22%, transparent)']);
  });

  it('sets no raw shadow colour outside the tokens', () => {
    // A rule may name a token colour directly for a flat structural edge (the
    // 1px inset hairlines, the knockout ring in the surface colour), but it may
    // not MIX ITS OWN translucent colour: an alpha over a surface is exactly what
    // the --shadow-* and --ring-* tokens encode, and a hand-rolled one drifts from
    // them silently. Checking only for `rgba(` — as this did — could not see
    // `color-mix(…, transparent)`, which is how #425's navigation ring passed.
    const raw = [...rules.matchAll(/box-shadow:([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => /rgba?\(|color-mix\(/.test(v));
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

  it('never lets a custom property reference itself, directly or through a chain', () => {
    // `--sql-keyword: var(--sql-keyword)` shipped in the light theme for one commit.
    // A self-referential custom property forms a cycle: per spec it does NOT fall back
    // to an earlier definition of the same name — the computed value becomes invalid
    // at computed-value time, and a `.sql-*` rule consuming it without a fallback
    // loses its colour entirely. So light-mode SQL keywords, functions, strings,
    // numbers and comments were simply uncoloured. Nothing caught it: the token WAS
    // defined and every reference DID resolve, so the two checks either side of this
    // one both passed. A cycle needs its own detector.
    //
    // Built per declaring block, because the same name is legitimately redefined in
    // :root and in each theme — a cycle is a token referencing itself (or a loop of
    // tokens) WITHIN one block, which is where the cascade cannot save it.
    const blocks = [...declarations.matchAll(/(:root|\[data-theme='[a-z]+'\])\s*\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(3); // :root + both themes

    const cycles = [];
    for (const [, selector, body] of blocks) {
      const graph = new Map();
      for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
        graph.set(m[1], [...m[2].matchAll(/var\(\s*(--[\w-]+)/g)].map((r) => r[1]));
      }
      const state = new Map(); // 1 = visiting, 2 = done
      const walk = (token, trail) => {
        if (state.get(token) === 2) return;
        if (state.get(token) === 1) {
          cycles.push(`${selector}: ${[...trail, token].join(' -> ')}`);
          return;
        }
        state.set(token, 1);
        for (const next of graph.get(token) || []) {
          if (graph.has(next)) walk(next, [...trail, token]);
        }
        state.set(token, 2);
      };
      for (const token of graph.keys()) walk(token, []);
    }
    expect(cycles).toEqual([]);
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

  // Derived from the stylesheet, not a hand-kept list: find every rule that puts
  // white text on a tokenized background and check it in BOTH themes. The previous
  // version of this test asserted white-on-accent and white-on-error-fg for the
  // LIGHT theme only, which is precisely why `.cf-overwrite` shipped at 2.77:1 in
  // dark — --error-fg is tuned to be legible as TEXT on a dark plane (#f87171), so
  // it is far too light to carry white as a FILL. Enumerating pairs by hand is what
  // failed; deriving them is what catches the next one.
  const whiteOnFillRules = [...rules.matchAll(/\{([^}]*)\}/g)]
    .map((m) => m[1])
    .filter((body) => /color:\s*(#fff\b|#ffffff\b|white\b)/i.test(body))
    .flatMap((body) => [...body.matchAll(/background(?:-color)?:\s*var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]));

  it('finds the white-on-fill rules it is supposed to be checking', () => {
    // Guards the regex above: if a refactor stops matching, the contrast test below
    // would silently pass on an empty set.
    expect(new Set(whiteOnFillRules).size).toBeGreaterThanOrEqual(2);
    expect(whiteOnFillRules).toContain('--error-fill');
    expect(whiteOnFillRules).toContain('--accent');
  });

  for (const theme of ['dark', 'light']) {
    it(`keeps white legible on every fill token it sits on in the ${theme} theme`, () => {
      const failures = [];
      for (const fill of new Set(whiteOnFillRules)) {
        const ratio = contrast('#FFFFFF', themeToken(theme, fill));
        if (ratio < 4.5) failures.push(`white on ${fill}: ${ratio.toFixed(2)}:1`);
      }
      expect(failures).toEqual([]);
    });

    it(`keeps a filled destructive control distinguishable from its surface in the ${theme} theme`, () => {
      // WCAG 1.4.11: 3:1 for the visual boundary of a UI component. A destructive
      // button whose fill melts into the dialog behind it is not identifiable.
      const fill = themeToken(theme, '--error-fill');
      for (const surface of ['--bg', '--bg-modal', '--bg-editor']) {
        expect(contrast(fill, themeToken(theme, surface))).toBeGreaterThanOrEqual(3);
      }
    });
  }

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

  it('carries the OFL notice for both faces inside the distributed file', async () => {
    // `dist/sql.html` is its own unit of distribution — it gets copied into a
    // ClickHouse `user_files` directory and served from there, detached from this
    // repo and from THIRD-PARTY-NOTICES.md. So the license has to travel *in the
    // artifact*, not only alongside it.
    //
    // It does, via the leading notices comment build.mjs embeds. Worth asserting
    // because the in-binary metadata is only partial: the fontsource subsetting
    // pipeline keeps nameID 0 (Copyright) and nameID 14 (License Info URL) but drops
    // nameID 13 (License Description), so the embedded woff2 alone would carry a
    // copyright line and a URL but not the license text. The notices comment closes
    // that, and this test keeps it closed if the embedding mechanism ever changes.
    const { html, thirdParty } = await buildArtifact();
    for (const needle of [
      'Copyright 2016 The Inter Project Authors',
      'Copyright 2020 The JetBrains Mono Project Authors',
      'SIL Open Font License 1.1',
      'Permission is hereby granted, free of charge, to any person obtaining',
      'Reserved Font Name',
    ]) {
      expect(thirdParty).toContain(needle);
      expect(html).toContain(needle);
    }
    // And it must precede the styles, i.e. actually be the leading comment.
    expect(html.indexOf('SIL Open Font License 1.1')).toBeLessThan(html.indexOf('<style'));
  });

  it('declares no font-display, because a data: source has no load timeline', async () => {
    // `font-display` describes the display timeline for a *network* fetch. There is
    // none here — the face is present as soon as the inline <style> parses — so
    // declaring `swap` would assert a load phase that does not exist and request a
    // flash of fallback text that cannot occur.
    const { css: faces } = await buildFontFaces();
    expect(faces).not.toContain('font-display');
  });

  it('stays inside the font byte budget', async () => {
    // Hard rule 4: the artifact is one self-contained file served from ClickHouse,
    // so font weight is a deliberate cost. Adding latin-ext or an italic cut has
    // to be a reviewed edit to this budget, not a silent 40 KB.
    const { rawBytes } = await buildFontFaces();
    expect(rawBytes).toBeLessThanOrEqual(FONT_BYTE_BUDGET);
  });
});
