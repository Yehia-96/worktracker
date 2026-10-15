// CSV + printable HTML (→ PDF) exports of a year.
const WT = require('../shared/core');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Every relevant day of the year: working days, weekday holidays, and any day with an entry. */
function yearRows(year, entries, settings) {
  const rows = [];
  for (const key of WT.yearKeys(year)) {
    const e = entries[key];
    const weekday = settings.workdays.includes(WT.isoWeekday(WT.fromKey(key)));
    if (!weekday && !e) continue;
    const holiday = WT.holidayName(key, settings);
    rows.push({ key, holiday, category: e?.category ? WT.CATEGORY_MAP[e.category] : null, note: e?.note || '' });
  }
  return rows;
}

function buildCsv(year, entries, settings) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [['Date', 'Weekday', 'Category', 'Holiday', 'Note'].join(';')];
  for (const r of yearRows(year, entries, settings)) {
    const weekday = WT.fromKey(r.key).toLocaleDateString('en-GB', { weekday: 'long' });
    lines.push([r.key, weekday, r.category?.label || '', r.holiday || '', q(r.note)].join(';'));
  }
  const s = WT.summarize(entries, year, settings);
  lines.push('', 'Summary;Days');
  for (const c of WT.CATEGORIES) lines.push(`${c.label};${s.counts[c.id]}`);
  // BOM + semicolons so German Excel opens it correctly.
  return '﻿' + lines.join('\r\n');
}

function buildReportHtml(year, entries, settings) {
  const s = WT.summarize(entries, year, settings);
  const generated = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const chip = (c) => `<span class="chip" style="--c:${c.color}">${esc(c.label)}</span>`;
  const tiles = WT.CATEGORIES.map((c) => `
    <div class="tile" style="--c:${c.color}"><div class="n">${s.counts[c.id]}</div><div class="l">${esc(c.label)}</div></div>`).join('');
  const monthRows = WT.MONTHS.map((m, i) => `
    <tr><td>${m}</td>${WT.CATEGORIES.map((c) => `<td class="num">${s.monthly[i][c.id] || '–'}</td>`).join('')}
    <td class="num b">${Object.values(s.monthly[i]).reduce((a, b) => a + b, 0) || '–'}</td></tr>`).join('');
  const dayRows = yearRows(year, entries, settings)
    .filter((r) => r.category || r.note)
    .map((r) => `<tr><td class="nowrap">${esc(WT.formatShort(r.key))}</td><td>${r.category ? chip(r.category) : ''}</td><td>${esc(r.note)}</td></tr>`)
    .join('');
  const t = s.tax;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Work location summary ${year}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #141824; font-size: 10.5pt; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2px; letter-spacing: -0.02em; }
  h2 { font-size: 12pt; margin: 26px 0 10px; }
  .muted { color: #667085; }
  .tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 18px; }
  .tile { border: 1px solid #E4E7EF; border-top: 4px solid var(--c); border-radius: 10px; padding: 10px 12px; }
  .tile .n { font-size: 22pt; font-weight: 700; }
  .tile .l { color: #667085; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #EEF0F5; vertical-align: top; }
  th { font-size: 9pt; color: #667085; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .b { font-weight: 700; }
  .nowrap { white-space: nowrap; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 99px; background: color-mix(in srgb, var(--c) 16%, white); color: color-mix(in srgb, var(--c) 75%, black); font-weight: 600; font-size: 9pt; white-space: nowrap; }
  .tax td:last-child { text-align: right; font-weight: 700; }
  .note { font-size: 9pt; color: #667085; margin-top: 8px; }
  tr { page-break-inside: avoid; }
</style></head><body>
  <h1>Work location summary ${year}</h1>
  <div class="muted">${esc(WT.STATES[settings.state])} · Generated ${generated} · ${s.recorded} days recorded</div>
  <div class="tiles">${tiles}</div>

  <h2>Tax estimates</h2>
  <table class="tax">
    <tr><td>Homeoffice-Pauschale</td><td class="muted">${t.homeClaimable} days × ${WT.euro(settings.homeOfficeRate)}${t.homeDays > t.homeClaimable ? ` (capped at ${settings.homeOfficeCap} days; ${t.homeDays} recorded)` : ''}</td><td>${WT.euro(t.homeAmount)}</td></tr>
    <tr><td>Entfernungspauschale</td><td class="muted">${t.commuteKm ? `${t.officeDays} office days × ${t.commuteKm} km → ${WT.euro(t.commutePerDay)}/day` : 'Commute distance not set'}</td><td>${t.commuteKm ? WT.euro(t.commuteAmount) : '–'}</td></tr>
    <tr><td>Dienstreise</td><td class="muted">${t.tripDays} days — travel expenses (Reisekosten) are claimed separately with receipts</td><td>–</td></tr>
  </table>
  <div class="note">Estimates only, not tax advice. Rates as configured in the app.</div>

  <h2>By month</h2>
  <table><tr><th>Month</th>${WT.CATEGORIES.map((c) => `<th class="num">${esc(c.label)}</th>`).join('')}<th class="num">Total</th></tr>${monthRows}</table>

  <h2>Day log</h2>
  <table><tr><th>Date</th><th>Location</th><th>Note</th></tr>${dayRows || '<tr><td colspan="3" class="muted">No entries yet.</td></tr>'}</table>
</body></html>`;
}

module.exports = { buildCsv, buildReportHtml };
