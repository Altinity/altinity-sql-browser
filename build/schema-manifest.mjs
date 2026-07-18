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
    typeExport: 'QuerySpecV1',
  },
  {
    path: 'schemas/saved-query-v2.schema.json',
    schemaExport: 'savedQueryV2Schema',
    validatorExport: 'validateSavedQueryV2',
    typeExport: 'SavedQueryV2',
  },
  {
    path: 'schemas/library-v2.schema.json',
    schemaExport: 'libraryV2Schema',
    validatorExport: 'validateLibraryV2',
    typeExport: 'LibraryV2',
    bundle: true,
  },
  // Dashboard v1 contracts (#280 phase 1, #283). The flow@1 layout schema is
  // its own manifest root so the compiled validator can also re-validate a
  // primary flow@1 layout and every persisted fallback semantically.
  {
    path: 'schemas/dashboard-layout-flow-v1.schema.json',
    schemaExport: 'flowLayoutV1Schema',
    validatorExport: 'validateFlowLayoutV1',
    typeExport: 'FlowLayoutV1',
  },
  {
    path: 'schemas/dashboard-v1.schema.json',
    schemaExport: 'dashboardV1Schema',
    validatorExport: 'validateDashboardV1',
    typeExport: 'DashboardDocumentV1',
  },
  {
    path: 'schemas/stored-workspace-v1.schema.json',
    schemaExport: 'storedWorkspaceV1Schema',
    validatorExport: 'validateStoredWorkspaceV1',
    typeExport: 'StoredWorkspaceV1',
  },
  {
    path: 'schemas/portable-bundle-v1.schema.json',
    schemaExport: 'portableBundleV1Schema',
    validatorExport: 'validatePortableBundleV1',
    typeExport: 'PortableBundleV1',
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
