import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIsraeliDate, formatIsraeliDate, calendarWeeks, localTodayIso } from '../src/ui/date-field.js';
import { singleToWide } from '../src/import/garmin-single.js';

const TODAY = '2026-11-11';
const ok = (t) => { const r = parseIsraeliDate(t, TODAY); assert.ok(r.ok, `${t} → ${JSON.stringify(r)}`); return r.iso; };
const bad = (t) => { const r = parseIsraeliDate(t, TODAY); assert.equal(r.ok, false, `${t} should be refused`); return r.code; };

describe('Israeli date field (day first)', () => {
  it('05/11/2026 is 5 November, never 11 May', () => {
    assert.equal(ok('05/11/2026'), '2026-11-05');
    assert.equal(ok('5/11/2026'), '2026-11-05');
    assert.equal(ok('05/05/2026'), '2026-05-05');
    assert.equal(ok('11/05/2026'), '2026-05-11'); // 11 May, day first
    assert.notEqual(ok('05/11/2026'), '2026-05-11');
  });
  it('accepts D/M/YYYY, DD/MM/YYYY, DD.MM.YYYY and DD-MM-YYYY, with spaces around', () => {
    for (const t of ['3/9/2026', '03/09/2026', '03.09.2026', '03-09-2026', ' 03/09/2026 ']) assert.equal(ok(t), '2026-09-03');
  });
  it('31/12 and a leap day are valid; 31/02, 29/02 of a non-leap year and month 13 are refused', () => {
    assert.equal(ok('31/12/2025'), '2025-12-31');
    assert.deepEqual(parseIsraeliDate('29/02/2028', '2028-03-01'), { ok: true, iso: '2028-02-29' }); // a leap day (checked on a later "today")
    assert.equal(ok('29/02/2024'), '2024-02-29');
    assert.equal(bad('31/02/2026'), 'DATE_INVALID');
    assert.equal(bad('29/02/2027'), 'DATE_INVALID');
    assert.equal(bad('10/13/2026'), 'DATE_INVALID');
    assert.equal(bad('00/10/2026'), 'DATE_INVALID');
    assert.equal(bad('32/01/2026'), 'DATE_INVALID');
  });
  it('refuses unreadable text and dates more than a day in the future', () => {
    assert.equal(bad(''), 'DATE_FORMAT');
    assert.equal(bad('2026-11-05'), 'DATE_FORMAT'); // ISO is not typed in this field
    assert.equal(bad('5/11/26'), 'DATE_FORMAT');
    assert.equal(bad('hello'), 'DATE_FORMAT');
    assert.equal(ok('11/11/2026'), '2026-11-11'); // today
    assert.equal(ok('12/11/2026'), '2026-11-12'); // tomorrow: one day of slack
    assert.equal(bad('13/11/2026'), 'DATE_FUTURE');
  });
  it('formats DD/MM/YYYY and round-trips', () => {
    assert.equal(formatIsraeliDate('2026-11-05'), '05/11/2026');
    assert.equal(formatIsraeliDate('2028-02-29'), '29/02/2028');
    assert.equal(formatIsraeliDate('nope'), '');
    assert.equal(ok(formatIsraeliDate('2026-03-07')), '2026-03-07');
  });
  it('today is the local calendar day', () => {
    assert.equal(localTodayIso(new Date(2026, 10, 5, 23, 59)), '2026-11-05');
    assert.equal(localTodayIso(new Date(2026, 0, 1, 0, 1)), '2026-01-01');
  });
  it('calendar weeks start on Sunday (November 2026 starts on a Sunday, February 2028 on a Tuesday)', () => {
    const nov = calendarWeeks(2026, 10);
    assert.deepEqual(nov[0], [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(nov.every((w) => w.length === 7));
    assert.equal(nov.flat().filter(Boolean).length, 30);
    const feb = calendarWeeks(2028, 1);
    assert.deepEqual(feb[0], [null, null, 1, 2, 3, 4, 5]);
    assert.equal(feb.flat().filter(Boolean).length, 29);
  });
  it('the date the field produces reaches the single import as that day (05/11/2026 → 05-11-2026)', () => {
    const csv = '"Set","Exercise Name","Time","Rest","Reps","Weight","Volume"\n"1","Curl","0:30","1:00","10","10 kg","100 kg"\n';
    const r = singleToWide(new TextEncoder().encode(csv), { date: ok('05/11/2026'), title: 'Push', activityId: '25000462779' });
    assert.ok(r.ok);
    assert.match(r.csv, /"05-11-2026"/);
    assert.doesNotMatch(r.csv, /"11-05-2026"|"2026-/);
  });
});
