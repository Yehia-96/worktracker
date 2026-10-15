(() => {
  'use strict';
  const { CATEGORIES, CATEGORY_MAP } = WT;
  const cfg = WTConfig;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const catStyle = (id) => `style="--c:var(--c-${id})"`;
  const NOTE_PLACEHOLDER = {
    office: 'Meetings, tasks, anything worth remembering…',
    home: 'What did you work on today?',
    trip: 'Destination, purpose, departure/return times…',
  };
  const VIEWS = [
    { id: 'today', label: 'Today', icon: 'today' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar' },
    { id: 'summary', label: 'Summary', icon: 'summary' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];

  const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---------- Local cache (fast start + offline) ----------
  const storage = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  };
  const deviceId = storage.get('wt.device') || (() => { const id = `iphone-${crypto.randomUUID()}`; storage.set('wt.device', id); return id; })();
  const cache = storage.get('wt.cache', { entries: {}, cursor: null, settings: null, settingsAt: null, trackingStart: null });
  let outbox = storage.get('wt.outbox', []);
  const saveCache = () => { storage.set('wt.cache', cache); storage.set('wt.outbox', outbox); };

  const state = {
    view: 'today', session: null, year: new Date().getFullYear(),
    month: new Date().getMonth(), syncing: false, highlight: null,
  };
  const settings = () => ({ ...WT.DEFAULT_SETTINGS, ...(cache.settings || {}) });
  const trackingStart = () => cache.trackingStart || '2000-01-01';
  const entry = (key) => { const e = cache.entries[key]; return e && !e.deleted ? e : null; };
  const yearEntries = (year) => {
    const out = {};
    for (const [k, e] of Object.entries(cache.entries)) if (k.startsWith(`${year}-`) && !e.deleted) out[k] = e;
    return out;
  };

  function toast(msg) {
    const t = $('#toast');
    t.innerHTML = `${icon('check', 16)}<span>${esc(msg)}</span>`;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  // ---------- Sync ----------
  async function pull() {
    const since = cache.cursor ? new Date(Date.parse(cache.cursor) - 60000).toISOString() : '1970-01-01T00:00:00Z';
    let changed = false;
    for (let page = 0; page < 50; page++) {
      const { data: rows, error } = await db.from('entries')
        .select('date, category, note, deleted, updated_at, synced_at')
        .gt('synced_at', since).order('synced_at').range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      for (const r of rows) {
        const local = cache.entries[r.date];
        if (local && Date.parse(local.updatedAt) >= Date.parse(r.updated_at)) continue;
        cache.entries[r.date] = { category: r.category, note: r.note || '', deleted: r.deleted, updatedAt: new Date(r.updated_at).toISOString() };
        changed = true;
      }
      if (rows.length) cache.cursor = rows[rows.length - 1].synced_at;
      if (rows.length < 1000) break;
    }
    const { data: s, error } = await db.from('user_settings').select('settings, updated_at').maybeSingle();
    if (error) throw error;
    if (s && (!cache.settingsAt || Date.parse(s.updated_at) > Date.parse(cache.settingsAt))) {
      const { trackingStart: ts, ...rest } = s.settings || {};
      cache.settings = rest;
      if (ts) cache.trackingStart = ts;
      cache.settingsAt = s.updated_at;
      changed = true;
    }
    saveCache();
    return changed;
  }

  async function flush() {
    if (!outbox.length || !state.session) return;
    const rows = outbox.slice();
    const { error } = await db.rpc('upsert_entries', { rows });
    if (error) throw error;
    outbox = outbox.slice(rows.length);
    saveCache();
  }

  async function syncNow({ quiet = true } = {}) {
    if (!state.session || state.syncing) return;
    state.syncing = true;
    try {
      await flush();
      if (await pull()) render();
      if (!quiet) toast('Synced');
    } catch (e) {
      if (!quiet) toast(navigator.onLine ? `Sync failed: ${e.message}` : 'Offline — changes will sync later');
    } finally {
      state.syncing = false;
    }
  }

  function saveEntry(date, patch) {
    const prev = entry(date) || {};
    const next = { category: prev.category ?? null, note: prev.note ?? '', ...patch };
    const deleted = !next.category && !next.note;
    const updatedAt = new Date().toISOString();
    cache.entries[date] = deleted ? { deleted: true, updatedAt } : { category: next.category, note: next.note, deleted: false, updatedAt };
    outbox = outbox.filter((r) => r.date !== date);
    outbox.push({ date, category: deleted ? null : next.category, note: deleted ? '' : next.note, deleted, updated_at: updatedAt, device_id: deviceId });
    saveCache();
    flush().catch(() => { /* retried on next sync */ });
  }

  async function saveSettings(patch) {
    const { trackingStart: ts, ...rest } = patch;
    cache.settings = { ...settings(), ...rest };
    if (ts) cache.trackingStart = ts;
    cache.settingsAt = new Date().toISOString();
    saveCache();
    const subset = Object.fromEntries(cfg.SYNCED_SETTINGS.map((k) => [k, cache.settings[k]]));
    subset.trackingStart = cache.trackingStart;
    const { error } = await db.from('user_settings').upsert({
      user_id: state.session.user.id, settings: subset, updated_at: cache.settingsAt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
    });
    if (error) throw error;
  }

  // ---------- Push notifications ----------
  const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed. You can allow them in iPhone Settings → Notifications → Work Tracker.');
    const reg = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(cfg.VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    const json = sub.toJSON();
    const { error } = await db.from('push_subscriptions').upsert({
      user_id: state.session.user.id, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, device: navigator.userAgent.slice(0, 120),
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    // Make sure the reminder service knows our timezone and times.
    if (!cache.settingsAt) await saveSettings({});
  }

  async function pushStatus() {
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  }

  // ---------- Views ----------
  function missingDays(year, today) {
    const s = settings(), out = [];
    for (const key of WT.yearKeys(year)) {
      if (key >= today) break;
      if (key < trackingStart()) continue;
      if (WT.isWorkingDay(key, s) && !entry(key)?.category) out.push(key);
    }
    return out;
  }

  function viewToday() {
    const today = WT.todayKey();
    const d = WT.fromKey(today);
    const s = settings();
    const e = entry(today) || {};
    const holiday = WT.holidayName(today, s);
    const working = WT.isWorkingDay(today, s);
    const monday = WT.addDays(d, 1 - WT.isoWeekday(d));
    const week = [0, 1, 2, 3, 4].map((i) => WT.toKey(WT.addDays(monday, i)));
    const missed = missingDays(d.getFullYear(), today);

    return `
      <header class="m-head">
        <div class="eyebrow">${d.toLocaleDateString('en-GB', { weekday: 'long' })}</div>
        <h1>${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</h1>
      </header>
      ${!working ? `<div class="banner">${icon('vacation', 18)}<span>${holiday ? `Today is <b>${esc(holiday)}</b>` : 'It’s the weekend'} — no check-in needed.</span></div>` : ''}
      <section class="card ${state.highlight === 'checkin' ? 'pulse' : ''}">
        <div class="card-head"><h2>${working ? 'Where are you working today?' : 'Log today anyway'}</h2>
          ${e.category ? `<span class="status ok">${icon('check', 13)} Saved</span>` : ''}</div>
        <div class="cat-list">
          ${CATEGORIES.map((c) => `
            <button class="cat-row-btn ${e.category === c.id ? 'selected' : ''}" data-today-cat="${c.id}" ${catStyle(c.id)}>
              <span class="cat-ic">${icon(c.icon, 20)}</span><span>${c.label}</span>${e.category === c.id ? `<span class="tick">${icon('check', 18)}</span>` : ''}
            </button>`).join('')}
        </div>
      </section>
      <section class="card ${state.highlight === 'note' ? 'pulse' : ''}">
        <div class="card-head"><h2>Note for today</h2><span class="muted small" id="note-hint"></span></div>
        <textarea id="today-note" rows="4" placeholder="${esc(NOTE_PLACEHOLDER[e.category] || 'Anything worth remembering about today…')}">${esc(e.note || '')}</textarea>
        <button class="btn primary block" data-save-note>Save note</button>
      </section>
      <section class="card">
        <h2>This week</h2>
        <div class="week">${week.map((k) => {
          const we = entry(k), c = we?.category ? CATEGORY_MAP[we.category] : null;
          return `<button class="week-day ${c ? 'filled' : ''} ${k === today ? 'is-today' : ''}" data-day="${k}" ${c ? catStyle(c.id) : ''}>
            <span class="wd">${WT.fromKey(k).toLocaleDateString('en-GB', { weekday: 'short' })}</span>
            <span class="dn">${WT.fromKey(k).getDate()}</span>
            <span class="wi">${c ? icon(c.icon, 14) : WT.holidayName(k, s) ? '·' : '–'}</span></button>`;
        }).join('')}</div>
      </section>
      ${missed.length ? `<section class="card"><h2>${missed.length} day${missed.length > 1 ? 's' : ''} without a location</h2>
        <div class="chips">${missed.slice(-20).map((k) => `<button class="chip-btn" data-day="${k}">${WT.formatShort(k)}</button>`).join('')}</div></section>` : ''}`;
  }

  function viewCalendar() {
    const y = state.year, m = state.month;
    const s = settings();
    const today = WT.todayKey();
    const first = new Date(y, m, 1);
    const cells = [];
    for (let i = 1; i < WT.isoWeekday(first); i++) cells.push('<span class="day blank"></span>');
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
    for (let d = first; d.getMonth() === m; d = WT.addDays(d, 1)) {
      const key = WT.toKey(d), e = entry(key), hol = WT.holidayName(key, s);
      if (e?.category) counts[e.category]++;
      const cls = ['day'];
      if (!s.workdays.includes(WT.isoWeekday(d))) cls.push('weekend');
      if (hol) cls.push('holiday');
      if (key === today) cls.push('today');
      if (e?.category) cls.push('filled');
      else if (WT.isWorkingDay(key, s) && key < today && key >= trackingStart()) cls.push('missing');
      if (e?.note) cls.push('has-note');
      cells.push(`<button class="${cls.join(' ')}" data-day="${key}" ${e?.category ? catStyle(e.category) : ''}>${d.getDate()}</button>`);
    }
    return `
      <header class="m-head row">
        <div><div class="eyebrow">Calendar</div><h1>${WT.MONTHS[m]} ${y}</h1></div>
        <div class="pager"><button data-month="-1" aria-label="Previous month">${icon('left', 18)}</button><button data-month="1" aria-label="Next month">${icon('right', 18)}</button></div>
      </header>
      <section class="card cal">
        <div class="dows">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
        <div class="days">${cells.join('')}</div>
      </section>
      <div class="legend">${CATEGORIES.map((c) => `<span ${catStyle(c.id)}><i></i>${c.label} <b>${counts[c.id]}</b></span>`).join('')}</div>
      <p class="muted small center">Tap a day to set its location or note.</p>`;
  }

  function viewSummary() {
    const y = state.year, s = settings();
    const sum = WT.summarize(yearEntries(y), y, s, WT.todayKey(), trackingStart());
    const t = sum.tax;
    const pct = (n) => (sum.recorded ? Math.round((n / sum.recorded) * 100) : 0);
    const monthMax = Math.max(1, ...sum.monthly.map((mo) => Object.values(mo).reduce((a, b) => a + b, 0)));
    return `
      <header class="m-head row">
        <div><div class="eyebrow">Year summary</div><h1>${y}</h1></div>
        <div class="pager"><button data-year="-1" aria-label="Previous year">${icon('left', 18)}</button><button data-year="1" aria-label="Next year">${icon('right', 18)}</button></div>
      </header>
      <div class="stats">${CATEGORIES.map((c) => `
        <div class="stat card" ${catStyle(c.id)}><span class="stat-ic">${icon(c.icon, 18)}</span>
          <div class="stat-n">${sum.counts[c.id]}</div><div class="stat-l">${c.label}</div><div class="stat-p">${pct(sum.counts[c.id])}%</div></div>`).join('')}
        <div class="stat card total"><div class="stat-n">${sum.recorded}</div><div class="stat-l">Days logged</div>
          <div class="stat-p">${sum.unrecorded ? `${sum.unrecorded} missing` : 'complete'}</div></div>
      </div>
      <section class="card">
        <h2>Distribution</h2>
        <div class="stack">${sum.recorded ? CATEGORIES.filter((c) => sum.counts[c.id]).map((c) => `<span style="--c:var(--c-${c.id});flex:${sum.counts[c.id]}"></span>`).join('') : '<span class="empty"></span>'}</div>
      </section>
      <section class="card">
        <h2>Tax estimates</h2>
        <div class="tax-item"><div class="tax-top"><span>Homeoffice-Pauschale</span><b>${WT.euro(t.homeAmount)}</b></div>
          <div class="muted small">${t.homeClaimable} days × ${WT.euro(s.homeOfficeRate)} · max ${s.homeOfficeCap}</div></div>
        <div class="tax-item"><div class="tax-top"><span>Entfernungspauschale</span><b>${t.commuteKm ? WT.euro(t.commuteAmount) : '—'}</b></div>
          <div class="muted small">${t.commuteKm ? `${t.officeDays} office days × ${t.commuteKm} km` : 'Set your commute distance in the PC app'}</div></div>
        <div class="tax-item"><div class="tax-top"><span>Dienstreise</span><b>${t.tripDays} days</b></div>
          <div class="muted small">Reisekosten are claimed separately.</div></div>
        <p class="disclaimer">Estimates only, not tax advice. PDF export is in the PC app.</p>
      </section>
      <section class="card">
        <h2>By month</h2>
        <div class="month-bars">${WT.MONTHS.map((name, i) => {
          const mo = sum.monthly[i], total = Object.values(mo).reduce((a, b) => a + b, 0);
          return `<div class="mb-row"><span class="mb-label">${name.slice(0, 3)}</span><span class="mb-track"><span class="mb-fill" style="width:${(total / monthMax) * 100}%">
            ${CATEGORIES.filter((c) => mo[c.id]).map((c) => `<span style="--c:var(--c-${c.id});flex:${mo[c.id]}"></span>`).join('')}</span></span><b>${total || ''}</b></div>`;
        }).join('')}</div>
      </section>`;
  }

  async function viewSettings() {
    const s = settings();
    const push = await pushStatus();
    const pushRow = !isStandalone()
      ? `<p class="small">To get reminders, install the app first: tap <b>Share</b> ${icon('download', 14)} in Safari, then <b>Add to Home Screen</b>, and open Work Tracker from your Home Screen.</p>`
      : push === 'on' ? `<div class="set-line"><span>${icon('check', 16)} Notifications are on</span><button class="btn ghost sm" data-test-push>Test</button></div>`
      : push === 'denied' ? '<p class="small">Notifications are blocked. Allow them in iPhone Settings → Notifications → Work Tracker.</p>'
      : push === 'unsupported' ? '<p class="small">This browser can’t receive notifications. iOS 16.4 or newer is required.</p>'
      : '<button class="btn primary block" data-enable-push>Turn on notifications</button>';
    return `
      <header class="m-head"><div class="eyebrow">Preferences</div><h1>Settings</h1></header>
      <section class="card">
        <h2>${icon('bell', 17)} Notifications</h2>
        ${pushRow}
        <label class="set-line"><span>Check-in reminder</span><input type="time" name="checkinTime" value="${s.checkinTime}"></label>
        <label class="set-line"><span>Note reminder</span><input type="time" name="noteTime" value="${s.noteTime}"></label>
        <label class="set-line"><span>Linux practice cards</span><span class="switch"><input type="checkbox" name="phoneLinuxPractice" ${s.phoneLinuxPractice ? 'checked' : ''}><span></span></span></label>
        <p class="muted small">Your iPhone is reminded ${cfg.PHONE_DELAY_MIN} minutes after the PC, so answering at your desk keeps the phone quiet.</p>
        <button class="btn ghost block" data-practice-now>Practice a Linux command now</button>
      </section>
      <section class="card">
        <h2>${icon('calendar', 17)} Calendar</h2>
        <label class="set-line"><span>Bundesland</span><select name="state">${Object.entries(WT.STATES).map(([k, v]) => `<option value="${k}" ${s.state === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </section>
      <section class="card">
        <h2>${icon('cloud', 17)} Account</h2>
        <div class="set-line"><span class="small">${esc(state.session?.user.email)}</span><button class="btn quiet sm" data-signout>Sign out</button></div>
        <button class="btn ghost block" data-sync-now>Sync now</button>
        <p class="muted small">Tax rates, commute distance and exports are managed in the PC app.</p>
      </section>`;
  }

  function viewAuth(msg = '') {
    return `
      <div class="auth">
        <img src="icons/apple-touch-icon.png" alt="" class="auth-logo">
        <h1>Work Tracker</h1>
        <p class="muted">Sign in with the account you use in the PC app.</p>
        <input type="email" id="auth-email" placeholder="Email" autocomplete="username" inputmode="email">
        <input type="password" id="auth-password" placeholder="Password" autocomplete="current-password">
        <button class="btn primary block" data-auth="in">Sign in</button>
        <button class="btn ghost block" data-auth="up">Create account</button>
        <p class="muted small" id="auth-msg">${esc(msg)}</p>
      </div>`;
  }

  // ---------- Sheets (day editor, Linux practice) ----------
  function openSheet(html, onClick) {
    const root = $('#sheet-root');
    root.innerHTML = `<div class="sheet-backdrop"><div class="sheet" role="dialog">${html}</div></div>`;
    requestAnimationFrame(() => root.firstElementChild.classList.add('open'));
    root.firstElementChild.onclick = (e) => {
      if (e.target.classList.contains('sheet-backdrop') || e.target.closest('[data-close]')) return closeSheet();
      onClick?.(e);
    };
  }
  function closeSheet() {
    const b = $('#sheet-root').firstElementChild;
    if (!b) return;
    b.classList.remove('open');
    setTimeout(() => { $('#sheet-root').innerHTML = ''; }, 200);
  }

  function openDay(key) {
    const s = settings(), e = entry(key) || {};
    let cat = e.category || null;
    const hol = WT.holidayName(key, s);
    openSheet(`
      <div class="sheet-grip"></div>
      <div class="eyebrow">${hol ? esc(hol) : WT.isWorkingDay(key, s) ? 'Working day' : 'Weekend'}</div>
      <h2>${WT.formatLong(key)}</h2>
      <div class="chips cats">${CATEGORIES.map((c) => `<button class="cat-chip ${cat === c.id ? 'selected' : ''}" data-cat="${c.id}" ${catStyle(c.id)}>${icon(c.icon, 15)}${c.label}</button>`).join('')}</div>
      <textarea id="day-note" rows="4" placeholder="Note">${esc(e.note || '')}</textarea>
      <div class="sheet-foot">
        ${e.category || e.note ? '<button class="btn danger" data-clear>Clear</button>' : ''}<span class="spacer"></span>
        <button class="btn quiet" data-close>Cancel</button><button class="btn primary" data-save>Save</button>
      </div>`, (ev) => {
      const chip = ev.target.closest('[data-cat]');
      if (chip) {
        cat = cat === chip.dataset.cat ? null : chip.dataset.cat;
        $$('.cat-chip').forEach((b) => b.classList.toggle('selected', b.dataset.cat === cat));
      }
      if (ev.target.closest('[data-save]')) { saveEntry(key, { category: cat, note: $('#day-note').value.trim() }); closeSheet(); toast(`${WT.formatShort(key)} saved`); render(); }
      if (ev.target.closest('[data-clear]')) { saveEntry(key, { category: null, note: '' }); closeSheet(); render(); }
    });
  }

  let commands = null;
  async function openPractice(id) {
    commands = commands || await fetch('shared/linux-commands.json').then((r) => r.json());
    const seen = new Set(storage.get('wt.practiceSeen', []));
    let cmd = id && commands.find((c) => c.id === id);
    if (!cmd) {
      let pool = commands.filter((c) => !seen.has(c.id));
      if (!pool.length) { seen.clear(); pool = commands; }
      cmd = pool[Math.floor(Math.random() * pool.length)];
    }
    seen.add(cmd.id);
    storage.set('wt.practiceSeen', [...seen]);
    openSheet(`
      <div class="sheet-grip"></div>
      <div class="practice-top"><span class="practice-tag">Linux practice</span><span class="muted small">${seen.size} / ${commands.length}</span></div>
      <div class="muted small">${esc(cmd.category)}</div>
      <h2 class="cmd-name">${esc(cmd.name)}</h2>
      <p>${esc(cmd.description)}</p>
      <div class="label">Syntax</div><pre>${esc(cmd.syntax)}</pre>
      <div class="label">${cmd.examples.length > 1 ? 'Examples' : 'Example'}</div>
      ${cmd.examples.map((x, i) => `<div class="ex"><pre>${esc(x)}</pre><button class="btn quiet sm" data-copy="${i}">Copy</button></div>`).join('')}
      <div class="exercise"><b>Try it</b><p>${esc(cmd.exercise)}</p></div>
      <p class="muted small">Try it on the DGX (ssh dgx) or any Linux terminal.</p>
      <div class="sheet-foot"><button class="btn ghost" data-next>Next command</button><span class="spacer"></span><button class="btn primary" data-close>Got it</button></div>`, async (ev) => {
      const copy = ev.target.closest('[data-copy]');
      if (copy) { await navigator.clipboard.writeText(cmd.examples[Number(copy.dataset.copy)]); toast('Copied'); }
      if (ev.target.closest('[data-next]')) openPractice();
    });
  }

  // ---------- Render ----------
  async function render() {
    const app = $('#app'), tabbar = $('#tabbar');
    if (!state.session) {
      tabbar.hidden = true;
      if (!$('.auth')) app.innerHTML = viewAuth();
      return;
    }
    if (document.activeElement?.matches('textarea, input') && app.contains(document.activeElement)) return;
    tabbar.hidden = false;
    tabbar.innerHTML = VIEWS.map((v) => `<button class="${state.view === v.id ? 'active' : ''}" data-view="${v.id}">${icon(v.icon, 22)}<span>${v.label}</span></button>`).join('');
    const html = await { today: viewToday, calendar: viewCalendar, summary: viewSummary, settings: viewSettings }[state.view]();
    app.innerHTML = `<div class="page">${html}</div>`;
    state.highlight = null;
  }

  function go(view) {
    state.view = view;
    if (view === 'calendar' || view === 'summary') { state.year = new Date().getFullYear(); state.month = new Date().getMonth(); }
    window.scrollTo(0, 0);
    render();
  }

  // Opened from a notification: ?open=checkin|note or ?practice=<id>
  function handleUrl(href) {
    const url = new URL(href, location.href);
    const open = url.searchParams.get('open'), practice = url.searchParams.get('practice');
    if (open || practice) history.replaceState(null, '', url.pathname);
    if (open === 'checkin' || open === 'note') { state.highlight = open; go('today'); if (open === 'note') setTimeout(() => $('#today-note')?.focus(), 300); }
    if (practice) openPractice(practice);
  }

  // ---------- Events ----------
  document.addEventListener('click', async (e) => {
    const t = (sel) => e.target.closest(sel);
    let el;
    if ((el = t('[data-view]'))) return go(el.dataset.view);
    if ((el = t('[data-auth]'))) return onAuth(el.dataset.auth, el);
    if ((el = t('[data-today-cat]'))) {
      const c = CATEGORY_MAP[el.dataset.todayCat];
      saveEntry(WT.todayKey(), { category: c.id });
      navigator.vibrate?.(10);
      toast(`Today: ${c.label}`);
      return render();
    }
    if (t('[data-save-note]')) {
      saveEntry(WT.todayKey(), { note: $('#today-note').value.trim() });
      $('#today-note').blur();
      return toast('Note saved');
    }
    if ((el = t('[data-day]'))) return openDay(el.dataset.day);
    if ((el = t('[data-month]'))) {
      const d = new Date(state.year, state.month + Number(el.dataset.month), 1);
      state.year = d.getFullYear(); state.month = d.getMonth();
      return render();
    }
    if ((el = t('[data-year]'))) { state.year += Number(el.dataset.year); return render(); }
    if ((el = t('[data-enable-push]'))) {
      el.disabled = true;
      try { await enablePush(); toast('Notifications on'); } catch (err) { alert(err.message); }
      return render();
    }
    if (t('[data-test-push]')) {
      const reg = await navigator.serviceWorker.ready;
      return reg.showNotification('Work Tracker', { body: 'Notifications are working.', icon: 'icons/icon-192.png' });
    }
    if (t('[data-practice-now]')) return openPractice();
    if (t('[data-sync-now]')) return syncNow({ quiet: false });
    if (t('[data-signout]')) {
      if (!confirm('Sign out on this iPhone? Notifications stop until you sign in again.')) return;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
      await db.auth.signOut();
      localStorage.removeItem('wt.cache'); localStorage.removeItem('wt.outbox');
      location.reload();
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el.name || !state.session || state.view !== 'settings') return;
    const value = el.type === 'checkbox' ? el.checked : el.value;
    if (value === '') return;
    try { await saveSettings({ [el.name]: value }); toast('Saved'); } catch (err) { toast(`Not saved: ${err.message}`); }
  });

  async function onAuth(kind, btn) {
    const email = $('#auth-email').value.trim(), password = $('#auth-password').value;
    const msg = (m) => { $('#auth-msg').textContent = m; };
    if (!email || password.length < 8) return msg('Enter your email and a password of at least 8 characters.');
    btn.disabled = true;
    try {
      const { data, error } = kind === 'in'
        ? await db.auth.signInWithPassword({ email, password })
        : await db.auth.signUp({ email, password, options: { emailRedirectTo: cfg.WEB_APP_URL } });
      if (error) return msg(error.message);
      if (!data.session) return msg('Check your inbox and tap the confirmation link, then come back here and sign in.');
    } finally {
      btn.disabled = false;
    }
  }

  db.auth.onAuthStateChange((_event, session) => {
    const was = !!state.session;
    state.session = session;
    if (!!session !== was) { render(); if (session) syncNow(); }
  });

  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open') handleUrl(e.data.url); });
  }

  (async () => {
    const { data } = await db.auth.getSession();
    state.session = data.session;
    await render();
    handleUrl(location.href);
    syncNow();
  })();
})();
