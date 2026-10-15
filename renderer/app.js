(() => {
  'use strict';
  const api = window.api;
  const { CATEGORIES, CATEGORY_MAP } = WT;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const currentYear = () => new Date().getFullYear();

  const VIEWS = [
    { id: 'today', label: 'Today', icon: 'today' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar' },
    { id: 'summary', label: 'Summary', icon: 'summary' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];
  const NOTE_PLACEHOLDER = {
    office: 'Meetings, tasks, anything worth remembering…',
    home: 'What did you work on today?',
    trip: 'Destination, purpose, departure/return times…',
    vacation: 'Where did you go?',
    sick: 'Optional',
  };

  const state = { view: 'today', year: currentYear(), brush: null };

  // ---------- helpers ----------
  const catStyle = (id) => `style="--c:var(--c-${id})"`;

  function toast(msg) {
    const t = $('#toast');
    t.innerHTML = `${icon('check', 16)}<span>${esc(msg)}</span>`;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function yearSwitch(year) {
    return `<div class="year-switch">
      <button data-year="${year - 1}" title="Previous year">${icon('left', 16)}</button>
      <span>${year}</span>
      <button data-year="${year + 1}" title="Next year">${icon('right', 16)}</button>
    </div>`;
  }

  function missingDays(data, year, today) {
    const out = [];
    for (const key of WT.yearKeys(year)) {
      if (key >= today) break;
      if (key < data.trackingStart) continue;
      if (WT.isWorkingDay(key, data.settings) && !data.entries[key]?.category) out.push(key);
    }
    return out;
  }

  // ---------- views ----------
  async function viewToday() {
    const today = WT.todayKey();
    const year = Number(today.slice(0, 4));
    const data = await api.getYear(year);
    const s = data.settings;
    const entry = data.entries[today] || {};
    const holiday = WT.holidayName(today, s);
    const working = WT.isWorkingDay(today, s);
    const d = WT.fromKey(today);
    const monday = WT.addDays(d, 1 - WT.isoWeekday(d));
    const week = [0, 1, 2, 3, 4].map((i) => WT.toKey(WT.addDays(monday, i)));
    const missed = missingDays(data, year, today);
    const sum = WT.summarize(data.entries, year, s, today, data.trackingStart);
    const max = Math.max(1, ...Object.values(sum.counts));

    const dayPill = (k) => {
      const e = data.entries[k];
      const c = e?.category ? CATEGORY_MAP[e.category] : null;
      const hol = WT.holidayName(k, s);
      const label = c ? c.label : hol ? 'Holiday' : k > today || k < data.trackingStart ? '—' : k === today ? 'Pending' : 'Missing';
      return `<button class="week-day ${c ? 'filled' : ''} ${k === today ? 'is-today' : ''} ${hol ? 'holiday' : ''}" data-day="${k}" ${c ? catStyle(c.id) : ''} title="${esc(hol || '')}">
        <span class="wd">${WT.fromKey(k).toLocaleDateString('en-GB', { weekday: 'short' })}</span>
        <span class="dn">${WT.fromKey(k).getDate()}</span>
        <span class="wl">${c ? icon(c.icon, 14) : ''}${esc(label)}</span>
      </button>`;
    };

    return `
      <header class="page-head">
        <div>
          <div class="eyebrow">${d.toLocaleDateString('en-GB', { weekday: 'long' })}</div>
          <h1>${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</h1>
        </div>
        <div class="actions"><button class="btn ghost" data-act="plan">${icon('plus', 16)} Plan time off</button></div>
      </header>

      ${!working ? `<div class="banner">${icon('vacation', 18)}<span>${holiday ? `Today is <b>${esc(holiday)}</b>` : 'It’s the weekend'} — no check-in needed. You can still log the day if you worked.</span></div>` : ''}

      <section class="card hero">
        <div class="hero-head">
          <h2>${working ? 'Where are you working today?' : 'Log today anyway'}</h2>
          <span class="status ${entry.category ? 'ok' : ''}">${entry.category ? `${icon('check', 14)} Recorded` : 'Not recorded yet'}</span>
        </div>
        <div class="cat-grid">
          ${CATEGORIES.map((c) => `
            <button class="cat-btn ${entry.category === c.id ? 'selected' : ''}" data-today-cat="${c.id}" ${catStyle(c.id)}>
              <span class="cat-ic">${icon(c.icon, 22)}</span><span class="cat-label">${c.label}</span>
            </button>`).join('')}
        </div>
        <div class="note-wrap">
          <label for="today-note">${icon('note', 15)} Note for today <span class="saved-hint" id="note-hint"></span></label>
          <textarea id="today-note" rows="3" placeholder="${esc(NOTE_PLACEHOLDER[entry.category] || 'Anything worth remembering about today…')}">${esc(entry.note || '')}</textarea>
        </div>
      </section>

      <div class="grid-2">
        <section class="card">
          <h3>This week</h3>
          <div class="week">${week.map(dayPill).join('')}</div>
        </section>
        <section class="card">
          <div class="card-head"><h3>${year} so far</h3><button class="link" data-go="summary">Full summary ${icon('right', 14)}</button></div>
          <div class="mini-bars">
            ${CATEGORIES.map((c) => `
              <div class="mini-row" ${catStyle(c.id)}>
                <span class="mini-label">${c.label}</span>
                <span class="mini-track"><span class="mini-fill" style="width:${(sum.counts[c.id] / max) * 100}%"></span></span>
                <b>${sum.counts[c.id]}</b>
              </div>`).join('')}
          </div>
        </section>
      </div>

      ${missed.length ? `
        <section class="card missed">
          <div class="card-head"><h3>${missed.length} working day${missed.length > 1 ? 's' : ''} without a location</h3><button class="link" data-go="calendar">Open calendar ${icon('right', 14)}</button></div>
          <div class="chips">${missed.slice(-24).map((k) => `<button class="chip-btn" data-day="${k}">${WT.formatShort(k)}</button>`).join('')}</div>
        </section>` : ''}
    `;
  }

  async function viewCalendar() {
    const year = state.year;
    const data = await api.getYear(year);
    const s = data.settings;
    const today = WT.todayKey();
    const sum = WT.summarize(data.entries, year, s, today);
    const dows = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

    const months = WT.MONTHS.map((name, m) => {
      const first = new Date(year, m, 1);
      const cells = [];
      for (let i = 1; i < WT.isoWeekday(first); i++) cells.push('<span class="day blank"></span>');
      for (let d = first; d.getMonth() === m; d = WT.addDays(d, 1)) {
        const key = WT.toKey(d);
        const e = data.entries[key];
        const hol = WT.holidayName(key, s);
        const working = WT.isWorkingDay(key, s);
        const cls = ['day'];
        if (!s.workdays.includes(WT.isoWeekday(d))) cls.push('weekend');
        if (hol) cls.push('holiday');
        if (key === today) cls.push('today');
        if (e?.category) cls.push('filled');
        else if (working && key < today && key >= data.trackingStart) cls.push('missing');
        if (e?.note) cls.push('has-note');
        const tip = [WT.formatShort(key), hol, e?.category && CATEGORY_MAP[e.category].label, e?.note].filter(Boolean).join(' · ');
        cells.push(`<button class="${cls.join(' ')}" data-day="${key}" ${e?.category ? catStyle(e.category) : ''} title="${esc(tip)}">${d.getDate()}</button>`);
      }
      return `<div class="month"><h4>${name}</h4><div class="dows">${dows.map((x) => `<span>${x}</span>`).join('')}</div><div class="days">${cells.join('')}</div></div>`;
    }).join('');

    const brush = state.brush ? CATEGORY_MAP[state.brush] : null;
    return `
      <header class="page-head">
        <div><div class="eyebrow">Calendar</div><h1>${year}</h1></div>
        <div class="actions">${yearSwitch(year)}<button class="btn ghost" data-act="plan">${icon('plus', 16)} Plan time off</button></div>
      </header>
      <section class="card toolbar">
        <div class="legend">
          ${CATEGORIES.map((c) => `<button class="legend-item ${state.brush === c.id ? 'active' : ''}" data-brush="${c.id}" ${catStyle(c.id)} title="Paint days as ${c.label}"><span class="dot"></span>${c.label}<b>${sum.counts[c.id]}</b></button>`).join('')}
        </div>
        <div class="brush-hint ${brush ? 'on' : ''}">
          ${icon('brush', 15)}
          ${brush ? `<span>Painting <b>${brush.label}</b> — click days to apply, click again to remove.</span><button class="link" data-brush-off>Done</button>`
                  : '<span>Tip: pick a category above, then click days to fill them quickly.</span>'}
        </div>
      </section>
      <div class="months ${brush ? 'painting' : ''}">${months}</div>
      <div class="cal-key">
        <span><i class="k today"></i>Today</span><span><i class="k holiday"></i>Public holiday</span>
        <span><i class="k missing"></i>Not recorded</span><span><i class="k note"></i>Has a note</span>
      </div>`;
  }

  async function viewSummary() {
    const year = state.year;
    const data = await api.getYear(year);
    const s = data.settings;
    const sum = WT.summarize(data.entries, year, s, WT.todayKey(), data.trackingStart);
    const t = sum.tax;
    const pct = (n) => (sum.recorded ? Math.round((n / sum.recorded) * 100) : 0);
    const monthMax = Math.max(1, ...sum.monthly.map((m) => Object.values(m).reduce((a, b) => a + b, 0)));

    return `
      <header class="page-head">
        <div><div class="eyebrow">Year summary</div><h1>${year}</h1></div>
        <div class="actions">
          ${yearSwitch(year)}
          <button class="btn ghost" data-act="csv">${icon('download', 16)} CSV</button>
          <button class="btn primary" data-act="pdf">${icon('download', 16)} Export PDF</button>
        </div>
      </header>

      <div class="stats">
        ${CATEGORIES.map((c) => `
          <div class="stat card" ${catStyle(c.id)}>
            <span class="stat-ic tinted">${icon(c.icon, 20)}</span>
            <div class="stat-n">${sum.counts[c.id]}</div>
            <div class="stat-l">${c.label}</div>
            <div class="stat-p">${pct(sum.counts[c.id])}%</div>
          </div>`).join('')}
      </div>

      <section class="card">
        <div class="card-head">
          <h3>Distribution</h3>
          <span class="muted small">${sum.recorded} days recorded · ${sum.workingElapsed} of ${sum.workingDays} working days elapsed${sum.unrecorded ? ` · <button class="link warn" data-go="calendar">${sum.unrecorded} not recorded</button>` : ''}</span>
        </div>
        <div class="stack">
          ${sum.recorded ? CATEGORIES.filter((c) => sum.counts[c.id]).map((c) => `<span style="--c:var(--c-${c.id});flex:${sum.counts[c.id]}" title="${c.label}: ${sum.counts[c.id]}"></span>`).join('') : '<span class="empty"></span>'}
        </div>
      </section>

      <div class="grid-2 wide-left">
        <section class="card">
          <h3>By month</h3>
          <div class="month-bars">
            ${WT.MONTHS.map((name, i) => {
              const m = sum.monthly[i];
              const total = Object.values(m).reduce((a, b) => a + b, 0);
              return `<div class="mb-row"><span class="mb-label">${name.slice(0, 3)}</span>
                <span class="mb-track"><span class="mb-fill" style="width:${(total / monthMax) * 100}%">
                  ${CATEGORIES.filter((c) => m[c.id]).map((c) => `<span style="--c:var(--c-${c.id});flex:${m[c.id]}" title="${c.label}: ${m[c.id]}"></span>`).join('')}
                </span></span><b>${total || ''}</b></div>`;
            }).join('')}
          </div>
        </section>

        <section class="card tax">
          <h3>Tax estimates</h3>
          <div class="tax-item">
            <div class="tax-top"><span>Homeoffice-Pauschale</span><b>${WT.euro(t.homeAmount)}</b></div>
            <div class="muted small">${t.homeClaimable} days × ${WT.euro(s.homeOfficeRate)} · max ${s.homeOfficeCap} days</div>
            <div class="cap-track" ${catStyle('home')}><span style="width:${Math.min(100, (t.homeDays / s.homeOfficeCap) * 100)}%"></span></div>
          </div>
          <div class="tax-item">
            <div class="tax-top"><span>Entfernungspauschale</span><b>${t.commuteKm ? WT.euro(t.commuteAmount) : '—'}</b></div>
            <div class="muted small">${t.commuteKm ? `${t.officeDays} office days × ${t.commuteKm} km (${WT.euro(t.commutePerDay)}/day)` : '<button class="link" data-go="settings">Set your commute distance</button> to estimate'}</div>
          </div>
          <div class="tax-item">
            <div class="tax-top"><span>Dienstreise</span><b>${t.tripDays} days</b></div>
            <div class="muted small">Travel costs (Reisekosten) are claimed separately — your notes help.</div>
          </div>
          <p class="disclaimer">Estimates only, not tax advice. Rates can be changed in Settings.</p>
        </section>
      </div>`;
  }

  async function viewSettings() {
    const [data, acct] = await Promise.all([api.getYear(currentYear()), api.syncStatus()]);
    const s = data.settings;
    const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const row = (title, desc, control) => `<div class="set-row"><div><div class="set-title">${title}</div><div class="muted small">${desc}</div></div><div class="set-control">${control}</div></div>`;
    const num = (name, step, suffix) => `<span class="with-suffix"><input type="number" min="0" step="${step}" name="${name}" value="${s[name]}"><em>${suffix}</em></span>`;

    return `
      <header class="page-head"><div><div class="eyebrow">Preferences</div><h1>Settings</h1></div></header>

      <section class="card form sync-card">
        <h3>${icon('cloud', 17)} Sync & iPhone</h3>
        ${acct.signedIn ? `
          ${row(`Signed in as ${esc(acct.email)}`, acct.error ? `<span class="sync-err">Sync problem: ${esc(acct.error)}</span>` : `Last synced ${acct.lastSyncAt ? new Date(acct.lastSyncAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}`,
            '<div class="btn-row"><button class="btn ghost" data-sync="now">Sync now</button><button class="btn quiet" data-sync="out">Sign out</button></div>')}
          ${row('iPhone app', `On your iPhone open <b>${esc(acct.webAppUrl)}</b> in Safari → Share → <b>Add to Home Screen</b>, then sign in with the same account.`,
            '<button class="btn ghost" data-sync="copy">Copy link</button>')}
          ${row('Linux practice on iPhone', 'Also send the Linux command cards as iPhone notifications.', `<label class="switch"><input type="checkbox" name="phoneLinuxPractice" ${s.phoneLinuxPractice ? 'checked' : ''}><span></span></label>`)}`
        : `
          <p class="muted small">Sign in to sync your days and notes with the iPhone app. Your data stays private to your account.</p>
          <div class="sync-form">
            <input type="email" id="sync-email" placeholder="Email" autocomplete="username">
            <input type="password" id="sync-password" placeholder="Password (min. 8 characters)" autocomplete="current-password">
            <button class="btn primary" data-sync="in">Sign in</button>
            <button class="btn ghost" data-sync="up">Create account</button>
          </div>
          <p class="muted small" id="sync-msg">${acct.error ? esc(acct.error) : ''}</p>`}
      </section>

      <section class="card form">
        <h3>${icon('bell', 17)} Reminders</h3>
        ${row('Daily check-in', 'Asks where you’re working on each working day.', `<input type="time" name="checkinTime" value="${s.checkinTime}">`)}
        ${row('Daily note', 'Asks for a short note about your day.', `<input type="time" name="noteTime" value="${s.noteTime}">`)}
        ${row('Start with Windows', 'Runs quietly in the tray so reminders always arrive.', `<label class="switch"><input type="checkbox" name="openAtLogin" ${s.openAtLogin ? 'checked' : ''}><span></span></label>`)}
        ${row('Preview', 'See what the reminders look like.', `<div class="btn-row"><button class="btn ghost" data-test="checkin">Check-in</button><button class="btn ghost" data-test="note">Note</button></div>`)}
      </section>

      <section class="card form">
        <h3>Linux practice</h3>
        ${row('Practice reminders', 'Random command cards on your working days. Holidays, Urlaub and Krank are skipped.', `<label class="switch"><input type="checkbox" aria-label="Enable Linux practice" name="linuxPracticeEnabled" ${s.linuxPracticeEnabled ? 'checked' : ''}><span></span></label>`)}
        ${row('Popups per day', '1–24 reminders, spread randomly across the time window.', `<input class="practice-count" type="number" min="1" max="24" step="1" aria-label="Linux popups per day" name="linuxPracticeCount" value="${s.linuxPracticeCount}" required>`)}
        ${row('Time window', 'Local time. Start must be before end; allow at least one minute per popup.', `<div class="practice-times"><label>From<input type="time" aria-label="Linux practice start" name="linuxPracticeStart" value="${s.linuxPracticeStart}" required></label><label>To<input type="time" aria-label="Linux practice end" name="linuxPracticeEnd" value="${s.linuxPracticeEnd}" required></label></div>`)}
        ${row('Try a command', '117 commands in 9 categories, including Git, Docker and GPU tools. Commands do not repeat until you have seen them all.', '<button class="btn ghost" data-test="linux">Practice now</button>')}
        <p class="muted small">Check-in and note popups take priority. Missed or conflicting practice reminders are skipped. Practice now and Next command advance your saved command history without using a daily reminder.</p>
      </section>

      <section class="card form">
        <h3>${icon('calendar', 17)} Calendar</h3>
        ${row('Bundesland', 'Public holidays are skipped automatically.', `<select name="state">${Object.entries(WT.STATES).map(([k, v]) => `<option value="${k}" ${s.state === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}
        ${row('Working days', 'Days on which you get asked.', `<div class="wd-picker">${wd.map((n, i) => `<label><input type="checkbox" name="workdays" value="${i + 1}" ${s.workdays.includes(i + 1) ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>`)}
        ${row('Tracking since', 'Missing-day reminders start from this date.', `<input type="date" name="trackingStart" value="${data.trackingStart}">`)}
      </section>

      <section class="card form">
        <h3>${icon('summary', 17)} Tax estimates</h3>
        ${row('Commute distance', 'One-way distance home → office.', num('commuteKm', 1, 'km'))}
        ${row('Entfernungspauschale', 'Rate per km for km 1–20 and from km 21.', `<div class="btn-row">${num('commuteRateFirst20', 0.01, '€')}${num('commuteRateAfter20', 0.01, '€')}</div>`)}
        ${row('Homeoffice-Pauschale', 'Rate per day and maximum days per year.', `<div class="btn-row">${num('homeOfficeRate', 1, '€')}${num('homeOfficeCap', 1, 'days')}</div>`)}
      </section>

      <section class="card form">
        <h3>${icon('folder', 17)} Your data</h3>
        ${row('Stored on this PC', 'One JSON file with automatic daily backups (last 14 days).', '<button class="btn ghost" data-act="folder">Open data folder</button>')}
      </section>
`;
  }

  const RENDERERS = { today: viewToday, calendar: viewCalendar, summary: viewSummary, settings: viewSettings };

  // ---------- render ----------
  async function render() {
    $('#nav').innerHTML = VIEWS.map((v) => `<button class="${state.view === v.id ? 'active' : ''}" data-view="${v.id}">${icon(v.icon)}<span>${v.label}</span></button>`).join('');
    const main = $('#main');
    const scroll = main.scrollTop;
    const html = await RENDERERS[state.view]();
    main.innerHTML = `<div class="page view-${state.view}">${html}</div>`;
    main.scrollTop = scroll;
    if (state.view === 'today') bindTodayNote();
    renderFoot();
  }

  async function renderFoot() {
    const year = currentYear();
    const data = await api.getYear(year);
    const sum = WT.summarize(data.entries, year, data.settings, WT.todayKey(), data.trackingStart);
    const p = sum.workingElapsed ? Math.round(((sum.workingElapsed - sum.unrecorded) / sum.workingElapsed) * 100) : 0;
    $('#sidebar-foot').innerHTML = `
      <div class="foot-label"><span>${year}</span><span>${sum.recorded} days logged</span></div>
      <div class="foot-track"><span style="width:${p}%"></span></div>
      <div class="muted tiny">${sum.unrecorded ? `${sum.unrecorded} working day${sum.unrecorded > 1 ? 's' : ''} missing` : 'All caught up'}</div>`;
  }

  function go(view) {
    if (view !== 'calendar') state.brush = null;
    if (view === 'today' || view === 'settings') state.year = currentYear();
    state.view = view;
    $('#main').scrollTop = 0;
    render();
  }

  // ---------- Today: autosaving note ----------
  function bindTodayNote() {
    const ta = $('#today-note');
    const hint = $('#note-hint');
    let timer;
    ta.addEventListener('input', () => {
      hint.textContent = '';
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await api.setEntry(WT.todayKey(), { note: ta.value });
        hint.textContent = 'Saved';
      }, 600);
    });
  }

  // ---------- Settings ----------
  $('#main').addEventListener('change', async (e) => {
    const el = e.target;
    if (state.view !== 'settings' || !el.name) return;
    let patch;
    if (el.name.startsWith('linuxPractice') && el.type !== 'checkbox') {
      const count = $('[name="linuxPracticeCount"]');
      const start = $('[name="linuxPracticeStart"]');
      const end = $('[name="linuxPracticeEnd"]');
      if (![count, start, end].every((input) => input.reportValidity())) return;
      if (start.value >= end.value) { toast('Not saved: end time must be after start time'); return; }
      if (WT.parseTime(end.value) - WT.parseTime(start.value) < Number(count.value)) { toast('Not saved: allow at least one minute per popup'); return; }
      patch = { linuxPracticeCount: Number(count.value), linuxPracticeStart: start.value, linuxPracticeEnd: end.value };
    } else if (el.name === 'workdays') {
      patch = { workdays: $$('input[name="workdays"]:checked').map((x) => Number(x.value)) };
    } else if (el.type === 'checkbox') {
      patch = { [el.name]: el.checked };
    } else if (el.type === 'number') {
      if (el.value === '' || Number(el.value) < 0) return;
      patch = { [el.name]: Number(el.value) };
    } else {
      if (!el.value) return;
      patch = { [el.name]: el.value };
    }
    try {
      await api.saveSettings(patch);
      toast('Settings saved');
    } catch (error) {
      toast(`Not saved: ${error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')}`);
    }
  });

  // ---------- Day dialog ----------
  async function openDayDialog(key) {
    const data = await api.getYear(Number(key.slice(0, 4)));
    const entry = data.entries[key] || {};
    const hol = WT.holidayName(key, data.settings);
    let cat = entry.category || null;
    const dlg = $('#day-dialog');
    dlg.innerHTML = `
      <div class="modal-body">
        <div class="modal-head">
          <div><div class="eyebrow">${hol ? esc(hol) : WT.isWorkingDay(key, data.settings) ? 'Working day' : 'Weekend'}</div><h2>${WT.formatLong(key)}</h2></div>
          <button class="icon-btn" data-close title="Close">${icon('x')}</button>
        </div>
        <div class="cat-row">
          ${CATEGORIES.map((c) => `<button class="cat-chip ${cat === c.id ? 'selected' : ''}" data-cat="${c.id}" ${catStyle(c.id)}>${icon(c.icon, 16)}${c.label}</button>`).join('')}
        </div>
        <label class="field-label" for="dd-note">Note</label>
        <textarea id="dd-note" rows="4" placeholder="${esc(NOTE_PLACEHOLDER[cat] || 'Anything worth remembering…')}">${esc(entry.note || '')}</textarea>
        <div class="modal-foot">
          ${entry.category || entry.note ? '<button class="btn danger" data-clear>Clear day</button>' : ''}
          <span class="spacer"></span>
          <button class="btn quiet" data-close>Cancel</button>
          <button class="btn primary" data-save>Save</button>
        </div>
      </div>`;
    dlg.onclick = async (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
      const chip = e.target.closest('[data-cat]');
      if (chip) {
        cat = cat === chip.dataset.cat ? null : chip.dataset.cat;
        $$('.cat-chip', dlg).forEach((b) => b.classList.toggle('selected', b.dataset.cat === cat));
        $('#dd-note').placeholder = NOTE_PLACEHOLDER[cat] || 'Anything worth remembering…';
      }
      if (e.target.closest('[data-save]')) {
        await api.setEntry(key, { category: cat, note: $('#dd-note').value.trim() });
        dlg.close();
        toast(`${WT.formatShort(key)} saved`);
        render();
      }
      if (e.target.closest('[data-clear]')) {
        await api.clearEntry(key);
        dlg.close();
        render();
      }
    };
    dlg.onkeydown = (e) => { if (e.key === 'Enter' && e.ctrlKey) $('[data-save]', dlg).click(); };
    dlg.showModal();
  }

  // ---------- Range dialog ----------
  function openRangeDialog() {
    const today = WT.todayKey();
    const dlg = $('#range-dialog');
    dlg.innerHTML = `
      <div class="modal-body">
        <div class="modal-head">
          <div><div class="eyebrow">Fill several days at once</div><h2>Plan time off</h2></div>
          <button class="icon-btn" data-close title="Close">${icon('x')}</button>
        </div>
        <div class="range-grid">
          <label><span class="field-label">From</span><input type="date" id="rg-from" value="${today}"></label>
          <label><span class="field-label">To</span><input type="date" id="rg-to" value="${today}"></label>
        </div>
        <span class="field-label">Mark as</span>
        <div class="cat-row">
          ${CATEGORIES.map((c) => `<button class="cat-chip ${c.id === 'vacation' ? 'selected' : ''}" data-cat="${c.id}" ${catStyle(c.id)}>${icon(c.icon, 16)}${c.label}</button>`).join('')}
        </div>
        <label class="check"><input type="checkbox" id="rg-over"> Overwrite days that already have a location</label>
        <p class="muted small">Only working days are filled — weekends and public holidays are skipped.</p>
        <div class="modal-foot"><span class="spacer"></span><button class="btn quiet" data-close>Cancel</button><button class="btn primary" data-apply>Apply</button></div>
      </div>`;
    let cat = 'vacation';
    dlg.onclick = async (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
      const chip = e.target.closest('[data-cat]');
      if (chip) {
        cat = chip.dataset.cat;
        $$('.cat-chip', dlg).forEach((b) => b.classList.toggle('selected', b.dataset.cat === cat));
      }
      if (e.target.closest('[data-apply]')) {
        let from = $('#rg-from').value, to = $('#rg-to').value;
        if (!from || !to) return;
        if (from > to) [from, to] = [to, from];
        const n = await api.setRange(from, to, cat, $('#rg-over').checked);
        dlg.close();
        toast(`${n} day${n === 1 ? '' : 's'} marked as ${CATEGORY_MAP[cat].label}`);
        render();
      }
    };
    dlg.showModal();
  }

  // ---------- Calendar painting ----------
  async function paintDay(key) {
    const data = await api.getYear(Number(key.slice(0, 4)));
    const current = data.entries[key]?.category;
    await api.setEntry(key, { category: current === state.brush ? null : state.brush });
    render();
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const t = (sel) => e.target.closest(sel);
    let el;
    if ((el = t('#nav [data-view]'))) return go(el.dataset.view);
    if (!t('#main')) return;
    if ((el = t('[data-go]'))) return go(el.dataset.go);
    if ((el = t('[data-year]'))) { state.year = Number(el.dataset.year); return render(); }
    if ((el = t('[data-today-cat]'))) {
      const c = CATEGORY_MAP[el.dataset.todayCat];
      await api.setEntry(WT.todayKey(), { category: c.id });
      toast(`Today: ${c.label}`);
      return render();
    }
    if ((el = t('[data-brush]'))) { state.brush = state.brush === el.dataset.brush ? null : el.dataset.brush; return render(); }
    if (t('[data-brush-off]')) { state.brush = null; return render(); }
    if ((el = t('[data-day]'))) return state.view === 'calendar' && state.brush ? paintDay(el.dataset.day) : openDayDialog(el.dataset.day);
    if ((el = t('[data-test]'))) {
      const opened = await api.testPopup(el.dataset.test);
      if (!opened) toast('Close the current popup before starting Linux practice');
      return;
    }
    if ((el = t('[data-sync]'))) return onSyncAction(el);
    if ((el = t('[data-act]'))) {
      const act = el.dataset.act;
      if (act === 'plan') return openRangeDialog();
      if (act === 'folder') return api.openDataFolder();
      if (act === 'csv' || act === 'pdf') {
        const file = await (act === 'csv' ? api.exportCsv(state.year) : api.exportPdf(state.year));
        if (file) toast(`Exported ${act.toUpperCase()}`);
      }
    }
  });

  async function onSyncAction(el) {
    const action = el.dataset.sync;
    const msg = (text) => { const m = $('#sync-msg'); if (m) m.textContent = text; };
    try {
      el.disabled = true;
      if (action === 'in' || action === 'up') {
        const email = $('#sync-email').value.trim(), password = $('#sync-password').value;
        if (!email || password.length < 8) return msg('Enter your email and a password of at least 8 characters.');
        msg(action === 'in' ? 'Signing in…' : 'Creating account…');
        const r = action === 'in' ? await api.syncSignIn(email, password) : await api.syncSignUp(email, password);
        if (r?.needsConfirmation) return msg('Check your inbox and click the confirmation link, then come back and sign in.');
        toast('Signed in — synced');
      } else if (action === 'out') {
        await api.syncSignOut();
        toast('Signed out');
      } else if (action === 'now') {
        await api.syncNow();
        toast('Synced');
      } else if (action === 'copy') {
        await navigator.clipboard.writeText((await api.syncStatus()).webAppUrl);
        return toast('Link copied');
      }
      render();
    } catch (e) {
      msg(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      el.disabled = false;
    }
  }

  api.onSyncChanged(() => { if (state.view === 'settings' && !$('#sync-email')) render(); });

  api.onDataChanged(() => {
    // Don't yank the page away while the user is typing or has a dialog open.
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
    if ($('dialog[open]')) return;
    render();
  });
  api.onNavigate((view) => go(view));
  window.addEventListener('focus', () => {
    const a = document.activeElement;
    if (!$('dialog[open]') && !(a && /TEXTAREA|INPUT|SELECT/.test(a.tagName))) render();
  });

  render();
})();
