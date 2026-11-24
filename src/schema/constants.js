// Schema v2 constants and allowed values (approved design; D1–D24, V1–V5, PP/EC/QM/QV/RC).
// Everything here is frozen. Changing a value here changes an approved decision.

const freeze = (o) => Object.freeze(o);
const list = (...xs) => freeze(xs);

export const SCHEMA_VERSION = 2;

export const FORMATS = freeze({
  backup: 'gymlog-backup',
  backupVersion: 1,
  importPackage: 'gymlog-import-package',
  importPackageVersion: 1,
  personalSeed: 'gymlog-personal-seed',
  personalSeedVersion: 1,
  seedDefaults: 'gymlog-seed-defaults',
  seedDefaultsVersion: 1,
});

export const STORAGE_KEYS = freeze({
  v1: 'gymlog.v1',
  v2: 'gymlog.v2',
  v2Prev: 'gymlog.v2.prev',
  restoreMarker: 'gymlog.restore.marker',
  legacyPrefix: 'gymlog.legacy.', // + full 64-hex sha256
  importDraft: 'gymlog.importDraft',
  migrationProof: 'gymlog.migration.proof', // Step 2c: proof of the pending first-migration candidate
  inputDraft: 'gymlog.v2.input', // Step 2d.0: typed-but-uncommitted set values (ephemeral; not part of the store or backups)
});

// ---- Measurement -------------------------------------------------------

export const MEASUREMENT_TYPES = list(
  'weight_reps',
  'bodyweight_reps',
  'bodyweight_plus_load',
  'duration',
  'distance_duration',
  'load_distance',
  'note',
  'unresolved',
);

export const SET_METRIC_FIELDS = list('load', 'reps', 'durationSec', 'distanceM');

/** Allowed set metric fields per measurement type; all others must be null. */
export const ALLOWED_SET_FIELDS = freeze({
  weight_reps: list('load', 'reps'),
  bodyweight_reps: list('reps'),
  bodyweight_plus_load: list('load', 'reps'),
  duration: list('durationSec'),
  distance_duration: list('distanceM', 'durationSec'),
  load_distance: list('load', 'distanceM', 'durationSec'),
  note: list(),
  unresolved: list(),
});

/** Allowed loadBasis per type; types not listed here require loadBasis === null. */
export const ALLOWED_LOAD_BASIS = freeze({
  weight_reps: list('total', 'per_hand', 'per_side', 'implement'),
  bodyweight_plus_load: list('added'),
  load_distance: list('per_hand'),
});

/** D6: displayed weight; "stack" was removed. */
export const LOAD_UNITS = list('kg', 'lb');
export const LB_TO_KG = 0.45359237;

/** D17: repsBasis is either null (bilateral) or "per_side"; only for types that have reps. */
export const REPS_BASIS_VALUES = list('per_side');
export const TYPES_WITH_REPS = list('weight_reps', 'bodyweight_reps', 'bodyweight_plus_load');

/** volumeFactor may be non-null only for this type (INV-13). */
export const VOLUME_FACTOR_TYPES = list('weight_reps');

/** Time basis for durations, splits, manual time records and goals. */
export const TIME_BASIS = list('elapsed', 'moving');

/** Set.splits allowed only on this type. */
export const SPLIT_TYPES = list('distance_duration');
/**
 * Origins whose sets may carry splits. Empty in Schema v2: only the future activity importer
 * (origin "activity_import", reserved) provides recorded splits; app, v1 and CSV never do.
 */
export const SPLIT_ORIGINS = list();

/** distanceM stored with at most this many decimals (0.1 m). */
export const DISTANCE_DECIMALS = 1;

// ---- Bodyweight (INV-BW1–4) ------------------------------------------

export const BODYWEIGHT_SOURCES = freeze({
  session: list('measured', 'user_estimate', 'settings_default'),
  manualRecord: list('measured', 'user_estimate'),
});

// ---- Calculation rules (D4, D5) --------------------------------------

export const ACTUAL_1RM_REPS = 1;
export const E1RM_MIN_REPS = 2;
export const E1RM_MAX_REPS = 10;
export const LOAD_FOR_MIN_REPS_MIN = 2;

// ---- Provenance and import --------------------------------------------

export const ORIGINS = list('app', 'v1_migration', 'v1_late_import', 'csv_import');
/** Reserved for the future activity importer; NOT a valid origin in Schema v2 / Phase 2b. */
export const RESERVED_FUTURE_ORIGINS = list('activity_import');
export const IMPORT_KINDS = list('v1_migration', 'v1_late_import', 'csv_import', 'backup_restore', 'personal_seed');
export const IMPORT_STATUS = list('pending', 'verified');

// ---- Records and goals -------------------------------------------------

export const MANUAL_RECORD_METRICS = list(
  'max_load',
  'actual_1rm',
  'load_for_min_reps',
  'max_reps',
  'best_duration',
  'max_distance',
  'time_for_distance',
);
export const RECORD_SOURCES = list('manual', 'personal_seed');

export const GOAL_METRICS = list('actual_1rm', 'load_for_min_reps', 'max_distance', 'time_for_distance');
export const GOAL_SOURCES = list('manual', 'personal_seed');

/** Derived only (never persisted). */
export const RESULT_SOURCES = list('manual', 'activity_split', 'activity_exact');

// ---- Active session and conflicts -------------------------------------

export const ACTIVE_SESSION_MODES = list('new', 'edit');
export const CONFLICT_KINDS = list('target_missing', 'target_changed');

// ---- Quarantine --------------------------------------------------------

export const QUARANTINE_REASONS = freeze({
  // v1_draft_not_migrated: a valid v1 draft that 2c cannot turn into an active session (Step 2c, R2-8).
  import: list('invalid_item', 'conflict_after_migration', 'id_collision_unresolved', 'user_quarantined_import', 'v1_draft_not_migrated'),
  removed: list('performance_removed_by_user'),
});

export const QUARANTINE_VERIFICATION = list('verified_against_original', 'unverified_conflict');

// ---- IDs ----------------------------------------------------------------

export const ID_PREFIXES = list('ex', 'tpl', 'tpi', 'ses', 'prf', 'set', 'rec', 'goal', 'q', 'imp', 'restore');
export const MAX_COLLISION_SUFFIX = 99;
export const ID_HASH_HEX_LENGTH = 16;

// ---- Warning and error codes -------------------------------------------

export const WARNING_CODES = list(
  'V1_ZERO_AS_NULL',
  'V1_ADDED_LOAD_ZERO',
  'V1_UNKNOWN_EXERCISE',
  'V1_CUSTOM_TYPE',
  'V1_CUSTOM_COLLIDES',
  'V1_DUP_ID',
  'V1_BAD_DATE',
  'V1_BAD_VALUE',
  'V1_NOTE_SET',
  'V1_DRAFT',
  'V1_DRAFT_EDIT_MISSING',
  'V1_TEMPLATE_NAME',
  'V1_BODYWEIGHT_UNKNOWN',
  'V1_BW_SETTING_AMBIGUOUS',
  'V1_LABEL_MISMATCH',
  'V1_VOLUME_CHANGED',
  'V1_DURATION_BASIS_UNKNOWN',
  'V1_LEGACY_ID_CONFLICT',
  'SPLIT_MIXED_BASIS',
  'SPLIT_ORDER_INVALID',
  'SPLIT_BEYOND_DISTANCE',
  'SPLIT_BEYOND_DURATION',
  'ID_COLLISION_RESOLVED',
  'ID_COLLISION_UNRESOLVED',
  'RESTORE_INCOMPLETE',
  'SOURCE_IDENTITY_MISMATCH',
  // Step 2c
  'V1_SOURCE_LITERAL_NORMALIZED',
  'SOURCE_SNAPSHOT_UNAVAILABLE',
  'IMPORT_CANDIDATE_UNPROVEN',
  'V1_STRUCTURE_UNVERIFIED',
);

export const ERROR_CODES = list(
  'EXTERNAL_CHANGE',
  'CONFLICT',
  'EDIT_CONFLICT',
  'EDIT_TARGET_MISSING',
  'ACTIVE_SESSION_EXISTS',
  'UNRESOLVED_EXERCISE',
  'UNRESOLVED_NOT_PRESERVED',
  'PRESERVED_ID_INVALID',
  'PRESERVED_ID_DUPLICATE',
  'PRESERVED_PERFORMANCE_MODIFIED',
  'PRESERVED_PERFORMANCE_REMOVED',
  'QUARANTINE_MISMATCH',
  'CANCEL_WOULD_LOSE_PRESERVED',
  'SEED_DEPENDENCY_MISSING',
  'LEGACY_KEY_CONFLICT',
  // seeding (2b.4)
  'INVALID_STORE',
  'SEED_INVALID',
  'RESULT_INVALID',
  'NOT_FOUND',
  'NOT_SEEDED',
  'EXERCISE_REFERENCED',
  'SEED_NOT_AVAILABLE',
  'SEED_NOT_TOMBSTONED',
  'SEED_ID_OCCUPIED',
  'SEED_UPGRADE_NOT_AVAILABLE',
  'NEEDS_CONFIRMATION',
  // store (2b.5)
  'STORE_NOT_LOADED',
  'STORE_UNAVAILABLE',
  'STORE_ABSENT',
  'STORE_EXISTS',
  'STORE_ALREADY_LOADED',
  'STORAGE_WRITE_FAILED',
  'STORAGE_READ_FAILED',
  'BACKUP_REVISION_MISMATCH',
  'UNSAVED_STATE',
  'NO_UNSAVED_CHANGES',
  // Step 2c.1: source bytes, file identification, side keys
  'SOURCE_EMPTY',
  'SOURCE_ENCODING_INVALID',
  'SOURCE_NOT_JSON',
  'FILE_UNKNOWN',
  'BACKUP_UNSUPPORTED',
  'PROOF_PRESENT',
  'PROOF_CORRUPT',
  'PREV_COPY_PRESENT',
  'PREV_COPY_CORRUPT',
  // Step 2c.2: Store extensions
  'IMPORT_PENDING',
  'IMPORT_NOT_PENDING',
  'CANDIDATE_MISMATCH',
  'NOT_REBUILDABLE',
  'BACKUP_REQUIRED',
  'PROTECTED_FIELD',
  // Step 2c.3–2c.9: v1 import, migration, gate, backup, restore
  'V1_ROOT_INVALID',
  'RECONCILIATION_FAILED',
  'ALREADY_IMPORTED',
  'SEED_MISMATCH',
  'SOURCE_MISMATCH',
  'WRITES_NOT_ALLOWED',
  'WRITES_BUSY',
  'EXPORT_UNAVAILABLE_BUSY',
  'ORPHAN_LEGACY_PRESENT',
  'PLAN_INVALID',
  'CONFIRMATION_REQUIRED',
  'BACKUP_SNAPSHOT_MISSING',
  'BACKUP_INTEGRITY',
  'EXPORT_NOT_PROVEN',
  'WORKFLOW_FAILED',
  // Write-boundary remediation (A, B, D8)
  'IMPORT_LOG_PROTECTED',
  'ORIGIN_PROTECTED',
  'PROTECTED_SESSION_REMOVED',
  'QUARANTINE_PROTECTED',
  'UNRESOLVED_EXERCISE_PROTECTED',
  'LATE_IMPORT_INVALID',
  'CSV_IMPORT_INVALID', // Step 2f
  'PERSONAL_IMPORT_INVALID', // Step 2f
  'SOURCE_SET_PROTECTED', // launch: imported sets are corrected, never deleted
  // Step 2d.0: input draft
  'INPUT_DRAFT_INVALID',
  // Step 2d.0 follow-up: recovery marker and saved-session removal (ordinary commits)
  'RECOVERY_PROTECTED',
  'SESSION_REMOVED',
);

// ---- v1 migration (Step 2c) --------------------------------------------------

/** Diagnostic only (Revision 5 A1): recorded in the proof and the import log, never decisive. */
export const MIGRATION_RULES_VERSION = 1;
