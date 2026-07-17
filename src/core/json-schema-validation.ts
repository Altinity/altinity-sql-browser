// Pure normalization for generated JSON Schema validators. Runtime callers
// receive stable application diagnostics, never Ajv-specific error objects.

/** One Ajv validation error, narrowed to exactly the fields this module
 *  reads — `params`' own shape varies per `keyword` (Ajv's own contract), so
 *  it stays a generic bag read through targeted casts at each keyword arm. */
export interface SchemaValidationError {
  keyword: string;
  instancePath?: string;
  params?: Record<string, unknown>;
  message?: string;
  schemaPath?: string;
}

/** One normalized, stable application diagnostic — never an Ajv-specific
 *  error object. */
export interface SchemaDiagnostic {
  path: (string | number)[];
  severity: 'error';
  code: string;
  message: string;
  keyword: string;
  schemaId?: string;
  [key: string]: unknown;
}

export const JSON_SCHEMA_KEYWORD_CODES: Record<string, string> = {
  type: 'schema-invalid-type', required: 'schema-required',
  const: 'schema-invalid-constant', enum: 'schema-invalid-enum',
  minimum: 'schema-number-range', maximum: 'schema-number-range',
  exclusiveMinimum: 'schema-number-range', exclusiveMaximum: 'schema-number-range',
  minLength: 'schema-invalid-string', maxLength: 'schema-invalid-string', pattern: 'schema-invalid-string',
  minItems: 'schema-array-size', maxItems: 'schema-array-size', uniqueItems: 'schema-array-duplicate',
  minProperties: 'schema-object-size', maxProperties: 'schema-object-size',
  propertyNames: 'schema-property-name',
  oneOf: 'schema-invalid-variant', anyOf: 'schema-invalid-variant', not: 'schema-invalid-variant',
  additionalProperties: 'schema-unknown-property', unevaluatedProperties: 'schema-unknown-property',
  format: 'schema-invalid-format', '$ref': 'schema-internal-reference',
};

// Narrows `unknown` to `unknown[]` (unlike the built-in `Array.isArray`,
// whose declared predicate is `arg is any[]`) so downstream array methods
// (`.join`/`.map`) stay typed rather than silently widening to `any`.
function isArrayValue(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export const pointerSegments = (pointer: unknown): string[] => String(pointer || '').split('/').slice(1)
  .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

export function pathFromJsonPointer(root: unknown, pointer: unknown): (string | number)[] {
  const path: (string | number)[] = [];
  let value: unknown = root;
  for (const segment of pointerSegments(pointer)) {
    const key: string | number = isArrayValue(value) && /^\d+$/.test(segment) ? Number(segment) : segment;
    path.push(key);
    value = value == null ? undefined : (value as Record<string | number, unknown>)[key];
  }
  return path;
}

export function formatJsonPath(path: (string | number)[] = [], rootLabel = 'Document'): string {
  if (!path.length) return rootLabel;
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(segment)) out += (out ? '.' : '') + segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

const pathPrefix = (a: (string | number)[], b: (string | number)[]): boolean =>
  a.length <= b.length && a.every((segment, index) => segment === b[index]);

function diagnosticMessage(
  error: SchemaValidationError,
  path: (string | number)[],
  formatPath: (path: (string | number)[]) => string,
): string {
  const at = formatPath(path);
  const params = error.params || {};
  switch (error.keyword) {
    case 'type': return `${at} must be ${isArrayValue(params.type) ? params.type.join(' or ') : params.type}`;
    case 'required': return `${at} is required`;
    case 'const': return `${at} must equal ${JSON.stringify(params.allowedValue)}`;
    case 'enum': return `${at} must be one of ${(isArrayValue(params.allowedValues) ? params.allowedValues : []).map((v) => JSON.stringify(v)).join(', ')}`;
    case 'minimum': return `${at} must be at least ${params.limit}`;
    case 'maximum': return `${at} must be at most ${params.limit}`;
    case 'exclusiveMinimum': return `${at} must be greater than ${params.limit}`;
    case 'exclusiveMaximum': return `${at} must be less than ${params.limit}`;
    case 'minLength': return `${at} must contain at least ${params.limit} character${params.limit === 1 ? '' : 's'}`;
    case 'maxLength': return `${at} must contain at most ${params.limit} characters`;
    case 'pattern': return `${at} has an invalid string value`;
    case 'minItems': return `${at} must contain at least ${params.limit} item${params.limit === 1 ? '' : 's'}`;
    case 'maxItems': return `${at} must contain at most ${params.limit} item${params.limit === 1 ? '' : 's'}`;
    case 'uniqueItems': return `${at} must not contain duplicate items`;
    case 'minProperties': return `${at} must contain at least ${params.limit} propert${params.limit === 1 ? 'y' : 'ies'}`;
    case 'maxProperties': return `${at} must contain at most ${params.limit} properties`;
    case 'propertyNames': return `${at} is an invalid property name`;
    case 'oneOf': return `${at} must match exactly one allowed variant`;
    case 'anyOf': return `${at} must match an allowed variant`;
    case 'additionalProperties':
    case 'unevaluatedProperties': return `${at} is not an allowed property`;
    case 'format': return `${at} must match format ${JSON.stringify(params.format)}`;
    case '$ref': return `${at} contains an unresolved schema reference`;
    default: return `${at} ${error.message || 'is invalid'}`;
  }
}

function schemaIdFor(error: SchemaValidationError, fallback?: string): string | undefined {
  const path = String(error.schemaPath || '');
  return path.startsWith('https://') || path.startsWith('http://') ? path.split('#')[0] : fallback;
}

/** `normalizeJsonSchemaErrors`'s options bag. */
export interface NormalizeJsonSchemaErrorsInput {
  root: unknown;
  errors?: SchemaValidationError[];
  schemaId?: string;
  keywordCodes?: Record<string, string>;
  formatPath?: (path: (string | number)[]) => string;
}

export function normalizeJsonSchemaErrors({
  root, errors = [], schemaId, keywordCodes = JSON_SCHEMA_KEYWORD_CODES,
  formatPath = (path) => formatJsonPath(path),
}: NormalizeJsonSchemaErrorsInput): SchemaDiagnostic[] {
  let diagnostics: SchemaDiagnostic[] = errors.map((error) => {
    const path = pathFromJsonPointer(root, error.instancePath);
    if (error.keyword === 'required' && error.params?.missingProperty != null) path.push(error.params.missingProperty as string);
    else if (error.keyword === 'uniqueItems' && Number.isInteger(error.params?.i)) path.push(error.params!.i as number);
    else if (error.keyword === 'additionalProperties' && error.params?.additionalProperty != null) {
      path.push(error.params.additionalProperty as string);
    } else if (error.keyword === 'unevaluatedProperties' && error.params?.unevaluatedProperty != null) {
      path.push(error.params.unevaluatedProperty as string);
    } else if (error.keyword === 'propertyNames' && error.params?.propertyName != null) {
      path.push(error.params.propertyName as string);
    }
    const diagnosticSchemaId = schemaIdFor(error, schemaId);
    return {
      path, severity: 'error' as const,
      code: keywordCodes[error.keyword] || `schema-${error.keyword || 'invalid'}`,
      message: diagnosticMessage(error, path, formatPath), keyword: error.keyword,
      ...(diagnosticSchemaId ? { schemaId: diagnosticSchemaId } : {}),
    };
  });

  for (const variant of diagnostics.filter((item) => item.keyword === 'oneOf')) {
    const related = diagnostics.filter((item) => item !== variant && pathPrefix(variant.path, item.path));
    const actionable = related.filter((item) => !['const', 'not', 'oneOf'].includes(item.keyword));
    const hasChild = actionable.some((item) => item.path.length > variant.path.length || item.keyword === 'required');
    if (hasChild) {
      diagnostics = diagnostics.filter((item) => item !== variant
        && !(related.includes(item) && ['const', 'not'].includes(item.keyword)));
    } else if (actionable.length) diagnostics = diagnostics.filter((item) => item === variant || !related.includes(item));
  }

  const invalidTypePaths = diagnostics.filter((item) => item.keyword === 'type').map((item) => JSON.stringify(item.path));
  diagnostics = diagnostics.filter((item) => item.keyword === 'type'
    || !invalidTypePaths.includes(JSON.stringify(item.path)));

  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.path, diagnostic.code, diagnostic.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => JSON.stringify(a.path).localeCompare(JSON.stringify(b.path))
    || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

/** One generated Ajv validator function — `errors` is populated by Ajv
 *  itself after a failed `validate(value)` call. */
export interface JsonSchemaValidatorFn {
  (value: unknown): boolean;
  errors?: SchemaValidationError[] | null;
}

/** `createJsonSchemaValidationService`'s options bag. */
export interface CreateJsonSchemaValidationServiceInput {
  schemasById?: Record<string, unknown>;
  validatorsById?: Record<string, JsonSchemaValidatorFn>;
  keywordCodes?: Record<string, string>;
}

/** The service `createJsonSchemaValidationService` builds. */
export interface JsonSchemaValidationService {
  getSchema(schemaId: string): unknown;
  validate(schemaId: string, value: unknown): SchemaDiagnostic[];
}

export function createJsonSchemaValidationService({
  schemasById, validatorsById, keywordCodes,
}: CreateJsonSchemaValidationServiceInput = {}): JsonSchemaValidationService {
  if (!schemasById || !validatorsById) throw new Error('Schema and validator registries are required');
  const getSchema = (schemaId: string): unknown => schemasById[schemaId];
  return {
    getSchema,
    validate(schemaId: string, value: unknown): SchemaDiagnostic[] {
      const schema = getSchema(schemaId);
      const validate = validatorsById[schemaId];
      if (!schema || typeof validate !== 'function') throw new Error('Unknown JSON Schema: ' + String(schemaId));
      return validate(value) ? [] : normalizeJsonSchemaErrors({
        root: value, errors: validate.errors || [], schemaId, keywordCodes,
      });
    },
  };
}
