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
  // grafana-grid@1 (#291): a second layout engine, sibling to flow@1. The
  // generic layout envelope in dashboard-v1.schema.json is already open
  // (type/version/items are unconstrained there), so this schema needs no
  // $ref from dashboard-v1 — it is its own manifest root purely to get a
  // compiled validator + generated types, exactly like flow's own root. The
  // `fallback` slot stays pinned to flow@1 only; this schema is never a
  // fallback target.
  {
    path: 'schemas/dashboard-layout-grafana-grid-v1.schema.json',
    schemaExport: 'grafanaGridLayoutV1Schema',
    validatorExport: 'validateGrafanaGridLayoutV1',
    typeExport: 'GrafanaGridLayoutV1',
  },
  // dashboard v1 stays registered read-only (#447): stored-workspace v2/v3/v4
  // and portable-bundle-v1 all $ref it, so the codec still validates persisted
  // and imported v1 Dashboards through it before migrating them to v2. It also
  // remains the OWNER of the tile/presentation/layout $defs — dashboard-v2
  // cross-$refs those rather than redeclaring them, because the emitter claims
  // generated type names once across the whole manifest. Every WRITE uses v2.
  {
    path: 'schemas/dashboard-v1.schema.json',
    schemaExport: 'dashboardV1Schema',
    validatorExport: 'validateDashboardV1',
    typeExport: 'DashboardDocumentV1',
  },
  // dashboard v2 (#447): curated filter definitions are removed and the only
  // persisted variable state is Dashboard-local option SQL keyed by exact
  // inferred variable name.
  {
    path: 'schemas/dashboard-v2.schema.json',
    schemaExport: 'dashboardV2Schema',
    validatorExport: 'validateDashboardV2',
    typeExport: 'DashboardDocumentV2',
  },
  // stored-workspace v2 stays registered read-only (#424): the codec still
  // decodes persisted v2 records through this validator before migrating them
  // to v3. Every WRITE uses v3.
  {
    path: 'schemas/stored-workspace-v2.schema.json',
    schemaExport: 'storedWorkspaceV2Schema',
    validatorExport: 'validateStoredWorkspaceV2',
    typeExport: 'StoredWorkspaceV2',
  },
  // stored-workspace v3 stays registered read-only for the same reason (#427):
  // the codec decodes persisted v3 records through this validator before the
  // one-time ownership migration clones a dedicated query per Dashboard member.
  // Every WRITE uses v4.
  {
    path: 'schemas/stored-workspace-v3.schema.json',
    schemaExport: 'storedWorkspaceV3Schema',
    validatorExport: 'validateStoredWorkspaceV3',
    typeExport: 'StoredWorkspaceV3',
  },
  // stored-workspace v4 stays registered read-only for the same reason (#447):
  // the codec decodes persisted v4 records through this validator before the
  // migration that drops each Dashboard's curated `filters`. Every WRITE uses v5.
  {
    path: 'schemas/stored-workspace-v4.schema.json',
    schemaExport: 'storedWorkspaceV4Schema',
    validatorExport: 'validateStoredWorkspaceV4',
    typeExport: 'StoredWorkspaceV4',
  },
  {
    path: 'schemas/stored-workspace-v5.schema.json',
    schemaExport: 'storedWorkspaceV5Schema',
    validatorExport: 'validateStoredWorkspaceV5',
    typeExport: 'StoredWorkspaceV5',
  },
  // portable-bundle v1 stays registered read-only (#447) so bundles exported
  // before the Dashboard document reached v2 still import. Every EXPORT uses v2.
  {
    path: 'schemas/portable-bundle-v1.schema.json',
    schemaExport: 'portableBundleV1Schema',
    validatorExport: 'validatePortableBundleV1',
    typeExport: 'PortableBundleV1',
  },
  {
    path: 'schemas/portable-bundle-v2.schema.json',
    schemaExport: 'portableBundleV2Schema',
    validatorExport: 'validatePortableBundleV2',
    typeExport: 'PortableBundleV2',
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
