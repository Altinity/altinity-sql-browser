// Phase-0 typed contract for the Spec JSON editor seam (`app.specEditor`,
// injected separately from the SQL EditorPort — see spec-editor.js). Declares
// the shape createNoopSpecEditor()/createSpecEditor(app) already implement;
// no behavior change, the runtime module stays untouched `.js`.

import type { EditorPort } from './editor-port.types.js';

export interface SpecDiagnostic {
  message: string;
  severity?: 'error' | 'warning';
  code?: string;
  /** Exact character offset in the Spec JSON text, when known. */
  offset?: number;
  /** JSON path to the offending value, used when `offset` isn't known. */
  path?: Array<string | number>;
}

export interface SpecEditorPort extends EditorPort {
  /** CodeMirror measurement pass — needed after the host container resizes. */
  requestMeasure(): void;
  setDiagnostics(diagnostics: SpecDiagnostic[]): void;
  revealDiagnostic(index?: number): void;
}
