// Field lists per schema version (strict field checking, schema-version-aware).
//
// validateStore checks a store ONLY against the field table of its own schemaVersion. An additive
// schema change is introduced deliberately: by adding a new version entry here (plus migration),
// never by loosening an existing version. Unsupported versions are rejected up front (INV-ROOT),
// so their fields are neither accepted by accident nor reported as "unknown".

const f = (...xs) => Object.freeze(xs);

const V2 = Object.freeze({
  root: f('schemaVersion', 'meta', 'settings', 'exercises', 'templates', 'sessions', 'activeSession', 'manualRecords', 'goals', 'quarantine'),
  // Sync (device-local, optional): the durable outbox and checkpoints must live in the SAME storage
  // value as the data they describe (one localStorage write is the only atomic unit available).
  // Absent = sync not enabled. Its contents are validated strictly by src/sync/local.js.
  rootOptional: f('sync'),
  meta: f('createdAt', 'updatedAt', 'appVersion', 'dataRevision', 'seedsApplied', 'seedTombstones', 'importLog', 'onboarding'),
  seedTombstone: f('deletedAt', 'versionAtDeletion'),
  onboarding: f('personalSeed', 'checks', 'userVerifiedAt'),
  onboardingChecks: f('countsMatch', 'spotChecked', 'recordsReviewed', 'unresolvedReviewed', 'realWorkoutLogged'),
  importLogBase: f('importId', 'kind', 'status', 'at', 'reportSeenAt', 'sourceSha256', 'packageSha256', 'counts', 'unresolvedExercises', 'warnings', 'calculationChanges'),
  importLogByKind: Object.freeze({
    // reproduction (Step 2c, R5-1): the inputs needed to reproduce the candidate without the side proof.
    v1_migration: Object.freeze({ required: f('reproduction'), optional: f('volumeComparison') }),
    v1_late_import: Object.freeze({ required: f(), optional: f() }),
    csv_import: Object.freeze({ required: f(), optional: f() }),
    backup_restore: Object.freeze({ required: f('restoreId', 'backupDataSha256', 'sourceUnsavedState', 'prevCopyExists'), optional: f() }),
    // Phase 2f defines the personal-seed decision payload; until then only the base fields are valid.
    personal_seed: Object.freeze({ required: f(), optional: f() }),
  }),
  importCounts: f('sessions', 'performances', 'sets', 'quarantined'),
  importReproduction: f('seedSha256', 'appVersion', 'rulesVersion'),
  importWarning: f('code', 'ref'),
  settings: f('loadUnit', 'bodyweight', 'lastBackupAt', 'lastBackupRevision', 'lastPartialBackupAt', 'lastPartialBackupRevision'),
  settingsBodyweight: f('value', 'unit', 'confirmed', 'updatedAt'),
  measurement: f('type', 'loadBasis', 'loadUnit', 'volumeFactor', 'repsBasis'),
  bodyweight: f('value', 'unit', 'source'),
  provenance: Object.freeze({
    v1_migration: f('importId', 'snapshotSha256', 'legacyWorkoutIndex', 'legacyWorkoutId', 'legacyDateRaw', 'sourceSessionSha256'),
    v1_late_import: f('importId', 'snapshotSha256', 'legacyWorkoutIndex', 'legacyWorkoutId', 'legacyDateRaw', 'sourceSessionSha256'),
    csv_import: f('importId', 'sourceApp', 'fileName', 'fileSha256', 'packageSha256', 'rowStart', 'rowEnd', 'weightUnitConfirmed', 'dateSource', 'fingerprint', 'durationBasisConfirmed'),
  }),
  split: f('distanceM', 'timeSec', 'timeBasis'),
  setRequired: f('id', 'order', 'completed', 'load', 'reps', 'durationSec', 'distanceM'),
  setOptional: f('durationBasis', 'splits', 'sourceRef', 'sourceRaw', 'sourceContext', 'warnings'),
  sourceRefV1: f('e', 's'),
  sourceContextV1: f('v1Fields', 'v1Labels', 'v1CustomType'),
  sourceRefCsv: f('row'),
  performance: f('id', 'exerciseId', 'order', 'nameSnapshot', 'measurement', 'note', 'sets'),
  session: f('id', 'origin', 'provenance', 'date', 'startedAt', 'endedAt', 'templateId', 'templateNameSnapshot', 'bodyweight', 'note', 'warnings', 'recovery', 'createdAt', 'updatedAt', 'performances'),
  recovery: f('recoveredFromSessionId', 'recoveredAt', 'conflictKind'),
  exercise: f('id', 'name', 'aliases', 'group', 'equipment', 'measurement', 'variantGroup', 'isCustom', 'seed', 'prefill', 'archived', 'mergedInto', 'createdAt', 'updatedAt'),
  prefill: f('load', 'source'),
  seed: f('id', 'version'),
  template: f('id', 'name', 'archived', 'seed', 'createdAt', 'updatedAt', 'items'),
  templateItem: f('id', 'exerciseId', 'order', 'plannedSets', 'targetReps', 'targetNote'),
  targetReps: f('min', 'max'),
  manualRecord: f('id', 'exerciseId', 'metric', 'load', 'loadUnit', 'loadBasis', 'reps', 'repsText', 'durationSec', 'distanceM', 'timeBasis', 'bodyweight', 'relatedSetRef', 'date', 'note', 'source', 'createdAt', 'updatedAt'),
  relatedSetRef: f('sessionId', 'performanceId', 'setId'),
  goal: f('id', 'exerciseId', 'metric', 'target', 'deadline', 'archived', 'source', 'createdAt', 'updatedAt'),
  goalTargets: Object.freeze({
    actual_1rm: f('load', 'loadUnit', 'loadBasis'),
    load_for_min_reps: f('load', 'loadUnit', 'loadBasis', 'reps'),
    max_distance: f('distanceM'),
    time_for_distance: f('distanceM', 'durationSec', 'timeBasis'),
  }),
  quarantineImport: f('id', 'importId', 'reason', 'raw'),
  quarantineRemoved: f('id', 'importId', 'reason', 'raw', 'rawCanonicalSha256', 'context'),
  removedContext: f('sessionId', 'performanceId', 'removedAt', 'sessionOrigin', 'sessionProvenance', 'verifiedAgainstOriginal'),
  activeSession: f('mode', 'editsSessionId', 'baseUpdatedAt', 'session', 'preservedPerformanceIds'),
});

export const SCHEMA_FIELDS = Object.freeze({ 2: V2 });
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(Object.keys(SCHEMA_FIELDS).map(Number));
