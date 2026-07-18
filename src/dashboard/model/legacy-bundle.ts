// Legacy Library v1/v2 → in-memory PortableBundleV1 normalizer (#280/#287
// Phase 5 "Legacy Library decoding normalizes to an in-memory bundle").
// Reuses the canonical Library codec (core/library-codec.ts) to parse,
// migrate, and validate legacy Library JSON, then wraps the decoded queries
// into a fresh, empty-dashboards PortableBundleV1 and re-validates the whole
// bundle through the one canonical portable-bundle validator — never a
// partial import. Pure: JSON-limit guards, the clock, and the validation
// service are all injected exactly like the sibling codecs in this
// directory.

import { decodeLibraryDocument } from '../../core/library-codec.js';
import type { JsonSchemaValidationService } from '../../core/json-schema-validation.js';
import type { PortableBundleV1 } from '../../generated/json-schema.types.js';
import { parseJsonWithLimits } from './json-limits.js';
import type { JsonLimitOptions } from './json-limits.js';
import { diagnostic } from './workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from './workspace-diagnostics.js';
import {
  CURRENT_PORTABLE_BUNDLE_VERSION, PORTABLE_BUNDLE_FORMAT, PORTABLE_BUNDLE_V1_SCHEMA_ID,
  validatePortableBundleDocument,
} from './portable-bundle-codec.js';

export interface NormalizeLegacyLibraryOptions extends JsonLimitOptions {
  validationService?: JsonSchemaValidationService;
  /** Fallback `exportedAt` used only when the decoded legacy Library carries
   *  none of its own (a bare v1 document, or a v2 document that omitted the
   *  optional field). Never defaulted to `Date.now()` here — this module is
   *  pure; callers inject the clock. */
  nowISO?: string;
  generateId?: (index: number, attempt: number) => string;
}

export type NormalizeLegacyLibraryResult =
  | { ok: true; value: PortableBundleV1 }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/** Decode legacy Library v1/v2 JSON text into a fresh, empty-dashboards
 *  in-memory `PortableBundleV1`. Legacy formats stay readable — v1 is
 *  migrated to v2 first — but nothing is ever written back out as
 *  Library-only JSON; the only output shape is the portable bundle, fully
 *  re-validated end to end. Any decode/migration/validation failure returns
 *  `{ok:false}` with precise diagnostics rather than an incomplete bundle. */
export function normalizeLegacyLibraryToBundle(
  text: unknown, options: NormalizeLegacyLibraryOptions = {},
): NormalizeLegacyLibraryResult {
  const { validationService, nowISO, generateId, maxBytes, maxDepth } = options;
  const parsed = parseJsonWithLimits(text, { maxBytes, maxDepth });
  if (!parsed.ok) return parsed;

  const decoded = decodeLibraryDocument(parsed.value, { nowISO, generateId, validationService });
  if (!decoded.ok) {
    return {
      ok: false,
      diagnostics: decoded.diagnostics.map((item) => diagnostic(item.path, item.code, item.message)),
    };
  }

  const exportedAt = typeof decoded.value.exportedAt === 'string' && decoded.value.exportedAt
    ? decoded.value.exportedAt
    : nowISO;
  const document: Record<string, unknown> = {
    $schema: PORTABLE_BUNDLE_V1_SCHEMA_ID,
    format: PORTABLE_BUNDLE_FORMAT,
    version: CURRENT_PORTABLE_BUNDLE_VERSION,
    ...(exportedAt === undefined ? {} : { exportedAt }),
    queries: decoded.value.queries,
    dashboards: [],
  };

  const diagnostics = validatePortableBundleDocument(document, { validationService });
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: document as unknown as PortableBundleV1 };
}
