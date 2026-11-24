// The v3 (v1-C) field rules, transcribed from the deployed old app (/home/claude/gymlog/index.html:
// CAT_ROWS, WEIGHTED, exOf, wlabel, fieldsOf). Only names, types and equipment are copied — the
// "last known weight" column of CAT_ROWS is personal data and is NOT copied (it is not needed).
//
// Evidence level (Revision 3 §6): these rules are VERIFIED only for v1-C. A set is mapped with them
// only when its keys are exactly fieldsOfC(name); anything else becomes unresolved (R3-7, R4-4).

/** name → [v3 type, v3 equipment] for the 39 v3 catalog names (all equal seed-defaults names). */
const CATALOG = Object.freeze({
  'Bench Press': ['weight_reps', 'מוט'],
  'Smith Incline Press': ['weight_reps', 'מכונה'],
  'Incline Barbell Press': ['weight_reps', 'מוט'],
  'Incline DB Press': ['weight_reps', 'דמבל'],
  'Cable Crossover Fly': ['weight_reps', 'כבל'],
  'Fly 15° (Machine)': ['weight_reps', 'מכונה'],
  'Fly 15° (DB)': ['weight_reps', 'דמבל'],
  'Bench Press Rep-and-a-Quarter': ['weight_reps', 'מוט'],
  'Elevated Push-Ups': ['bodyweight_reps', 'משקל גוף'],
  'Weighted Dips': ['bodyweight_reps', 'משקל גוף'],
  'Weighted Pull-Up': ['bodyweight_reps', 'משקל גוף'],
  'One-Arm DB Row': ['weight_reps', 'דמבל'],
  'Lat Pulldown': ['weight_reps', 'מכונה'],
  'Inverted Row': ['bodyweight_reps', 'משקל גוף'],
  'DB Curl': ['weight_reps', 'דמבל'],
  'Cable Curl (Stretch)': ['weight_reps', 'כבל'],
  'Preacher Curl (Machine)': ['weight_reps', 'מכונה'],
  'Seated Side Curl': ['weight_reps', 'דמבל'],
  'Incline DB Curl': ['weight_reps', 'דמבל'],
  'Eccentric Cable Curl': ['weight_reps', 'כבל'],
  'Overhead Extension': ['weight_reps', 'דמבל'],
  'DB Skull Crusher': ['weight_reps', 'דמבל'],
  'Single-Arm Overhead Extension (Cable)': ['weight_reps', 'כבל'],
  'Rope Pushdown': ['weight_reps', 'כבל'],
  'DB Shoulder Press': ['weight_reps', 'דמבל'],
  'Lateral Raise': ['weight_reps', 'דמבל'],
  'Walking Lunges': ['weight_reps', 'דמבל'],
  'Goblet Squat': ['weight_reps', 'דמבל'],
  Deadlift: ['weight_reps', 'מוט'],
  'Farmers Carry': ['distance', 'דמבל'],
  'Wall Ball': ['weight_reps', 'אחר'],
  Burpee: ['bodyweight_reps', 'משקל גוף'],
  'Rowing Machine': ['distance', 'מכונה'],
  Run: ['distance', 'אחר'],
  'Hanging Leg Raise': ['bodyweight_reps', 'משקל גוף'],
  'Cable Crunch': ['weight_reps', 'כבל'],
  'Ab Wheel': ['bodyweight_reps', 'אחר'],
  Plank: ['time', 'משקל גוף'],
  'CrossFit Class (Fit)': ['other', 'אחר'],
});

/** v3's WEIGHTED set: bodyweight exercises that show a "+kg" (added load) field. */
const WEIGHTED = new Set(['Weighted Pull-Up', 'Weighted Dips']);

/** The five custom types v3 offered (TYPES). */
export const V1_CUSTOM_TYPES = Object.freeze(['weight_reps', 'bodyweight_reps', 'time', 'distance', 'other']);

/** v1 exercise names where v3 labeled a single dumbbell "kg per hand" (D12): value kept, label wrong. */
export const V1_LABEL_MISMATCH_NAMES = Object.freeze(['Overhead Extension', 'Goblet Squat']);

export const isV1CatalogName = (name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, name);
export const v1CatalogNames = () => Object.keys(CATALOG);

function wlabel(name, equip) {
  if (name === 'Cable Crossover Fly') return 'ק״ג/צד';
  if (name === 'Wall Ball') return 'ק״ג כדור';
  return equip === 'דמבל' ? 'ק״ג/יד' : 'ק״ג';
}

/**
 * v3's fieldsOf(name) for a catalog name or a custom exercise.
 * @param {string} name
 * @param {string|null} customType  the custom type when `name` is a custom exercise (v3: x.custom)
 * @returns {{k:string, l:string}[] | null}  null when v3 had no rule (unknown custom type)
 */
export function fieldsOfC(name, customType = null) {
  const cat = isV1CatalogName(name) ? CATALOG[name] : null;
  const type = cat ? cat[0] : customType;
  const equip = cat ? cat[1] : '';
  const isCustom = !cat;
  if (name === 'Run') return [{ k: 'd', l: 'ק״מ' }, { k: 't', l: 'זמן (דק׳)' }];
  if (name === 'Rowing Machine') return [{ k: 'd', l: 'מטר' }, { k: 't', l: 'זמן (דק׳)' }];
  if (name === 'Farmers Carry' || name === 'Walking Lunges') return [{ k: 'w', l: 'ק״ג/יד' }, { k: 'd', l: 'מטר' }];
  if (type === 'other') return [{ k: 'note', l: '' }];
  if (type === 'time') return [{ k: 't', l: 'שניות' }];
  if (type === 'distance') return [{ k: 'd', l: 'מטר' }, { k: 't', l: 'זמן (דק׳)' }];
  if (type === 'bodyweight_reps') return (WEIGHTED.has(name) || isCustom ? [{ k: 'w', l: '+ק״ג' }] : []).concat([{ k: 'r', l: 'חזרות' }]);
  if (type === 'weight_reps') return [{ k: 'w', l: wlabel(name, equip) }, { k: 'r', l: 'חזרות' }];
  return null;
}

/**
 * How each v3 field maps for this exercise:
 *   w → 'load' (per the v2 exercise), 'added' (Weighted Pull-Up/Dips, custom +kg), or 'drop' (custom
 *       bodyweight_reps mapped reps-only: w 0 is "not entered", kept only in the legacy snapshot);
 *   d → 'km' (Run) or 'm';  t → 'min' (distance types) or 'sec' (time type);  r → 'reps';  note → 'note'.
 */
export function unitsOfC(name, customType = null) {
  const cat = isV1CatalogName(name) ? CATALOG[name] : null;
  const type = cat ? cat[0] : customType;
  return {
    d: name === 'Run' ? 'km' : 'm',
    t: type === 'time' ? 'sec' : 'min',
    wAdded: WEIGHTED.has(name) || (!cat && type === 'bodyweight_reps'),
  };
}
