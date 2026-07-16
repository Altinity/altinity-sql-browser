// Emit the committed TypeScript type artifact for the canonical JSON-Schema
// graph (ADR-0002 phase 1). Hand-rolled instead of json-schema-to-typescript:
// $refs resolve through the manifest's $id registry (never the filesystem),
// 2020-12 `unevaluatedProperties`/`not` are honored, emitted names are pinned
// by the manifest, and the output is byte-stable with no extra dependency.
//
// The keyword mapping is a strict whitelist: any shape-affecting keyword this
// module does not understand throws, so schema evolution fails loudly instead
// of silently emitting wrong types. Validation-only keywords (lengths,
// patterns, bounds, formats) are the runtime validators' concern and are
// ignored here, as are all x-altinity-* annotations.

import { ANNOTATION_KEYWORDS } from './schema-manifest.mjs';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PRIMITIVES = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', null: 'null' };

const IGNORED_KEYWORDS = new Set([
  ...ANNOTATION_KEYWORDS,
  '$schema', '$id', 'title', 'description', 'default', 'examples', 'deprecated',
  'minLength', 'maxLength', 'pattern', 'format',
  'minItems', 'maxItems', 'uniqueItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minProperties', 'maxProperties',
]);
const HANDLED_KEYWORDS = new Set([
  'type', 'const', 'enum', 'anyOf', 'oneOf', 'allOf', 'not', '$ref',
  'properties', 'required', 'additionalProperties', 'unevaluatedProperties', 'items',
]);

const pascalCase = (name) => String(name).split(/[^A-Za-z0-9]+/).filter(Boolean)
  .map((part) => part[0].toUpperCase() + part.slice(1)).join('');

function guardKeywords(schema, where) {
  for (const key of Object.keys(schema)) {
    if (IGNORED_KEYWORDS.has(key) || HANDLED_KEYWORDS.has(key)) continue;
    throw new Error(`Unhandled JSON-Schema keyword "${key}" at ${where} — add its type mapping to build/emit-schema-types.mjs`);
  }
}

function literal(value, where) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return JSON.stringify(value);
  throw new Error(`Unsupported literal ${JSON.stringify(value)} at ${where}`);
}

function assertLoneRef(schema, where) {
  const extras = Object.keys(schema).filter((key) => key !== '$ref' && !IGNORED_KEYWORDS.has(key));
  if (extras.length) throw new Error(`$ref with sibling shape keywords (${extras.join(', ')}) at ${where}`);
}

const pickDoc = (schema) => (schema.title || schema.description)
  ? { title: schema.title, description: schema.description }
  : undefined;

function renderJsdoc(doc, extra = []) {
  const lines = [];
  if (doc?.title) lines.push(String(doc.title));
  if (doc?.description) {
    if (lines.length) lines.push('');
    lines.push(...String(doc.description).split('\n'));
  }
  if (extra.length) {
    if (lines.length) lines.push('');
    lines.push(...extra);
  }
  if (!lines.length) return [];
  const escaped = lines.map((line) => line.replace(/\*\//g, '*\\/'));
  if (escaped.length === 1) return [`/** ${escaped[0]} */`];
  return ['/**', ...escaped.map((line) => (line ? ` * ${line}` : ' *')), ' */'];
}

// A property schema that adds no shape information — only ignored validation
// keywords, or a bare items-less `type: "array"` narrowing (e.g. the Pie
// branch's maxItems refinement of the inherited measure list). Merging keeps
// the earlier, richer declaration instead.
function isConstraintOnly(schema) {
  const keys = Object.keys(schema).filter((key) => !IGNORED_KEYWORDS.has(key));
  return keys.length === 1 && keys[0] === 'type' && schema.type === 'array' && schema.items === undefined;
}

export function buildSchemaTypes(records) {
  const byId = new Map(records.map((record) => [record.schema.$id, record]));
  const claimed = new Map();
  const used = new Set();
  const decls = [];

  const claimName = (name, where) => {
    if (!IDENT.test(name)) throw new Error(`Emitted type name "${name}" is not a valid identifier (${where})`);
    if (claimed.has(name)) {
      throw new Error(`Duplicate emitted type name "${name}" for ${where} (already claimed by ${claimed.get(name)})`);
    }
    claimed.set(name, where);
    return name;
  };
  const push = (name, text, keep) => decls.push({ name, text, keep });

  function resolveRef(ref, record, where) {
    const hashIndex = ref.indexOf('#');
    const base = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : ref.slice(hashIndex + 1);
    let target = record;
    if (base) {
      const id = new URL(base, record.schema.$id).href;
      target = byId.get(id);
      if (!target) throw new Error(`$ref to a schema outside the manifest ("${ref}") at ${where}`);
    }
    if (!fragment) return { record: target, schema: target.schema, name: target.typeExport };
    const match = /^\/\$defs\/([^/]+)$/.exec(fragment);
    if (!match || !(target.schema.$defs && match[1] in target.schema.$defs)) {
      throw new Error(`Unsupported or unknown $ref fragment "${ref}" at ${where}`);
    }
    return { record: target, schema: target.schema.$defs[match[1]], name: pascalCase(match[1]) };
  }

  function unionExpr(members, record, where) {
    const parts = members.map((member, i) => typeExpr(member, record, `${where}[${i}]`));
    // An open literal union ({enum} | {type:"string"}) keeps autocomplete on
    // the known values without closing the set: string swallows literals, so
    // the bare-string member becomes `string & {}`.
    const hasLiteral = parts.some((part) => part.includes('"'));
    const adjusted = parts.map((part) => (part === 'string' && hasLiteral ? '(string & {})' : part));
    return [...new Set(adjusted)].join(' | ');
  }

  function objectExpr(schema, record, where) {
    const ap = schema.additionalProperties;
    if (schema.properties === undefined) {
      // `required` is honored only via the properties path (flattenInto); a
      // property-less object with `required` ("must carry key x conforming to
      // additionalProperties") has no Record<> representation here — fail
      // loud rather than silently emitting a shape that drops the constraint.
      if (schema.required !== undefined) {
        throw new Error(`Unsupported: "required" on a properties-less object at ${where}`);
      }
      if (ap === undefined || ap === true) return 'Record<string, unknown>';
      if (ap === false) return 'Record<string, never>';
      return `Record<string, ${typeExpr(ap, record, `${where}.additionalProperties`)}>`;
    }
    const acc = newAcc();
    flattenInto(schema, record, where, acc);
    if (acc.extends.length) throw new Error(`Inline object cannot extend named types at ${where}`);
    return `{ ${renderMembers(acc, { jsdoc: false }).join(' ')} }`;
  }

  function typeExpr(schema, record, where) {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      throw new Error(`Expected a schema object at ${where}`);
    }
    guardKeywords(schema, where);
    if (schema.$ref !== undefined) {
      assertLoneRef(schema, where);
      const { name } = resolveRef(schema.$ref, record, where);
      used.add(name);
      return name;
    }
    if (schema.const !== undefined) return literal(schema.const, where);
    if (schema.enum !== undefined) return schema.enum.map((value) => literal(value, where)).join(' | ');
    if (schema.anyOf !== undefined) return unionExpr(schema.anyOf, record, `${where}.anyOf`);
    if (schema.oneOf !== undefined) return unionExpr(schema.oneOf, record, `${where}.oneOf`);
    if (schema.allOf !== undefined) throw new Error(`allOf is only supported on named types (${where})`);
    if (schema.not !== undefined) {
      const notKeys = Object.keys(schema.not ?? {});
      if (schema.type === 'string' && notKeys.length === 1 && Array.isArray(schema.not.enum)) {
        return 'string & {}'; // negation is inexpressible in TS; stays open but literal-safe
      }
      throw new Error(`Unsupported "not" shape at ${where} — only {type:"string", not:{enum:[...]}} is expressible`);
    }
    const { type } = schema;
    if (type === undefined) return 'unknown';
    if (Array.isArray(type)) {
      return type.map((member) => {
        if (!PRIMITIVES[member]) throw new Error(`Unsupported member "${member}" of a type array at ${where}`);
        return PRIMITIVES[member];
      }).join(' | ');
    }
    if (PRIMITIVES[type]) return PRIMITIVES[type];
    if (type === 'array') {
      if (schema.items === undefined) return 'unknown[]';
      const item = typeExpr(schema.items, record, `${where}.items`);
      return /[|&(]| /.test(item) ? `(${item})[]` : `${item}[]`;
    }
    if (type === 'object') return objectExpr(schema, record, where);
    throw new Error(`Unhandled "type" ${JSON.stringify(type)} at ${where}`);
  }

  const newAcc = () => ({ extends: [], props: new Map(), required: new Set(), open: false, closed: false });
  const cloneAcc = (acc) => ({
    extends: [...acc.extends],
    props: new Map(acc.props),
    required: new Set(acc.required),
    open: acc.open,
    closed: acc.closed,
  });

  function flattenInto(schema, record, where, acc) {
    guardKeywords(schema, where);
    if (schema.oneOf || schema.anyOf || schema.enum !== undefined || schema.const !== undefined || schema.not !== undefined) {
      throw new Error(`Only plain object schemas can compose an interface (${where})`);
    }
    if (schema.type !== undefined && schema.type !== 'object') {
      throw new Error(`Interface composition needs "type": "object" at ${where}`);
    }
    if (schema.$ref !== undefined) {
      assertLoneRef(schema, where);
      const target = resolveRef(schema.$ref, record, where);
      if (target.schema.allOf) {
        // A pure composition helper (e.g. styledChartCfg) is inlined so the
        // final interface extends the concrete base directly.
        flattenInto(target.schema, target.record, `${where} -> ${schema.$ref}`, acc);
      } else {
        used.add(target.name);
        if (!acc.extends.includes(target.name)) acc.extends.push(target.name);
      }
      return;
    }
    for (const [i, member] of (schema.allOf ?? []).entries()) {
      flattenInto(member, record, `${where}.allOf[${i}]`, acc);
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
      throw new Error(`Schema-valued additionalProperties beside properties is unsupported at ${where}`);
    }
    if (schema.unevaluatedProperties !== undefined && schema.unevaluatedProperties !== false) {
      throw new Error(`Only unevaluatedProperties: false is supported at ${where}`);
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (isConstraintOnly(propSchema)) continue;
      const previous = acc.props.get(key);
      acc.props.set(key, {
        schema: propSchema,
        record,
        where: `${where}.properties.${key}`,
        doc: pickDoc(propSchema) ?? previous?.doc,
      });
    }
    for (const key of schema.required ?? []) acc.required.add(key);
    if (schema.additionalProperties === true) acc.open = true;
    if (schema.additionalProperties === false || schema.unevaluatedProperties === false) acc.closed = true;
  }

  function renderMembers(acc, { jsdoc = true } = {}) {
    const lines = [];
    for (const [key, prop] of acc.props) {
      if (jsdoc) lines.push(...renderJsdoc(prop.doc));
      const name = IDENT.test(key) ? key : JSON.stringify(key);
      const optional = acc.required.has(key) ? '' : '?';
      lines.push(`${name}${optional}: ${typeExpr(prop.schema, prop.record, prop.where)};`);
    }
    if (acc.open && !acc.closed) lines.push('[k: string]: unknown;');
    return lines;
  }

  function renderInterface(name, acc, doc, extraDoc = []) {
    const heritage = acc.extends.length ? ` extends ${acc.extends.join(', ')}` : '';
    const body = renderMembers(acc).map((line) => `  ${line}`);
    return [...renderJsdoc(doc, extraDoc), `export interface ${name}${heritage} {`, ...body, '}'].join('\n');
  }

  function emitMergedVariants(name, schema, record, where, doc, root) {
    const { oneOf, ...base } = schema;
    const baseAcc = newAcc();
    flattenInto(base, record, where, baseAcc);
    const variants = oneOf.map((branch, i) => {
      const branchWhere = `${where}.oneOf[${i}]`;
      const acc = cloneAcc(baseAcc);
      flattenInto(branch, record, branchWhere, acc);
      return { acc, doc: pickDoc(branch), where: branchWhere };
    });
    if (variants.length === 1) {
      push(name, renderInterface(name, variants[0].acc, doc), root);
      return;
    }
    const names = variants.map((variant, i) => {
      const variantName = claimName(`${name}Variant${i + 1}`, variant.where);
      push(variantName, renderInterface(variantName, variant.acc, variant.doc), false);
      used.add(variantName);
      return variantName;
    });
    push(name, [...renderJsdoc(doc), `export type ${name} = ${names.join(' | ')};`].join('\n'), root);
  }

  function emitDiscriminated(name, schema, record, where, doc, root) {
    const disc = schema['x-altinity-discriminator'];
    const { oneOf, ...base } = schema;
    const baseAcc = newAcc();
    flattenInto(base, record, where, baseAcc);
    const consts = [];
    const branches = [];
    let catchAll = null;
    oneOf.forEach((branch, i) => {
      const branchWhere = `${where}.oneOf[${i}]`;
      const acc = cloneAcc(baseAcc);
      flattenInto(branch, record, branchWhere, acc);
      const discProp = acc.props.get(disc);
      if (!discProp) throw new Error(`Discriminated branch has no "${disc}" property at ${branchWhere}`);
      const discSchema = discProp.schema;
      if (discSchema.const !== undefined) {
        consts.push(discSchema.const);
        branches.push({ name: `${pascalCase(String(discSchema.const))}${name}`, acc, doc: pickDoc(branch), where: branchWhere });
      } else if (discSchema.not && Array.isArray(discSchema.not.enum)) {
        if (catchAll) throw new Error(`More than one catch-all branch in the discriminated union at ${branchWhere}`);
        catchAll = { acc, doc: pickDoc(branch), where: branchWhere, notEnum: discSchema.not.enum };
      } else {
        throw new Error(`Discriminator "${disc}" needs a const or a not:{enum:[...]} at ${branchWhere}`);
      }
    });
    if (catchAll) {
      const expected = JSON.stringify([...consts].sort());
      const actual = JSON.stringify([...catchAll.notEnum].sort());
      if (expected !== actual) {
        throw new Error(`Catch-all not.enum ${actual} does not match sibling discriminator consts ${expected} at ${catchAll.where}`);
      }
      branches.push({
        name: `Future${name}`,
        acc: catchAll.acc,
        doc: catchAll.doc,
        where: catchAll.where,
        extraDoc: [
          `TypeScript cannot express "any string except the known \`${disc}\` values",`,
          `so a check like \`${disc} === ${JSON.stringify(consts[0])}\` narrows ${name} to`,
          `\`${pascalCase(String(consts[0]))}${name} | Future${name}\`. Use`,
          `\`Extract<${name}, { ${disc}: ${JSON.stringify(consts[0])} }>\` or runtime dispatch for an exact branch.`,
        ],
      });
    }
    const names = branches.map((branch) => {
      claimName(branch.name, branch.where);
      push(branch.name, renderInterface(branch.name, branch.acc, branch.doc, branch.extraDoc ?? []), false);
      used.add(branch.name);
      return branch.name;
    });
    push(name, [...renderJsdoc(doc), `export type ${name} = ${names.join(' | ')};`].join('\n'), root);
  }

  function emitNamed(name, schema, record, where, { root = false } = {}) {
    claimName(name, where);
    const doc = pickDoc(schema);
    const { $defs, ...rest } = schema;
    if ($defs && !root) throw new Error(`Nested $defs are unsupported at ${where}`);
    if (rest['x-altinity-discriminator'] && rest.oneOf) {
      emitDiscriminated(name, rest, record, where, doc, root);
      return;
    }
    if (rest.oneOf && (rest.type === 'object' || rest.properties)) {
      emitMergedVariants(name, rest, record, where, doc, root);
      return;
    }
    const objecty = rest.allOf !== undefined
      || (rest.type === 'object' && rest.properties !== undefined);
    if (objecty) {
      const acc = newAcc();
      flattenInto(rest, record, where, acc);
      push(name, renderInterface(name, acc, doc), root);
      return;
    }
    push(name, [...renderJsdoc(doc), `export type ${name} = ${typeExpr(rest, record, where)};`].join('\n'), root);
  }

  for (const record of records) {
    const where = record.relativePath ?? record.schema.$id;
    const { schema } = record;
    push(null, `// ${schema['x-altinity-kind']} v${schema['x-altinity-version']} — ${schema.$id}`, true);
    for (const [key, defSchema] of Object.entries(schema.$defs ?? {})) {
      emitNamed(pascalCase(key), defSchema, record, `${where}#/$defs/${key}`);
    }
    emitNamed(record.typeExport, schema, record, where, { root: true });
  }

  // Composition-only helpers (e.g. styledChartCfg) that nothing references by
  // name are dropped from the artifact; roots and record banners always stay.
  return decls.filter((decl) => decl.keep || used.has(decl.name)).map((decl) => decl.text).join('\n\n') + '\n';
}
