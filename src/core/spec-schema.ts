// Pure query.spec schema validation and introspection. The canonical schema
// and compiled validator are generated at build time; this module normalizes
// their output and exposes the stable app-facing service.

import { querySpecV1Schema as _querySpecSchema } from '../generated/json-schemas.js';
import { validateQuerySpecV1 as _validateQuerySpec } from '../generated/json-schema-validators.js';
import { formatJsonPath, normalizeJsonSchemaErrors } from './json-schema-validation.js';
import type { JsonSchemaValidatorFn, SchemaDiagnostic, SchemaValidationError } from './json-schema-validation.js';

/** A JSON Schema node as this module walks it: the Draft 2020-12 keywords
 *  this module's own dereference/expand/merge logic actually reads, plus the
 *  `x-altinity-*` authoring/presentation annotations, with an index
 *  signature for every other schema keyword (generated content this module
 *  passes through unexamined). Every nested schema-shaped field is the same
 *  recursive type. */
export interface JsonSchemaNode {
  $ref?: string;
  $id?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  patternProperties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode | boolean;
  items?: JsonSchemaNode;
  prefixItems?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  not?: JsonSchemaNode;
  if?: JsonSchemaNode;
  then?: JsonSchemaNode;
  else?: JsonSchemaNode;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  'x-altinity-discriminator'?: string;
  'x-altinity-order'?: string[];
  'x-altinity-completion'?: unknown;
  'x-altinity-key-completion'?: unknown;
  'x-altinity-snippet'?: unknown;
  'x-altinity-deprecated'?: boolean;
  'x-altinity-status'?: string;
  [key: string]: unknown;
}

// generated/json-schemas.js is unconverted (checkJs:false) — a thin typed
// wrapper over the literal schema graph this module walks generically.
const querySpecSchema = _querySpecSchema as JsonSchemaNode;
// generated/json-schema-validators.js is unconverted — the compiled Ajv
// validator function, same JsonSchemaValidatorFn contract
// json-schema-validation.ts already types for every other compiled validator.
const validateQuerySpec = _validateQuerySpec as JsonSchemaValidatorFn;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: unknown, key: string): boolean => isObject(value) && Object.hasOwn(value, key);

const ANNOTATION_KEYS: string[] = [
  'title', 'description', 'default', 'examples',
  'x-altinity-discriminator', 'x-altinity-completion',
  'x-altinity-key-completion', 'x-altinity-snippet', 'x-altinity-order',
  'x-altinity-deprecated', 'x-altinity-status',
];

const pointerSegments = (pointer: unknown): string[] => String(pointer || '').split('/').slice(1)
  .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

function pathFromPointer(root: unknown, pointer: unknown): (string | number)[] {
  const path: (string | number)[] = [];
  let value: unknown = root;
  for (const segment of pointerSegments(pointer)) {
    const key: string | number = Array.isArray(value) && /^\d+$/.test(segment) ? Number(segment) : segment;
    path.push(key);
    value = value == null ? undefined : (value as Record<string | number, unknown>)[key];
  }
  return path;
}

const pathPrefix = (a: (string | number)[], b: (string | number)[]): boolean =>
  a.length <= b.length && a.every((segment, index) => segment === b[index]);
const pathsOverlap = (a: (string | number)[], b: (string | number)[]): boolean => pathPrefix(a, b) || pathPrefix(b, a);

export function formatSpecPath(path: (string | number)[] = []): string {
  return formatJsonPath(path, 'Spec');
}

function schemaCandidatesAtPath(schemaRoot: JsonSchemaNode, root: unknown, path: (string | number)[]): JsonSchemaNode[] {
  let candidates: JsonSchemaNode[] = [schemaRoot];
  let value: unknown = root;
  for (const segment of path) {
    candidates = uniqueSchemas(candidates.flatMap((candidate) => expand(schemaRoot, candidate, value)
      .map((expanded) => childSchema(expanded, segment)).filter((s): s is JsonSchemaNode => s != null)));
    value = value == null ? undefined : (value as Record<string | number, unknown>)[segment];
  }
  return uniqueSchemas(candidates.flatMap((candidate) => expand(schemaRoot, candidate, value)));
}

function normalizeCompiledErrors(schemaRoot: JsonSchemaNode, root: unknown, errors: SchemaValidationError[] = []): SchemaDiagnostic[] {
  let filteredErrors = [...errors];
  for (const variant of errors.filter((error) => error.keyword === 'oneOf')) {
    const variantPath = pathFromPointer(root, variant.instancePath);
    const value = valueAtPath(root, variantPath).value;
    const selected = schemaCandidatesAtPath(schemaRoot, root, variantPath);
    const discriminator = selected.find((candidate) => candidate['x-altinity-discriminator'])?.['x-altinity-discriminator'];
    if (!discriminator) continue;
    const allowed = new Set<string | number>(selected.flatMap((candidate) => Object.keys(candidate.properties || {})));
    const hasDiscriminator = own(value, discriminator);
    filteredErrors = filteredErrors.filter((error) => {
      const errorPath = pathFromPointer(root, error.instancePath);
      if (!pathPrefix(variantPath, errorPath)) return true;
      if (error === variant || ['const', 'not'].includes(error.keyword)) return false;
      if (!hasDiscriminator) {
        return error.keyword === 'required' && error.params?.missingProperty === discriminator
          && !error.schemaPath!.includes('/oneOf/');
      }
      if (error.keyword === 'required') return allowed.has(error.params?.missingProperty as string);
      const property = errorPath[variantPath.length];
      return property == null || allowed.has(property);
    });
  }

  return normalizeJsonSchemaErrors({
    root, errors: filteredErrors, schemaId: schemaRoot.$id, formatPath: formatSpecPath,
  });
}

function pointerValue(root: unknown, ref: unknown): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    throw new Error('Only local schema references are supported: ' + String(ref));
  }
  let value: unknown = root;
  for (const segment of pointerSegments(ref.slice(1))) {
    if (!isObject(value) && !Array.isArray(value)) throw new Error('Unresolved schema reference: ' + ref);
    const obj = value as Record<string, unknown>;
    if (!Object.hasOwn(obj, segment)) throw new Error('Unresolved schema reference: ' + ref);
    value = obj[segment];
  }
  return value;
}

function mergeSchema(left: unknown, right: unknown): unknown {
  if (!isObject(left)) return isObject(right) ? { ...right } : right;
  if (!isObject(right)) return { ...left };
  const l = left as JsonSchemaNode;
  const r = right as JsonSchemaNode;
  const mergeMaps = (
    leftMap: Record<string, JsonSchemaNode> = {},
    rightMap: Record<string, JsonSchemaNode> = {},
  ): Record<string, JsonSchemaNode> => {
    const result: Record<string, JsonSchemaNode> = { ...leftMap };
    for (const [key, value] of Object.entries(rightMap)) {
      result[key] = Object.hasOwn(result, key) ? (mergeSchema(result[key], value) as JsonSchemaNode) : value;
    }
    return result;
  };
  const merged: JsonSchemaNode = { ...l, ...r };
  if (l.properties || r.properties) merged.properties = mergeMaps(l.properties, r.properties);
  if (l.patternProperties || r.patternProperties) {
    merged.patternProperties = mergeMaps(l.patternProperties, r.patternProperties);
  }
  if (l.required || r.required) merged.required = [...new Set([...(l.required || []), ...(r.required || [])])];
  if (l['x-altinity-order'] || r['x-altinity-order']) {
    merged['x-altinity-order'] = [...new Set([...(l['x-altinity-order'] || []), ...(r['x-altinity-order'] || [])])];
  }
  return merged;
}

function dereference(schemaRoot: JsonSchemaNode, schema: JsonSchemaNode, seen: Set<string> = new Set()): JsonSchemaNode {
  if (!isObject(schema) || !schema.$ref) return schema;
  if (seen.has(schema.$ref)) throw new Error('Cyclic schema reference: ' + schema.$ref);
  const nextSeen = new Set(seen).add(schema.$ref);
  const { $ref: _ref, ...siblings } = schema;
  return mergeSchema(dereference(schemaRoot, pointerValue(schemaRoot, schema.$ref) as JsonSchemaNode, nextSeen), siblings) as JsonSchemaNode;
}

function valueTypeMatches(value: unknown, type: string | string[]): boolean {
  if (Array.isArray(type)) return type.some((item) => valueTypeMatches(value, item));
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function matches(schemaRoot: JsonSchemaNode, rawSchema: JsonSchemaNode, value: unknown): boolean {
  const schema = dereference(schemaRoot, rawSchema);
  if (!isObject(schema)) return true;
  if (schema.type && !valueTypeMatches(value, schema.type)) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (schema.required) {
    if (!isObject(value)) return false;
    const dataValue = value;
    const requiredKeys = schema.required;
    if (requiredKeys.some((key) => !Object.hasOwn(dataValue, key))) return false;
  }
  if (schema.properties && isObject(value)) {
    const dataValue = value;
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(dataValue, key) && !matches(schemaRoot, child, dataValue[key])) return false;
    }
  }
  if (schema.not && matches(schemaRoot, schema.not, value)) return false;
  if (schema.allOf && !schema.allOf.every((child) => matches(schemaRoot, child, value))) return false;
  if (schema.anyOf && !schema.anyOf.some((child) => matches(schemaRoot, child, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((child) => matches(schemaRoot, child, value)).length !== 1) return false;
  return true;
}

function discriminatorConstraint(schemaRoot: JsonSchemaNode, rawSchema: JsonSchemaNode, property: string): ((value: unknown) => boolean) | null {
  const schema = dereference(schemaRoot, rawSchema);
  if (!isObject(schema)) return null;
  if (schema.properties?.[property]) {
    const prop = dereference(schemaRoot, schema.properties[property]);
    if (Object.hasOwn(prop, 'const')) { const constValue = prop.const; return (value: unknown): boolean => value === constValue; }
    if (prop.enum) { const enumValues = prop.enum; return (value: unknown): boolean => enumValues.includes(value); }
    if (prop.not?.enum) { const excluded = prop.not.enum; return (value: unknown): boolean => !excluded.includes(value); }
  }
  if (schema.allOf) {
    for (const child of schema.allOf) {
      const constraint = discriminatorConstraint(schemaRoot, child, property);
      if (constraint) return constraint;
    }
  }
  return null;
}

function expand(schemaRoot: JsonSchemaNode, rawSchema: JsonSchemaNode, value: unknown): JsonSchemaNode[] {
  let schemas: JsonSchemaNode[] = [dereference(schemaRoot, rawSchema)];
  const allOf = schemas[0]?.allOf || [];
  if (allOf.length) {
    const { allOf: _allOf, ...base } = schemas[0];
    schemas = [base as JsonSchemaNode];
    for (const child of allOf) {
      const expanded = expand(schemaRoot, child, value);
      schemas = schemas.flatMap((left) => expanded.map((right) => mergeSchema(left, right) as JsonSchemaNode));
    }
  }

  schemas = schemas.flatMap((schema): JsonSchemaNode[] => {
    if (!schema.if) return [schema];
    const { if: condition, then, else: otherwise, ...base } = schema;
    const selected = matches(schemaRoot, condition as JsonSchemaNode, value) ? then : otherwise;
    return selected ? expand(schemaRoot, selected, value).map((item) => mergeSchema(base, item) as JsonSchemaNode) : [base as JsonSchemaNode];
  });

  return schemas.flatMap((schema): JsonSchemaNode[] => {
    const variants = schema.oneOf || schema.anyOf;
    if (!variants) return [schema];
    const { oneOf: _oneOf, anyOf: _anyOf, ...base } = schema;
    const discriminator = schema['x-altinity-discriminator'];
    let selected = variants;
    if (discriminator && isObject(value) && Object.hasOwn(value, discriminator)) {
      const dataValue = value;
      const activeDiscriminator = discriminator;
      const constrained = variants.filter((variant) => {
        const test = discriminatorConstraint(schemaRoot, variant, activeDiscriminator);
        return !!test && test(dataValue[activeDiscriminator]);
      });
      if (constrained.length) selected = constrained;
    }
    return selected.flatMap((variant) => expand(schemaRoot, variant, value)
      .map((item) => mergeSchema(base, item) as JsonSchemaNode));
  });
}

function commonValue<T>(values: T[]): T | undefined {
  // Callers derive this list from at least one active schema candidate.
  if (values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))) return values[0];
  if (values.every(isObject)) {
    const common: Record<string, unknown> = {};
    const first = values[0] as Record<string, unknown>;
    const keys = Object.keys(first).filter((key) => values.every((value) => Object.hasOwn(value as Record<string, unknown>, key)));
    for (const key of keys) {
      const value = commonValue(values.map((item) => (item as Record<string, unknown>)[key]));
      if (value !== undefined) common[key] = value;
    }
    return common as T;
  }
  return undefined;
}

function childSchema(schema: unknown, segment: string | number): JsonSchemaNode | null {
  if (!isObject(schema)) return null;
  const s = schema as JsonSchemaNode;
  if (typeof segment === 'number') {
    if (Array.isArray(s.prefixItems) && s.prefixItems[segment]) return s.prefixItems[segment];
    return isObject(s.items) ? s.items : null;
  }
  if (s.properties && Object.hasOwn(s.properties, segment)) return s.properties[segment];
  for (const [pattern, candidate] of Object.entries(s.patternProperties || {})) {
    if (new RegExp(pattern).test(segment)) return candidate;
  }
  return isObject(s.additionalProperties) ? s.additionalProperties : null;
}

function uniqueSchemas<T>(schemas: T[]): T[] {
  const seen = new Set<string>();
  return schemas.filter((schema) => {
    const key = JSON.stringify(schema);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `schemaAtPath`'s result: the merged (`common`) schema at a path plus every
 *  discriminated branch (`candidates`) still in play there. */
export interface SchemaEnvelope {
  common: JsonSchemaNode;
  candidates: JsonSchemaNode[];
}

/** One property `propertiesAtPath` reports for an object schema. */
export interface SchemaPropertyEntry {
  name: string;
  required: boolean;
  schemas: JsonSchemaNode[];
}

/** `annotationsAtPath`'s result — the presentation/authoring annotations
 *  (`ANNOTATION_KEYS`) present on the common schema and on each candidate. */
export interface SchemaAnnotations {
  common: Record<string, unknown>;
  candidates: Record<string, unknown>[];
}

/** One finite discriminator value `variantsAtPath` reports, with its owning
 *  branch's presentation annotations attached. */
export interface SchemaVariantEntry {
  value: unknown;
  schema: JsonSchemaNode;
  title?: string;
  description?: string;
  status?: string;
  deprecated: boolean;
  snippet?: unknown;
  order: number;
}

/** `schemaAtPath`/`propertiesAtPath`/`annotationsAtPath`/`variantsAtPath`'s
 *  shared args: a root document value and the path into it. */
export interface SchemaPathArgs {
  root: unknown;
  path?: (string | number)[];
}

/** The stable app-facing Spec schema service `createSpecSchemaService`
 *  builds — canonical validation plus schema introspection at a path. */
export interface SpecSchemaService {
  schema: JsonSchemaNode;
  validate(value: unknown): SchemaDiagnostic[];
  schemaAtPath(args: SchemaPathArgs): SchemaEnvelope;
  propertiesAtPath(args: SchemaPathArgs): SchemaPropertyEntry[];
  annotationsAtPath(args: SchemaPathArgs): SchemaAnnotations;
  variantsAtPath(args: SchemaPathArgs): SchemaVariantEntry[];
}

/** `createSpecSchemaService`'s options bag. Both fields are `unknown` (not
 *  `JsonSchemaNode`/`JsonSchemaValidatorFn`) because this constructor is
 *  itself the runtime boundary check for them (`Spec schema must be an
 *  object` / `... must be a function`, below) — a real caller always passes
 *  the honest shape, but a malformed one is a first-class rejected input,
 *  not a caller contract. */
export interface CreateSpecSchemaServiceInput {
  schema: unknown;
  validateCompiled: unknown;
}

export function createSpecSchemaService(input: CreateSpecSchemaServiceInput): SpecSchemaService {
  const { schema: rawSchema, validateCompiled: rawValidateCompiled } = input;
  if (!isObject(rawSchema)) throw new Error('Spec schema must be an object');
  if (typeof rawValidateCompiled !== 'function') throw new Error('Compiled Spec validator must be a function');
  const schema = rawSchema as JsonSchemaNode;
  const validateCompiled = rawValidateCompiled as JsonSchemaValidatorFn;

  const schemaAtPath = ({ root, path = [] }: SchemaPathArgs): SchemaEnvelope => {
    let candidates: JsonSchemaNode[] = [schema];
    let value: unknown = root;
    for (const segment of path) {
      candidates = uniqueSchemas(candidates.flatMap((candidate) => expand(schema, candidate, value)
        .map((expanded) => childSchema(expanded, segment)).filter((s): s is JsonSchemaNode => s != null)));
      value = value == null ? undefined : (value as Record<string | number, unknown>)[segment];
      if (!candidates.length) return { common: {}, candidates: [] };
    }
    candidates = uniqueSchemas(candidates.flatMap((candidate) => expand(schema, candidate, value)));
    return { common: commonValue(candidates) || {}, candidates };
  };

  const propertiesAtPath = ({ root, path = [] }: SchemaPathArgs): SchemaPropertyEntry[] => {
    const envelope = schemaAtPath({ root, path });
    const current = valueAtPath(root, path).value as Record<string, unknown> | null | undefined;
    const names: string[] = [];
    const add = (name: string): void => { if (!names.includes(name)) names.push(name); };
    const discriminator = envelope.common['x-altinity-discriminator'];
    if (discriminator) add(discriminator);
    for (const name of envelope.common['x-altinity-order'] || []) add(name);
    for (const name of Object.keys(envelope.common.properties || {})) add(name);
    for (const candidate of envelope.candidates) {
      for (const name of candidate['x-altinity-order'] || []) add(name);
      for (const name of Object.keys(candidate.properties || {})) add(name);
    }
    return names.filter((name) => envelope.candidates.some((candidate) => candidate.properties?.[name]))
      .map((name): SchemaPropertyEntry => ({
        name,
        required: envelope.candidates.length > 0
          && envelope.candidates.every((candidate) => (candidate.required || []).includes(name)),
        schemas: uniqueSchemas(envelope.candidates.map((candidate) => candidate.properties?.[name]).filter((s): s is JsonSchemaNode => s != null)
          .flatMap((candidate) => expand(schema, candidate, current == null ? undefined : current[name]))),
      }));
  };

  const annotationsAtPath = ({ root, path = [] }: SchemaPathArgs): SchemaAnnotations => {
    const envelope = schemaAtPath({ root, path });
    const pick = (candidate: JsonSchemaNode): Record<string, unknown> => Object.fromEntries(ANNOTATION_KEYS
      .filter((key) => Object.hasOwn(candidate, key)).map((key) => [key, candidate[key]]));
    return { common: pick(envelope.common), candidates: envelope.candidates.map(pick) };
  };

  /**
   * Finite values for a discriminated property, with the owning branch's
   * presentation annotations attached. The active value is deliberately
   * removed before resolving the parent so editing an existing discriminator
   * still offers every explicit canonical branch. Negative/fallback branches
   * have no positive const/enum and therefore never become fake candidates.
   */
  const variantsAtPath = ({ root, path = [] }: SchemaPathArgs): SchemaVariantEntry[] => {
    if (!path.length || typeof path.at(-1) !== 'string') return [];
    const property = path.at(-1) as string;
    const parentPath = path.slice(0, -1);
    const withoutActiveValue = (value: unknown, segments: (string | number)[], index = 0): unknown => {
      if (!isObject(value) && !Array.isArray(value)) return value;
      const copy: unknown = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
      const segment = segments[index];
      if (index === segments.length - 1) {
        // variantsAtPath requires the final segment to be a property name.
        delete (copy as Record<string, unknown>)[segment as string];
      } else if (Object.hasOwn(copy as object, segment)) {
        (copy as Record<string | number, unknown>)[segment] =
          withoutActiveValue((copy as Record<string | number, unknown>)[segment], segments, index + 1);
      }
      return copy;
    };
    const lookupRoot = withoutActiveValue(root, path);
    const parent = schemaAtPath({ root: lookupRoot, path: parentPath });
    if (parent.common['x-altinity-discriminator'] !== property) return [];
    const out: SchemaVariantEntry[] = [];
    const seen = new Set<string>();
    parent.candidates.forEach((branch, branchOrder) => {
      const raw = branch.properties?.[property];
      if (!raw) return;
      for (const valueSchema of expand(schema, raw, undefined)) {
        const values: unknown[] = Object.hasOwn(valueSchema, 'const')
          ? [valueSchema.const]
          : (Array.isArray(valueSchema.enum) ? valueSchema.enum : []);
        for (const value of values) {
          const key = JSON.stringify(value);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            value,
            schema: valueSchema,
            title: branch.title || valueSchema.title,
            description: branch.description || valueSchema.description,
            status: branch['x-altinity-status'],
            deprecated: branch['x-altinity-deprecated'] === true,
            snippet: branch['x-altinity-snippet'],
            order: branchOrder,
          });
        }
      }
    });
    return out;
  };

  return {
    schema,
    validate(value: unknown): SchemaDiagnostic[] {
      return validateCompiled(value) ? [] : normalizeCompiledErrors(schema, value, validateCompiled.errors || []);
    },
    schemaAtPath,
    propertiesAtPath,
    annotationsAtPath,
    variantsAtPath,
  };
}

interface ValueAtPathResult {
  present: boolean;
  value: unknown;
}

function valueAtPath(root: unknown, path: (string | number)[]): ValueAtPathResult {
  let value: unknown = root;
  for (const segment of path) {
    if (value == null || !Object.hasOwn(Object(value), segment)) return { present: false, value: undefined };
    value = (value as Record<string | number, unknown>)[segment];
  }
  return { present: true, value };
}

/** One "feature validator" registration's call args: the Spec root/path it's
 *  scoped to, whether a value is present there, that value, and app-supplied
 *  context (e.g. the linked SQL — see `spec-draft.js`'s CORE_SPEC_VALIDATORS). */
export interface FeatureValidatorArgs {
  root: unknown;
  path: (string | number)[];
  present: boolean;
  value: unknown;
  context: unknown;
}

/** A diagnostic a feature validator reports — every field is optional and
 *  defaulted by `createSpecValidationService` (`message` is `String()`-
 *  coerced there, so a validator that hands back a non-string message still
 *  produces a usable diagnostic). `severity` shares the editor-facing
 *  `SpecDiagnostic` union (`spec-editor.types.ts`) — every feature validator
 *  today (`CORE_SPEC_VALIDATORS`) only ever reports `'error'`, but the
 *  registry is a general extension point. */
export interface FeatureDiagnostic {
  path?: (string | number)[];
  severity?: 'error' | 'warning';
  code?: string;
  message?: unknown;
  keyword?: string;
}

export type FeatureValidatorFn = (args: FeatureValidatorArgs) => FeatureDiagnostic | FeatureDiagnostic[] | undefined;

/** One registered feature validator — a Spec path plus its rule. */
export interface ValidatorEntry {
  path: (string | number)[];
  validate: FeatureValidatorFn;
}

/** A diagnostic `createSpecValidationService`'s `validate` reports — the
 *  canonical schema's own diagnostics (always `severity: 'error'`) plus
 *  whatever a feature validator produced (defaulted the same way). */
export interface SpecValidationDiagnostic {
  path: (string | number)[];
  severity: 'error' | 'warning';
  code: string;
  message: string;
  keyword?: string;
}

/** `createSpecValidationService`'s options bag. `schemaService` is `unknown`
 *  for the same reason `CreateSpecSchemaServiceInput`'s fields are: this
 *  constructor is itself the runtime boundary check (`Spec schema service is
 *  required`, below). */
export interface CreateSpecValidationServiceInput {
  schemaService: unknown;
  initial?: readonly ValidatorEntry[];
}

/** The app-owned Spec validation service — canonical schema validation
 *  composed with registered feature/runtime rules. */
export interface SpecValidationService {
  schema: JsonSchemaNode;
  schemaService: SpecSchemaService;
  register(path: (string | number)[], validate: FeatureValidatorFn): () => void;
  validate(spec: unknown, context?: unknown): SpecValidationDiagnostic[];
}

/** Compose canonical validation with app-owned feature/runtime validators. */
export function createSpecValidationService(
  input: CreateSpecValidationServiceInput,
): SpecValidationService {
  const { schemaService: rawSchemaService, initial = [] } = input;
  const candidate = rawSchemaService as SpecSchemaService | null | undefined;
  if (!candidate || typeof candidate.validate !== 'function') throw new Error('Spec schema service is required');
  const schemaService = candidate;
  const entries: ValidatorEntry[] = [...initial];
  return {
    schema: schemaService.schema,
    schemaService,
    register(path: (string | number)[], validate: FeatureValidatorFn): () => void {
      const entry: ValidatorEntry = { path: [...path], validate };
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    validate(spec: unknown, context: unknown = {}): SpecValidationDiagnostic[] {
      const diagnostics: SpecValidationDiagnostic[] = schemaService.validate(spec);
      for (const entry of entries) {
        if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'
          && pathsOverlap(diagnostic.path, entry.path))) continue;
        const produced = entry.validate({ root: spec, path: [...entry.path], ...valueAtPath(spec, entry.path), context }) || [];
        for (const diagnostic of Array.isArray(produced) ? produced : [produced]) {
          diagnostics.push({
            path: [...(diagnostic.path || entry.path)],
            severity: diagnostic.severity || 'error',
            code: diagnostic.code || 'invalid-spec',
            message: String(diagnostic.message || 'Invalid Spec value'),
            ...(diagnostic.keyword ? { keyword: diagnostic.keyword } : {}),
          });
        }
      }
      return diagnostics;
    },
  };
}

export const querySpecSchemaService: SpecSchemaService = createSpecSchemaService({
  schema: querySpecSchema,
  validateCompiled: validateQuerySpec,
});

export const createQuerySpecValidationService = (
  initial: readonly ValidatorEntry[] = [],
): SpecValidationService => createSpecValidationService({ schemaService: querySpecSchemaService, initial });
