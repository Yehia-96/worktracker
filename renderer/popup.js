(() => {
  'use strict';
  const api = window.api;
  const { CATEGORIES, CATEGORY_MAP } = WT;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NOTE_PLACEHOLDER = {
    office: 'Meetings, tasks, anything worth remembering…',
    home: 'What did you work on today?',
    trip: 'Destination, purpose, departure/return times…',
  };

  let payload;
  let idx = 0;

  // Card height + body padding (12 top, 16 bottom) so the window hugs the content.
  const fit = () => requestAnimationFrame(() => api.popupResize($('#card').offsetHeight + 28));

  function setContent(html) {
    $('#content').innerHTML = html;
    fit();
  }

  function done(title, sub, color) {
    setContent(`<div class="done" style="--c:${color}"><span class="done-ic">${icon('check', 22)}</span><div><b>${esc(title)}</b><span class="sub">${esc(sub)}</span></div></div>`);
    setTimeout(() => api.popupClose(), 1500);
  }

  // ---------- Check-in ----------
  function renderCheckin() {
    const item = payload.queue[idx];
    const many = payload.queue.length > 1;
    setContent(`
      <h2>${item.isToday ? 'Where are you working today?' : `Where did you work on ${WT.formatShort(item.date)}?`}</h2>
      <div class="sub">${item.isToday ? WT.formatLong(item.date) : 'This day has no location yet'}${many ? ` · ${idx + 1} of ${payload.queue.length}` : ''}</div>
      ${many ? `<div class="progress">${payload.queue.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div>` : ''}
      <div class="choices">
        ${CATEGORIES.map((c, i) => `
          <button class="choice ${item.current === c.id ? 'current' : ''}" data-cat="${c.id}" style="--c:var(--c-${c.id})" title="${c.label} (${i + 1})">
            <span class="ic">${icon(c.icon, 22)}</span>${c.label}
          </button>`).join('')}
      </div>
      <div class="foot">
        <button class="btn quiet" data-later>Remind me in 30 min</button>
        <span class="spacer"></span>
        ${many ? '<button class="btn quiet" data-open>Open calendar</button>' : ''}
      </div>`);
  }

  async function choose(catId) {
    const item = payload.queue[idx];
    const btn = document.querySelector(`[data-cat="${catId}"]`);
    btn?.classList.add('picked');
    await api.popupChoose(item.date, catId);
    const c = CATEGORY_MAP[catId];
    setTimeout(() => {
      idx++;
      if (idx < payload.queue.length) return renderCheckin();
      done(
        item.isToday ? `${c.label} — got it` : 'All caught up',
        item.isToday ? 'Have a good day!' : `${payload.queue.length} day${payload.queue.length > 1 ? 's' : ''} recorded`,
        c.color,
      );
    }, 220);
  }

  // ---------- Note ----------
  function renderNote() {
    let cat = payload.entry?.category || null;
    setContent(`
      <h2>Anything to note about today?</h2>
      <div class="sub">${WT.formatLong(payload.date)}</div>
      <div class="chips">
        ${CATEGORIES.map((c) => `<button class="chip ${cat === c.id ? 'selected' : ''}" data-chip="${c.id}" style="--c:var(--c-${c.id})">${icon(c.icon, 14)}${c.label}</button>`).join('')}
      </div>
      <textarea id="note" placeholder="${esc(NOTE_PLACEHOLDER[cat] || 'A few words about your day…')}">${esc(payload.entry?.note || '')}</textarea>
      <div class="foot">
        <button class="btn quiet" data-skip>Skip today</button>
        <button class="btn quiet" data-later>Later</button>
        <span class="spacer"></span>
        <span class="kbd">Ctrl+Enter</span>
        <button class="btn primary" data-save>Save</button>
      </div>`);

    const note = $('#note');
    $('#content').onclick = (e) => {
      const chip = e.target.closest('[data-chip]');
      if (!chip) return;
      cat = chip.dataset.chip;
      document.querySelectorAll('[data-chip]').forEach((b) => b.classList.toggle('selected', b.dataset.chip === cat));
      note.placeholder = NOTE_PLACEHOLDER[cat] || 'A few words about your day…';
    };
    const save = async () => {
      const text = note.value.trim();
      if (!text && !cat) return note.focus();
      await api.popupSaveNote(payload.date, text, cat);
      done('Saved', text ? 'Your note is in the log' : 'Day recorded', cat ? CATEGORY_MAP[cat].color : '#10B981');
    };
    $('[data-save]').onclick = save;
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) save(); });
  }

  // ---------- Linux practice ----------
  function renderPractice() {
    const { command, progress, total } = payload;
    $('#close').title = 'Dismiss Linux practice';
    document.body.classList.add('linux-practice');
    setContent(`
      <div class="practice-heading"><span class="practice-tag">Linux practice</span><span class="sub">${progress} / ${total} commands</span></div>
      <div class="practice-category">${esc(command.category)}</div>
      <h2 class="command-name">${esc(command.name)}</h2>
      <p class="practice-description">${esc(command.description)}</p>
      <div class="practice-label">Syntax</div>
      <pre><code>${esc(command.syntax)}</code></pre>
      <div class="practice-label">${command.examples.length > 1 ? 'Examples' : 'Example'}</div>
      ${command.examples.map((example, i) => `<div class="practice-example"><pre><code>${esc(example)}</code></pre><button class="btn quiet copy-example" data-copy="${i}" aria-label="Copy example ${i + 1}">Copy example</button></div>`).join('')}
      <div class="practice-exercise"><b>Try it</b><p>${esc(command.exercise)}</p></div>
      <div class="sub practice-hint">Try it on the DGX (ssh dgx) or in WSL, inside a practice folder.</div>
      <div class="foot practice-foot"><span id="practice-status" role="status"></span><span class="spacer"></span><button class="btn ghost" data-next>Next command</button><button class="btn primary" data-got-it>Got it</button></div>`);
  }

  // ---------- Wiring ----------
  document.addEventListener('click', async (e) => {
    const t = (sel) => e.target.closest(sel);
    let el;
    if ((el = t('[data-copy]'))) {
      const copied = await api.practiceCopy(Number(el.dataset.copy));
      if (el.isConnected) el.textContent = copied ? 'Copied!' : 'Try again';
      return;
    }
    if ((el = t('[data-next]'))) {
      el.disabled = true;
      try {
        const next = await api.practiceNext();
        if (next) { payload = next; renderPractice(); $('[data-next]').focus({ preventScroll: true }); window.scrollTo(0, 0); }
      } catch {
        $('#practice-status').textContent = 'Could not load. Try again.';
        el.disabled = false;
      }
      return;
    }
    if (t('[data-got-it]')) return api.popupClose();
    if ((el = t('[data-cat]'))) return choose(el.dataset.cat);
    if (t('[data-later]') || t('#close')) return api.popupSnooze();
    if (t('[data-skip]')) return api.popupSkipNote(payload.date);
    if (t('[data-open]')) { api.openMain('calendar'); return api.popupSnooze(); }
  });

  // Number keys 1–5 pick a category in check-in mode.
  document.addEventListener('keydown', (e) => {
    if (payload?.mode === 'linux' && e.key === 'Escape') return api.popupClose();
    if (payload?.mode !== 'checkin') return;
    const c = CATEGORIES[Number(e.key) - 1];
    if (c) choose(c.id);
    if (e.key === 'Escape') api.popupSnooze();
  });

  async function init() {
    $('#close').innerHTML = icon('x', 15);
    $('#when').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    payload = await api.popupGet();
    if (!payload) return api.popupClose();
    if (payload.mode === 'linux') renderPractice();
    else payload.mode === 'note' ? renderNote() : renderCheckin();
  }
  init();
})();
