// Shared logic used by the Electron main process (require), the renderers and the iPhone web app
// (<script>), and the Supabase reminder service (Deno import).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WT = factory();
})(globalThis, function () {
  'use strict';

  // ---------- Categories ----------
  const CATEGORIES = [
    { id: 'office',   label: 'Office',      color: '#3B82F6', icon: 'office' },
    { id: 'home',     label: 'Home office', color: '#10B981', icon: 'home' },
    { id: 'trip',     label: 'Dienstreise', color: '#F59E0B', icon: 'trip' },
    { id: 'vacation', label: 'Urlaub',      color: '#8B5CF6', icon: 'vacation' },
    { id: 'sick',     label: 'Krank',       color: '#F43F5E', icon: 'sick' },
  ];
  const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

  const STATES = {
    BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen',
    HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen',
    NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen',
    ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
  };

  const DEFAULT_SETTINGS = {
    state: 'NW',
    checkinTime: '10:00',
    noteTime: '16:00',
    workdays: [1, 2, 3, 4, 5], // ISO weekdays, 1 = Monday
    openAtLogin: true,
    linuxPracticeEnabled: true,
    linuxPracticeCount: 4,
    linuxPracticeStart: '10:00',
    linuxPracticeEnd: '16:00',
    phoneLinuxPractice: false, // Linux cards as iPhone notifications too
    commuteKm: 0,
    commuteRateFirst20: 0.38, // €/km, km 1–20 (0.38 from the 1st km since 2026)
    commuteRateAfter20: 0.38, // €/km, from km 21
    homeOfficeRate: 6,        // € per day (Homeoffice-Pauschale)
    homeOfficeCap: 210,       // max. days per year
  };

  // ---------- Dates (all keys are local "YYYY-MM-DD") ----------
  const pad = (n) => String(n).padStart(2, '0');
  const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const todayKey = () => toKey(new Date());
  const parseTime = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();
  const isoWeekday = (d) => (d.getDay() === 0 ? 7 : d.getDay());

  function yearKeys(year) {
    const out = [];
    for (let d = new Date(year, 0, 1); d.getFullYear() === year; d = addDays(d, 1)) out.push(toKey(d));
    return out;
  }

  const fmt = (k, opts) => fromKey(k).toLocaleDateString('en-GB', opts);
  const formatLong = (k) => fmt(k, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const formatShort = (k) => fmt(k, { weekday: 'short', day: 'numeric', month: 'short' });
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // ---------- Public holidays ----------
  function easterSunday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  const holidayCache = new Map();
  function holidays(year, state) {
    const cacheKey = `${year}-${state}`;
    if (holidayCache.has(cacheKey)) return holidayCache.get(cacheKey);
    const map = {};
    const add = (d, name) => { map[toKey(d)] = name; };
    const fixed = (m, d, name) => add(new Date(year, m - 1, d), name);
    const in_ = (...states) => states.includes(state);
    const easter = easterSunday(year);

    fixed(1, 1, 'Neujahr');
    if (in_('BW', 'BY', 'ST')) fixed(1, 6, 'Heilige Drei Könige');
    if (in_('BE') || (in_('MV') && year >= 2023)) fixed(3, 8, 'Internationaler Frauentag');
    add(addDays(easter, -2), 'Karfreitag');
    add(addDays(easter, 1), 'Ostermontag');
    fixed(5, 1, 'Tag der Arbeit');
    add(addDays(easter, 39), 'Christi Himmelfahrt');
    add(addDays(easter, 50), 'Pfingstmontag');
    if (in_('BW', 'BY', 'HE', 'NW', 'RP', 'SL')) add(addDays(easter, 60), 'Fronleichnam');
    if (in_('SL')) fixed(8, 15, 'Mariä Himmelfahrt');
    if (in_('TH') && year >= 2019) fixed(9, 20, 'Weltkindertag');
    fixed(10, 3, 'Tag der Deutschen Einheit');
    if (in_('BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH')) fixed(10, 31, 'Reformationstag');
    if (in_('BW', 'BY', 'NW', 'RP', 'SL')) fixed(11, 1, 'Allerheiligen');
    if (in_('SN')) {
      const nov22 = new Date(year, 10, 22);
      add(addDays(nov22, -((nov22.getDay() - 3 + 7) % 7)), 'Buß- und Bettag');
    }
    fixed(12, 25, '1. Weihnachtstag');
    fixed(12, 26, '2. Weihnachtstag');

    holidayCache.set(cacheKey, map);
    return map;
  }

  const holidayName = (key, settings) => holidays(Number(key.slice(0, 4)), settings.state)[key] || null;

  function isWorkingDay(key, settings) {
    const d = fromKey(key);
    return settings.workdays.includes(isoWeekday(d)) && !holidayName(key, settings);
  }

  // ---------- Yearly summary ----------
  // `since` (tracking start): days before it are not counted as "unrecorded".
  function summarize(entries, year, settings, today = todayKey(), since = '0000-00-00') {
    const zero = () => Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
    const counts = zero();
    const monthly = Array.from({ length: 12 }, zero);
    let workingDays = 0, workingElapsed = 0, unrecorded = 0, weekdayHolidays = 0;

    for (const key of yearKeys(year)) {
      const e = entries[key];
      const d = fromKey(key);
      if (isWorkingDay(key, settings)) {
        workingDays++;
        if (key <= today) workingElapsed++;
        if (key < today && key >= since && !(e && e.category)) unrecorded++;
      } else if (settings.workdays.includes(isoWeekday(d))) {
        weekdayHolidays++;
      }
      if (e && e.category && counts[e.category] !== undefined) {
        counts[e.category]++;
        monthly[d.getMonth()][e.category]++;
      }
    }

    const recorded = Object.values(counts).reduce((a, b) => a + b, 0);
    const km = Number(settings.commuteKm) || 0;
    const commutePerDay = Math.min(km, 20) * settings.commuteRateFirst20 + Math.max(km - 20, 0) * settings.commuteRateAfter20;
    const homeClaimable = Math.min(counts.home, settings.homeOfficeCap);

    return {
      year, counts, monthly, recorded, workingDays, workingElapsed, unrecorded, weekdayHolidays,
      tax: {
        homeDays: counts.home,
        homeClaimable,
        homeAmount: homeClaimable * settings.homeOfficeRate,
        officeDays: counts.office,
        commuteKm: km,
        commutePerDay,
        commuteAmount: counts.office * commutePerDay,
        tripDays: counts.trip,
      },
    };
  }

  const euro = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

  return {
    CATEGORIES, CATEGORY_MAP, STATES, DEFAULT_SETTINGS, MONTHS,
    toKey, fromKey, addDays, todayKey, parseTime, minutesOfDay, isoWeekday, yearKeys,
    formatLong, formatShort, holidays, holidayName, isWorkingDay, summarize, euro,
  };
});
