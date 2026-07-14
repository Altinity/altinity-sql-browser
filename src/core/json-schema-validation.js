// Pure normalization for generated JSON Schema validators. Runtime callers
// receive stable application diagnostics, never Ajv-specific error objects.

export const JSON_SCHEMA_KEYWORD_CODES = {
  type: 'schema-invalid-type', required: 'schema-required',
  const: 'schema-invalid-constant', enum: 'schema-invalid-enum',
  minimum: 'schema-number-range', maximum: 'schema-number-range',
  exclusiveMinimum: 'schema-number-range', exclusiveMaximum: 'schema-number-range',
  minLength: 'schema-invalid-string', maxLength: 'schema-invalid-string', pattern: 'schema-invalid-string',
  minItems: 'schema-array-size', maxItems: 'schema-array-size', uniqueItems: 'schema-array-duplicate',
  oneOf: 'schema-invalid-variant', anyOf: 'schema-invalid-variant', not: 'schema-invalid-variant',
  additionalProperties: 'schema-unknown-property', unevaluatedProperties: 'schema-unknown-property',
  format: 'schema-invalid-format', '$ref': 'schema-internal-reference',
};

export const pointerSegments = (pointer) => String(pointer || '').split('/').slice(1)
  .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

export function pathFromJsonPointer(root, pointer) {
  const path = [];
  let value = root;
  for (const segment of pointerSegments(pointer)) {
    const key = Array.isArray(value) && /^\d+$/.test(segment) ? Number(segment) : segment;
    path.push(key);
    value = value == null ? undefined : value[key];
  }
  return path;
}

export function formatJsonPath(path = [], rootLabel = 'Document') {
  if (!path.length) return rootLabel;
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(segment)) out += (out ? '.' : '') + segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

const pathPrefix = (a, b) => a.length <= b.length && a.every((segment, index) => segment === b[index]);

function diagnosticMessage(error, path, formatPath) {
  const at = formatPath(path);
  const params = error.params || {};
  switch (error.keyword) {
    case 'type': return `${at} must be ${Array.isArray(params.type) ? params.type.join(' or ') : params.type}`;
    case 'required': return `${at} is required`;
    case 'const': return `${at} must equal ${JSON.stringify(params.allowedValue)}`;
    case 'enum': return `${at} must be one of ${(params.allowedValues || []).map(JSON.stringify).join(', ')}`;
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
    case 'oneOf': return `${at} must match exactly one allowed variant`;
    case 'anyOf': return `${at} must match an allowed variant`;
    case 'additionalProperties':
    case 'unevaluatedProperties': return `${at} is not an allowed property`;
    case 'format': return `${at} must match format ${JSON.stringify(params.format)}`;
    case '$ref': return `${at} contains an unresolved schema reference`;
    default: return `${at} ${error.message || 'is invalid'}`;
  }
}

function schemaIdFor(error, fallback) {
  const path = String(error.schemaPath || '');
  return path.startsWith('https://') || path.startsWith('http://') ? path.split('#')[0] : fallback;
}

export function normalizeJsonSchemaErrors({
  root, errors = [], schemaId, keywordCodes = JSON_SCHEMA_KEYWORD_CODES,
  formatPath = (path) => formatJsonPath(path),
}) {
  let diagnostics = errors.map((error) => {
    const path = pathFromJsonPointer(root, error.instancePath);
    if (error.keyword === 'required' && error.params?.missingProperty != null) path.push(error.params.missingProperty);
    else if (error.keyword === 'uniqueItems' && Number.isInteger(error.params?.i)) path.push(error.params.i);
    else if (error.keyword === 'additionalProperties' && error.params?.additionalProperty != null) {
      path.push(error.params.additionalProperty);
    } else if (error.keyword === 'unevaluatedProperties' && error.params?.unevaluatedProperty != null) {
      path.push(error.params.unevaluatedProperty);
    }
    const diagnosticSchemaId = schemaIdFor(error, schemaId);
    return {
      path, severity: 'error',
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

  const seen = new Set();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.path, diagnostic.code, diagnostic.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => JSON.stringify(a.path).localeCompare(JSON.stringify(b.path))
    || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

export function createJsonSchemaValidationService({ schemasById, validatorsById, keywordCodes } = {}) {
  if (!schemasById || !validatorsById) throw new Error('Schema and validator registries are required');
  const getSchema = (schemaId) => schemasById[schemaId];
  return {
    getSchema,
    validate(schemaId, value) {
      const schema = getSchema(schemaId);
      const validate = validatorsById[schemaId];
      if (!schema || typeof validate !== 'function') throw new Error('Unknown JSON Schema: ' + String(schemaId));
      return validate(value) ? [] : normalizeJsonSchemaErrors({
        root: value, errors: validate.errors || [], schemaId, keywordCodes,
      });
    },
  };
}
