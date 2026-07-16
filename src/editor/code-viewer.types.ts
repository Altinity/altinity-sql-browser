// Phase-0 typed contract for the shared read-only CodeMirror viewer (#213).
// Declares the shape createCodeViewer() already returns — deliberately not an
// EditorPort: no mount/onDocChange/history/completion, just presentation.

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
}

export type CodeViewerFactory = (opts: CodeViewerOptions) => CodeViewerHandle;
