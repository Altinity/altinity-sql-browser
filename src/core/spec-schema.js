// Pure query.spec schema validation and introspection. The canonical schema
// and compiled validator are generated at build time; this module normalizes
// their output and exposes the stable app-facing service.

import { querySpecV1Schema as querySpecSchema } from '../generated/json-schemas.js';
import { validateQuerySpecV1 as validateQuerySpec } from '../generated/json-schema-validators.js';
import { formatJsonPath, normalizeJsonSchemaErrors } from './json-schema-validation.js';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isObject(value) && Object.hasOwn(value, key);

const ANNOTATION_KEYS = [
  'title', 'description', 'default', 'examples',
  'x-altinity-discriminator', 'x-altinity-completion',
  'x-altinity-key-completion', 'x-altinity-snippet', 'x-altinity-order',
  'x-altinity-deprecated', 'x-altinity-status',
];

const pointerSegments = (pointer) => String(pointer || '').split('/').slice(1)
  .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

function pathFromPointer(root, pointer) {
  const path = [];
  let value = root;
  for (const segment of pointerSegments(pointer)) {
    const key = Array.isArray(value) && /^\d+$/.test(segment) ? Number(segment) : segment;
    path.push(key);
    value = value == null ? undefined : value[key];
  }
  return path;
}

const pathPrefix = (a, b) => a.length <= b.length && a.every((segment, index) => segment === b[index]);
const pathsOverlap = (a, b) => pathPrefix(a, b) || pathPrefix(b, a);

export function formatSpecPath(path = []) {
  return formatJsonPath(path, 'Spec');
}

function schemaCandidatesAtPath(schemaRoot, root, path) {
  let candidates = [schemaRoot];
  let value = root;
  for (const segment of path) {
    candidates = uniqueSchemas(candidates.flatMap((candidate) => expand(schemaRoot, candidate, value)
      .map((expanded) => childSchema(expanded, segment)).filter(Boolean)));
    value = value == null ? undefined : value[segment];
  }
  return uniqueSchemas(candidates.flatMap((candidate) => expand(schemaRoot, candidate, value)));
}

function normalizeCompiledErrors(schemaRoot, root, errors = []) {
  let filteredErrors = [...errors];
  for (const variant of errors.filter((error) => error.keyword === 'oneOf')) {
    const variantPath = pathFromPointer(root, variant.instancePath);
    const value = valueAtPath(root, variantPath).value;
    const selected = schemaCandidatesAtPath(schemaRoot, root, variantPath);
    const discriminator = selected.find((candidate) => candidate['x-altinity-discriminator'])?.['x-altinity-discriminator'];
    if (!discriminator) continue;
    const allowed = new Set(selected.flatMap((candidate) => Object.keys(candidate.properties || {})));
    const hasDiscriminator = own(value, discriminator);
    filteredErrors = filteredErrors.filter((error) => {
      const errorPath = pathFromPointer(root, error.instancePath);
      if (!pathPrefix(variantPath, errorPath)) return true;
      if (error === variant || ['const', 'not'].includes(error.keyword)) return false;
      if (!hasDiscriminator) {
        return error.keyword === 'required' && error.params?.missingProperty === discriminator
          && !error.schemaPath.includes('/oneOf/');
      }
      if (error.keyword === 'required') return allowed.has(error.params?.missingProperty);
      const property = errorPath[variantPath.length];
      return property == null || allowed.has(property);
    });
  }

  return normalizeJsonSchemaErrors({
    root, errors: filteredErrors, schemaId: schemaRoot.$id, formatPath: formatSpecPath,
  });
}

function pointerValue(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    throw new Error('Only local schema references are supported: ' + String(ref));
  }
  let value = root;
  for (const segment of pointerSegments(ref.slice(1))) {
    if (!isObject(value) && !Array.isArray(value)) throw new Error('Unresolved schema reference: ' + ref);
    if (!Object.hasOwn(value, segment)) throw new Error('Unresolved schema reference: ' + ref);
    value = value[segment];
  }
  return value;
}

function mergeSchema(left, right) {
  if (!isObject(left)) return isObject(right) ? { ...right } : right;
  if (!isObject(right)) return { ...left };
  const mergeMaps = (leftMap = {}, rightMap = {}) => {
    const result = { ...leftMap };
    for (const [key, value] of Object.entries(rightMap)) {
      result[key] = Object.hasOwn(result, key) ? mergeSchema(result[key], value) : value;
    }
    return result;
  };
  const merged = { ...left, ...right };
  if (left.properties || right.properties) merged.properties = mergeMaps(left.properties, right.properties);
  if (left.patternProperties || right.patternProperties) {
    merged.patternProperties = mergeMaps(left.patternProperties, right.patternProperties);
  }
  if (left.required || right.required) merged.required = [...new Set([...(left.required || []), ...(right.required || [])])];
  if (left['x-altinity-order'] || right['x-altinity-order']) {
    merged['x-altinity-order'] = [...new Set([...(left['x-altinity-order'] || []), ...(right['x-altinity-order'] || [])])];
  }
  return merged;
}

function dereference(schemaRoot, schema, seen = new Set()) {
  if (!isObject(schema) || !schema.$ref) return schema;
  if (seen.has(schema.$ref)) throw new Error('Cyclic schema reference: ' + schema.$ref);
  const nextSeen = new Set(seen).add(schema.$ref);
  const { $ref: _ref, ...siblings } = schema;
  return mergeSchema(dereference(schemaRoot, pointerValue(schemaRoot, schema.$ref), nextSeen), siblings);
}

function valueTypeMatches(value, type) {
  if (Array.isArray(type)) return type.some((item) => valueTypeMatches(value, item));
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function matches(schemaRoot, rawSchema, value) {
  const schema = dereference(schemaRoot, rawSchema);
  if (!isObject(schema)) return true;
  if (schema.type && !valueTypeMatches(value, schema.type)) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (schema.required && (!isObject(value) || schema.required.some((key) => !Object.hasOwn(value, key)))) return false;
  if (schema.properties && isObject(value)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && !matches(schemaRoot, child, value[key])) return false;
    }
  }
  if (schema.not && matches(schemaRoot, schema.not, value)) return false;
  if (schema.allOf && !schema.allOf.every((child) => matches(schemaRoot, child, value))) return false;
  if (schema.anyOf && !schema.anyOf.some((child) => matches(schemaRoot, child, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((child) => matches(schemaRoot, child, value)).length !== 1) return false;
  return true;
}

function discriminatorConstraint(schemaRoot, rawSchema, property) {
  const schema = dereference(schemaRoot, rawSchema);
  if (!isObject(schema)) return null;
  if (schema.properties?.[property]) {
    const prop = dereference(schemaRoot, schema.properties[property]);
    if (Object.hasOwn(prop, 'const')) return (value) => value === prop.const;
    if (prop.enum) return (value) => prop.enum.includes(value);
    if (prop.not?.enum) return (value) => !prop.not.enum.includes(value);
  }
  if (schema.allOf) {
    for (const child of schema.allOf) {
      const constraint = discriminatorConstraint(schemaRoot, child, property);
      if (constraint) return constraint;
    }
  }
  return null;
}

function expand(schemaRoot, rawSchema, value) {
  let schemas = [dereference(schemaRoot, rawSchema)];
  const allOf = schemas[0]?.allOf || [];
  if (allOf.length) {
    const { allOf: _allOf, ...base } = schemas[0];
    schemas = [base];
    for (const child of allOf) {
      const expanded = expand(schemaRoot, child, value);
      schemas = schemas.flatMap((left) => expanded.map((right) => mergeSchema(left, right)));
    }
  }

  schemas = schemas.flatMap((schema) => {
    if (!schema.if) return [schema];
    const { if: condition, then, else: otherwise, ...base } = schema;
    const selected = matches(schemaRoot, condition, value) ? then : otherwise;
    return selected ? expand(schemaRoot, selected, value).map((item) => mergeSchema(base, item)) : [base];
  });

  return schemas.flatMap((schema) => {
    const variants = schema.oneOf || schema.anyOf;
    if (!variants) return [schema];
    const { oneOf: _oneOf, anyOf: _anyOf, ...base } = schema;
    const discriminator = schema['x-altinity-discriminator'];
    let selected = variants;
    if (discriminator && isObject(value) && Object.hasOwn(value, discriminator)) {
      const constrained = variants.filter((variant) => {
        const test = discriminatorConstraint(schemaRoot, variant, discriminator);
        return test && test(value[discriminator]);
      });
      if (constrained.length) selected = constrained;
    }
    return selected.flatMap((variant) => expand(schemaRoot, variant, value)
      .map((item) => mergeSchema(base, item)));
  });
}

function commonValue(values) {
  if (!values.length) return undefined;
  if (values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))) return values[0];
  if (values.every(isObject)) {
    const common = {};
    const keys = Object.keys(values[0]).filter((key) => values.every((value) => Object.hasOwn(value, key)));
    for (const key of keys) {
      const value = commonValue(values.map((item) => item[key]));
      if (value !== undefined) common[key] = value;
    }
    return common;
  }
  return undefined;
}

function childSchema(schema, segment) {
  if (!isObject(schema)) return null;
  if (typeof segment === 'number') {
    if (Array.isArray(schema.prefixItems) && schema.prefixItems[segment]) return schema.prefixItems[segment];
    return isObject(schema.items) ? schema.items : null;
  }
  if (schema.properties && Object.hasOwn(schema.properties, segment)) return schema.properties[segment];
  for (const [pattern, candidate] of Object.entries(schema.patternProperties || {})) {
    if (new RegExp(pattern).test(segment)) return candidate;
  }
  return isObject(schema.additionalProperties) ? schema.additionalProperties : null;
}

function uniqueSchemas(schemas) {
  const seen = new Set();
  return schemas.filter((schema) => {
    const key = JSON.stringify(schema);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createSpecSchemaService({ schema, validateCompiled }) {
  if (!isObject(schema)) throw new Error('Spec schema must be an object');
  if (typeof validateCompiled !== 'function') throw new Error('Compiled Spec validator must be a function');

  const schemaAtPath = ({ root, path = [] }) => {
    let candidates = [schema];
    let value = root;
    for (const segment of path) {
      candidates = uniqueSchemas(candidates.flatMap((candidate) => expand(schema, candidate, value)
        .map((expanded) => childSchema(expanded, segment)).filter(Boolean)));
      value = value == null ? undefined : value[segment];
      if (!candidates.length) return { common: {}, candidates: [] };
    }
    candidates = uniqueSchemas(candidates.flatMap((candidate) => expand(schema, candidate, value)));
    return { common: commonValue(candidates) || {}, candidates };
  };

  const propertiesAtPath = ({ root, path = [] }) => {
    const envelope = schemaAtPath({ root, path });
    const current = valueAtPath(root, path).value;
    const names = [];
    const add = (name) => { if (!names.includes(name)) names.push(name); };
    const discriminator = envelope.common['x-altinity-discriminator'];
    if (discriminator) add(discriminator);
    for (const name of envelope.common['x-altinity-order'] || []) add(name);
    for (const name of Object.keys(envelope.common.properties || {})) add(name);
    for (const candidate of envelope.candidates) {
      for (const name of candidate['x-altinity-order'] || []) add(name);
      for (const name of Object.keys(candidate.properties || {})) add(name);
    }
    return names.filter((name) => envelope.candidates.some((candidate) => candidate.properties?.[name]))
      .map((name) => ({
        name,
        required: envelope.candidates.length > 0
          && envelope.candidates.every((candidate) => (candidate.required || []).includes(name)),
        schemas: uniqueSchemas(envelope.candidates.map((candidate) => candidate.properties?.[name]).filter(Boolean)
          .flatMap((candidate) => expand(schema, candidate, current == null ? undefined : current[name]))),
      }));
  };

  const annotationsAtPath = ({ root, path = [] }) => {
    const envelope = schemaAtPath({ root, path });
    const pick = (candidate) => Object.fromEntries(ANNOTATION_KEYS
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
  const variantsAtPath = ({ root, path = [] }) => {
    if (!path.length || typeof path.at(-1) !== 'string') return [];
    const property = path.at(-1);
    const parentPath = path.slice(0, -1);
    const withoutActiveValue = (value, segments, index = 0) => {
      if (!isObject(value) && !Array.isArray(value)) return value;
      const copy = Array.isArray(value) ? [...value] : { ...value };
      const segment = segments[index];
      if (index === segments.length - 1) {
        if (Array.isArray(copy)) copy[segment] = undefined;
        else delete copy[segment];
      } else if (Object.hasOwn(copy, segment)) {
        copy[segment] = withoutActiveValue(copy[segment], segments, index + 1);
      }
      return copy;
    };
    const lookupRoot = withoutActiveValue(root, path);
    const parent = schemaAtPath({ root: lookupRoot, path: parentPath });
    if (parent.common['x-altinity-discriminator'] !== property) return [];
    const out = [];
    const seen = new Set();
    parent.candidates.forEach((branch, branchOrder) => {
      const raw = branch.properties?.[property];
      if (!raw) return;
      for (const valueSchema of expand(schema, raw, undefined)) {
        const values = Object.hasOwn(valueSchema, 'const')
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
    validate(value) {
      return validateCompiled(value) ? [] : normalizeCompiledErrors(schema, value, validateCompiled.errors || []);
    },
    schemaAtPath,
    propertiesAtPath,
    annotationsAtPath,
    variantsAtPath,
  };
}

function valueAtPath(root, path) {
  let value = root;
  for (const segment of path) {
    if (value == null || !Object.hasOwn(Object(value), segment)) return { present: false, value: undefined };
    value = value[segment];
  }
  return { present: true, value };
}

/** Compose canonical validation with app-owned feature/runtime validators. */
export function createSpecValidationService({ schemaService, initial = [] }) {
  if (!schemaService || typeof schemaService.validate !== 'function') throw new Error('Spec schema service is required');
  const entries = [...initial];
  return {
    schema: schemaService.schema,
    schemaService,
    register(path, validate) {
      const entry = { path: [...path], validate };
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    validate(spec, context = {}) {
      const diagnostics = schemaService.validate(spec);
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

export const querySpecSchemaService = createSpecSchemaService({
  schema: querySpecSchema,
  validateCompiled: validateQuerySpec,
});

export const createQuerySpecValidationService = (initial = []) =>
  createSpecValidationService({ schemaService: querySpecSchemaService, initial });
