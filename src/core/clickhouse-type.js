// Pure parser and queries for the ClickHouse type expressions shared by KPI
// and Dashboard Filter option normalization.

const unquote = (token) => token.quoted ? token.value.slice(1, -1).replace(/\\([\\`"'])/g, '$1') : token.value;

function tokenize(text) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) { i++; continue; }
    if ('(),'.includes(text[i])) { tokens.push({ value: text[i], start: i, end: ++i }); continue; }
    if ('`"\''.includes(text[i])) {
      const quote = text[i];
      const start = i++;
      while (i < text.length) {
        if (text[i] === quote && text[i - 1] !== '\\') { i++; break; }
        i++;
      }
      if (text[i - 1] !== quote) return null;
      tokens.push({ value: text.slice(start, i), start, end: i, quoted: true });
      continue;
    }
    const start = i;
    while (i < text.length && !/[\s(),]/.test(text[i])) i++;
    tokens.push({ value: text.slice(start, i), start, end: i, quoted: false });
  }
  return tokens;
}

export function parseClickHouseType(input) {
  const text = String(input || '').trim();
  const tokens = tokenize(text);
  if (!text || !tokens) return null;
  let pos = 0;

  const parseType = () => {
    const token = tokens[pos];
    if (!token || token.quoted || '(),'.includes(token.value)) return null;
    const start = token.start;
    pos++;
    const node = { name: token.value, args: [], members: null, raw: '' };
    if (tokens[pos]?.value === '(') {
      pos++;
      // Enum8/Enum16 argument lists are `'name' = number, ...` pairs, not
      // nested types — parsing them as types would reject the leading quoted
      // member name. Enum is always a leaf scalar (isSupportedOptionScalar
      // matches it by name only), so just skip to the matching close paren.
      if (/^Enum(?:8|16)$/.test(node.name)) {
        let depth = 1;
        while (pos < tokens.length && depth > 0) {
          if (tokens[pos].value === '(') depth++;
          else if (tokens[pos].value === ')') depth--;
          pos++;
        }
        if (depth !== 0) return null;
        node.raw = text.slice(start, tokens[pos - 1].end);
        return node;
      }
      if (tokens[pos]?.value === ')') {
        node.raw = text.slice(start, tokens[pos++].end);
        return node;
      }
      const tupleMembers = [];
      while (pos < tokens.length) {
        if (node.name === 'Tuple') {
          const first = tokens[pos];
          const second = tokens[pos + 1];
          const named = first && (first.quoted
            || (second && !second.quoted && !'(),'.includes(second.value)));
          if (named) {
            pos++;
            const type = parseType();
            if (!type) return null;
            tupleMembers.push({ name: unquote(first), type });
          } else {
            const type = parseType();
            if (!type) return null;
            node.args.push(type);
          }
        } else {
          const type = parseType();
          if (!type) return null;
          node.args.push(type);
        }
        if (tokens[pos]?.value === ',') { pos++; continue; }
        if (tokens[pos]?.value !== ')') return null;
        const close = tokens[pos++];
        if (tupleMembers.length && node.args.length) return null;
        if (tupleMembers.length) node.members = tupleMembers;
        node.raw = text.slice(start, close.end);
        return node;
      }
      return null;
    }
    node.raw = text.slice(start, token.end);
    return node;
  };

  const node = parseType();
  const validArity = (value) => {
    if (!value) return false;
    if ((value.name === 'Array' || value.name === 'Nullable' || value.name === 'LowCardinality') && value.args.length !== 1) return false;
    if (value.name === 'Map' && value.args.length !== 2) return false;
    return value.args.every(validArity) && (!value.members || value.members.every((member) => validArity(member.type)));
  };
  return node && pos === tokens.length && validArity(node) ? node : null;
}

export function unwrapNullable(node) {
  let current = node;
  while (current && (current.name === 'Nullable' || current.name === 'LowCardinality') && current.args.length === 1) {
    current = current.args[0];
  }
  return current || null;
}

export function arrayElement(node) {
  const value = unwrapNullable(node);
  return value?.name === 'Array' && value.args.length === 1 ? value.args[0] : null;
}

export function mapTypes(node) {
  const value = unwrapNullable(node);
  return value?.name === 'Map' && value.args.length === 2 ? value.args : null;
}

export function namedTupleMembers(node) {
  const value = unwrapNullable(node);
  return value?.name === 'Tuple' && value.members?.length ? value.members : null;
}

export function isSupportedOptionScalar(node) {
  const value = unwrapNullable(node);
  return !!value && /^(?:String|FixedString|UUID|U?Int(?:8|16|32|64|128|256)|Decimal(?:32|64|128|256)?|Float(?:32|64)|Bool|Date|Date32|DateTime|DateTime64|Enum(?:8|16))$/.test(value.name);
}
