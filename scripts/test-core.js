// Sanity checks for the shared date/holiday/summary logic: `npm test`
const assert = require('assert');
const WT = require('../src/shared/core');

const nw = { ...WT.DEFAULT_SETTINGS, state: 'NW' };
const h = WT.holidays(2026, 'NW');
assert.deepStrictEqual(Object.keys(h).sort(), [
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25',
  '2026-06-04', '2026-10-03', '2026-11-01', '2026-12-25', '2026-12-26',
]);
assert.strictEqual(WT.holidays(2026, 'SN')['2026-11-18'], 'Buß- und Bettag');
assert.strictEqual(WT.holidays(2025, 'NW')['2025-04-21'], 'Ostermontag');

assert.strictEqual(WT.isWorkingDay('2026-10-09', nw), true);  // Friday
assert.strictEqual(WT.isWorkingDay('2026-10-10', nw), false); // Saturday
assert.strictEqual(WT.isWorkingDay('2026-06-04', nw), false); // Fronleichnam

const entries = {
  '2026-03-02': { category: 'home' }, '2026-03-03': { category: 'office' },
  '2026-03-04': { category: 'trip', note: 'Berlin' }, '2026-03-07': { category: 'trip' },
};
const s = WT.summarize(entries, 2026, { ...nw, commuteKm: 25, commuteRateFirst20: 0.3, commuteRateAfter20: 0.38 }, '2026-03-05');
assert.strictEqual(s.workingDays, 253);
assert.deepStrictEqual(s.counts, { office: 1, home: 1, trip: 2, vacation: 0, sick: 0 });
assert.strictEqual(s.tax.homeAmount, 6);
assert.strictEqual(+s.tax.commuteAmount.toFixed(2), 7.9); // 20×0.30 + 5×0.38
assert.strictEqual(s.weekdayHolidays, 8);

console.log('All core tests passed.');
