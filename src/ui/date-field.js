// Israeli date entry (day first, DD/MM/YYYY) for forms where the browser's own date display would follow the
// device locale. Pure helpers (parse / format / calendar model) + one DOM component. The value is kept as
// YYYY-MM-DD internally; only the text shown and typed is DD/MM/YYYY. Stored data formats are not touched.
import { h } from './dom.js';

export const DATE_ERRORS = Object.freeze({
  DATE_FORMAT: 'כתוב תאריך כך: יום/חודש/שנה, למשל 05/11/2026.',
  DATE_INVALID: 'התאריך לא קיים בלוח השנה.',
  DATE_FUTURE: 'התאריך בעתיד.',
});
export const MONTHS_HE = Object.freeze(['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר']);
export const WEEKDAYS_HE = Object.freeze(['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']); // Sunday first

const pad = (n) => String(n).padStart(2, '0');

/** Today's date on this device (local calendar day, not UTC) as YYYY-MM-DD. */
export const localTodayIso = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const isoAddDays = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

/** YYYY-MM-DD → DD/MM/YYYY ('' when it is not a date). */
export function formatIsraeliDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/**
 * Day-first parse: D/M/YYYY, DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY. 05/11/2026 is always 5 November 2026.
 * A real calendar date, not later than tomorrow (a day of slack for time zones).
 * @returns {{ok:true, iso:string}|{ok:false, code:'DATE_FORMAT'|'DATE_INVALID'|'DATE_FUTURE'}}
 */
export function parseIsraeliDate(text, today = localTodayIso()) {
  const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*$/.exec(String(text ?? ''));
  if (!m) return { ok: false, code: 'DATE_FORMAT' };
  const d = Number(m[1]); const mo = Number(m[2]); const y = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || mo < 1 || mo > 12 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return { ok: false, code: 'DATE_INVALID' };
  const iso = `${y}-${pad(mo)}-${pad(d)}`;
  if (iso > isoAddDays(today, 1)) return { ok: false, code: 'DATE_FUTURE' };
  return { ok: true, iso };
}

/** Month grid, weeks starting on Sunday: arrays of 7 day numbers (null = outside the month). month0 = 0..11. */
export function calendarWeeks(year, month0) {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay(); // 0 = Sunday
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

const isApple = () => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * The date field. `draft` holds { date: 'YYYY-MM-DD', dateText: 'DD/MM/YYYY' } and is updated as the user types or picks.
 * Returns { el, validate } — validate() re-reads the text, shows the Hebrew error if needed and returns the parse result.
 */
export function dateField(draft, { today = localTodayIso() } = {}) {
  const max = isoAddDays(today, 1);
  if (!draft.dateText) { draft.date ??= today; draft.dateText = formatIsraeliDate(draft.date); }
  const err = h('p', { class: 'note note-warn date-error', role: 'alert', hidden: true });
  const text = h('input', { class: 'in date-text', type: 'text', inputmode: 'numeric', autocomplete: 'off', dir: 'ltr', placeholder: 'DD/MM/YYYY', value: draft.dateText, 'data-field': 'single-date', 'aria-label': 'תאריך (יום/חודש/שנה)' });
  const native = h('input', { class: 'date-native', type: 'date', tabindex: '-1', 'aria-hidden': 'true', max, value: draft.date ?? '' });
  const grid = h('div', { class: 'cal', dir: 'rtl', hidden: true, 'data-id': 'calendar' });
  const showError = (r) => { err.hidden = r.ok; err.textContent = r.ok ? '' : DATE_ERRORS[r.code]; };
  const set = (iso) => { draft.date = iso; draft.dateText = formatIsraeliDate(iso); text.value = draft.dateText; native.value = iso; showError({ ok: true }); };
  const validate = () => { const r = parseIsraeliDate(text.value, today); if (r.ok) set(r.iso); else showError(r); return r; };

  text.addEventListener('input', () => {
    draft.dateText = text.value;
    const r = parseIsraeliDate(text.value, today);
    if (r.ok) { draft.date = r.iso; native.value = r.iso; showError(r); }
  });
  text.addEventListener('blur', () => { if (text.value.trim() !== '') validate(); });
  native.addEventListener('change', () => { if (native.value) set(native.value); });

  let view = null; // { y, m0 } of the in-app calendar
  const drawGrid = () => {
    const sel = draft.date;
    const head = h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'cal-nav', 'aria-label': 'חודש קודם', onclick: () => { view = view.m0 === 0 ? { y: view.y - 1, m0: 11 } : { y: view.y, m0: view.m0 - 1 }; drawGrid(); } }, '›'),
      h('strong', {}, `${MONTHS_HE[view.m0]} ${view.y}`),
      h('button', { type: 'button', class: 'cal-nav', 'aria-label': 'חודש הבא', onclick: () => { view = view.m0 === 11 ? { y: view.y + 1, m0: 0 } : { y: view.y, m0: view.m0 + 1 }; drawGrid(); } }, '‹'));
    const wd = h('div', { class: 'cal-row cal-wd' }, ...WEEKDAYS_HE.map((w) => h('span', {}, w)));
    const rows = calendarWeeks(view.y, view.m0).map((week) => h('div', { class: 'cal-row' }, ...week.map((day) => {
      if (day === null) return h('span', { class: 'cal-empty' });
      const iso = `${view.y}-${pad(view.m0 + 1)}-${pad(day)}`;
      return h('button', { type: 'button', class: `cal-day${iso === sel ? ' sel' : ''}${iso === today ? ' today' : ''}`, disabled: iso > max, 'aria-label': formatIsraeliDate(iso), onclick: () => { set(iso); grid.hidden = true; } }, String(day));
    })));
    grid.replaceChildren(head, wd, ...rows);
  };
  const openGrid = () => {
    const base = /^\d{4}-\d{2}-\d{2}$/.test(draft.date ?? '') ? draft.date : today;
    view = { y: Number(base.slice(0, 4)), m0: Number(base.slice(5, 7)) - 1 };
    drawGrid();
    grid.hidden = !grid.hidden;
  };
  const open = () => {
    const r = parseIsraeliDate(text.value, today);
    if (r.ok) { draft.date = r.iso; native.value = r.iso; }
    if (!isApple() && typeof native.showPicker === 'function') {
      try { native.showPicker(); return; } catch { /* fall back to the in-app calendar */ }
    }
    openGrid();
  };
  const calBtn = h('button', { type: 'button', class: 'cal-open', 'aria-label': 'פתח לוח שנה', 'data-id': 'date-open', onclick: open }, '📅');
  text.addEventListener('click', () => { if (!isApple() && typeof native.showPicker === 'function') open(); });

  const el = h('div', { class: 'date-field' }, h('div', { class: 'date-row' }, text, calBtn, native), grid, err);
  return { el, validate };
}
