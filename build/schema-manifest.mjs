export const BUNDLE_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/library-v2.bundle.schema.json';

// Production compilation is deliberately manifest-driven. Documentation
// drafts are validated separately and can never become runtime contracts by
// merely appearing in the repository.
export const SCHEMA_MANIFEST = [
  {
    path: 'schemas/query-spec-v1.schema.json',
    schemaExport: 'querySpecV1Schema',
    validatorExport: 'validateQuerySpecV1',
  },
  {
    path: 'schemas/saved-query-v2.schema.json',
    schemaExport: 'savedQueryV2Schema',
    validatorExport: 'validateSavedQueryV2',
  },
  {
    path: 'schemas/library-v2.schema.json',
    schemaExport: 'libraryV2Schema',
    validatorExport: 'validateLibraryV2',
    bundle: true,
  },
];

export const ANNOTATION_KEYWORDS = [
  'x-altinity-kind',
  'x-altinity-version',
  'x-altinity-discriminator',
  'x-altinity-completion',
  'x-altinity-key-completion',
  'x-altinity-snippet',
  'x-altinity-order',
  'x-altinity-deprecated',
  'x-altinity-status',
];
