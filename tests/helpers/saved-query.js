/** Concise canonical saved-query fixture for unit tests. */
export function savedQuery({ id, sql = '', name = 'Untitled', favorite = false,
  description, view, panel, dashboard, spec = {}, ...extensions } = {}) {
  if (extensions.specVersion === 1) {
    return { id, sql, specVersion: 1, spec: structuredClone(spec) };
  }
  return {
    id,
    sql,
    specVersion: 1,
    spec: {
      name,
      favorite,
      ...(description !== undefined ? { description } : {}),
      ...(view !== undefined ? { view } : {}),
      ...(panel !== undefined ? { panel } : {}),
      ...(dashboard !== undefined ? { dashboard } : {}),
      ...extensions,
      ...spec,
    },
  };
}
