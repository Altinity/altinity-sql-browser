// Phase-0 typed contract for the shared read-only CodeMirror viewer (#213).
// Declares the shape createCodeViewer() already returns — deliberately not an
// EditorPort: no mount/onDocChange/history/completion, just presentation.

import type { Extension } from '@codemirror/state';

export type CodeViewerLanguage = 'text' | 'json' | 'sql' | 'xml' | 'html' | 'markdown';

export interface CodeViewerHandle {
  setText(nextText: string): void;
  setLanguage(nextLanguage: CodeViewerLanguage): void;
  setWrap(enabled: boolean): void;
  focus(): void;
  destroy(): void;
}

export interface CodeViewerOptions {
  parent: Element;
  document?: Document;
  text?: string;
  language?: CodeViewerLanguage;
  wrap?: boolean;
  /** Override the `language`-driven default with the caller's own already-
   *  built CM6 extension(s) — e.g. the docs pane's ClickHouse-flavored SQL
   *  dialect (`ch-lang.ts`'s `chLanguageExtension`, #313) so a function-
   *  reference example highlights with the same keyword/function set as the
   *  main editor, instead of generic `@codemirror/lang-sql`. `language` still
   *  selects the fallback used by a later `setLanguage()` reconfigure; this
   *  only replaces the INITIAL compartment contents. Omitted (the default)
   *  keeps every pre-#313 caller's behavior byte-identical. */
  languageExtension?: Extension | Extension[];
}

export type CodeViewerFactory = (opts: CodeViewerOptions) => CodeViewerHandle;
