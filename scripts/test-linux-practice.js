const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WT = require('../src/shared/core');
const Linux = require('../src/shared/linux-practice');
const { Store } = require('../src/main/store');
const settings = { ...WT.DEFAULT_SETTINGS };
const date = (time, day = '2026-10-13') => new Date(`${day}T${time}:00`);

test('catalog has unique commands and complete lessons in nine categories', () => {
  assert.ok(Linux.commands.length >= 100);
  assert.equal(new Set(Linux.commands.map(c => c.id)).size, Linux.commands.length);
  assert.equal(new Set(Linux.commands.map(c => c.category)).size, 9);
  for (const c of Linux.commands) {
    for (const field of ['id', 'category', 'name', 'description', 'syntax', 'exercise']) assert.ok(c[field]);
    assert.ok(c.examples.length >= 1 && c.examples.length <= 2);
    assert.ok(c.examples.every(example => typeof example === 'string' && example.length));
  }
});

test('random schedule has exactly four distinct times inside the window', () => {
  const outcomes = new Set();
  for (let i = 0; i < 100; i++) {
    const p = {};
    Linux.advance(p, settings, date('09:00'));
    assert.equal(p.daily.slots.length, 4);
    assert.equal(new Set(p.daily.slots).size, 4);
    assert.ok(p.daily.slots.every(t => t >= +date('10:00') && t < +date('16:00')));
    outcomes.add(JSON.stringify(p.daily.slots));
  }
  assert.ok(outcomes.size > 1);
});

test('working-day rules, holidays, days off, and disabled setting are respected', () => {
  for (const [day, opts, config] of [
    ['2026-10-10', {}, settings], ['2026-12-25', {}, settings],
    ['2026-10-13', { category: 'vacation' }, settings], ['2026-10-13', { category: 'sick' }, settings],
    ['2026-10-13', {}, { ...settings, linuxPracticeEnabled: false }],
  ]) {
    const p = {};
    assert.equal(Linux.advance(p, config, date('11:00', day), opts).show, false);
    assert.equal(p.daily.slots.length, 0);
  }
  const p = {};
  Linux.advance(p, { ...settings, workdays: [6] }, date('09:00', '2026-10-10'));
  assert.equal(p.daily.slots.length, 4);
});

test('busy slots are skipped permanently; idle slots fire only once', () => {
  const p = {};
  Linux.advance(p, settings, date('09:00'), {}, () => 0);
  assert.equal(Linux.advance(p, settings, date('10:00'), { busy: true }).show, false);
  assert.equal(Linux.advance(p, settings, date('10:00')).show, false);
  assert.equal(p.daily.used, 1);
  const next = new Date(p.daily.slots[0]);
  assert.equal(Linux.advance(p, settings, next).show, true);
  assert.equal(Linux.advance(p, settings, next).show, false);
});

test('sleep, restart, end of window, and next day do not produce catch-up bursts', () => {
  const p = {};
  Linux.advance(p, settings, date('09:00'), {}, () => 0);
  const reloaded = JSON.parse(JSON.stringify(p));
  assert.equal(Linux.advance(reloaded, settings, date('14:00')).show, false);
  assert.equal(reloaded.daily.used, 3);
  assert.equal(Linux.advance(reloaded, settings, date('16:00')).show, false);
  assert.equal(reloaded.daily.used, 4);
  Linux.advance(reloaded, settings, date('09:00', '2026-10-14'));
  assert.equal(reloaded.daily.used, 0);
  assert.equal(reloaded.daily.slots.length, 4);
});

test('late starts and settings changes use only remaining time and daily allowance', () => {
  const p = {};
  Linux.advance(p, settings, date('15:00'), {}, () => 0);
  assert.ok(p.daily.slots.every(t => t > +date('15:00') && t < +date('16:00')));
  Linux.advance(p, settings, new Date(p.daily.slots[0]));
  const changed = { ...settings, linuxPracticeCount: 6, linuxPracticeEnd: '17:00' };
  Linux.advance(p, changed, date('15:02'));
  assert.equal(p.daily.used, 1);
  assert.equal(p.daily.slots.length, 5);
  Linux.advance(p, { ...changed, linuxPracticeEnabled: false }, date('15:03'));
  assert.equal(p.daily.slots.length, 0);
  Linux.advance(p, changed, date('15:04'));
  assert.equal(p.daily.slots.length, 5);
  const after = {};
  Linux.advance(after, settings, date('16:00'));
  assert.equal(after.daily.slots.length, 0);
});

test('commands never repeat within a full cycle, including after reload', () => {
  let p = {};
  let previous;
  for (let cycle = 0; cycle < 3; cycle++) {
    const seen = new Set();
    for (let i = 0; i < Linux.commands.length; i++) {
      const lesson = Linux.nextCommand(p);
      assert.ok(!seen.has(lesson.command.id));
      assert.notEqual(lesson.command.id, previous);
      assert.equal(lesson.progress, i + 1);
      seen.add(lesson.command.id);
      previous = lesson.command.id;
      p = JSON.parse(JSON.stringify(p));
    }
  }
});

test('migration retains existing work data and persists schedule/history/settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktracker-test-'));
  try {
    const original = { deviceId: 'old-device', trackingStart: '2026-01-01', entries: { '2026-10-13': { category: 'home', note: 'Keep me' } }, prompts: { '2026-10-13': { note: 'done' } }, settings: { state: 'BE', openAtLogin: false } };
    fs.writeFileSync(path.join(dir, 'worktracker-data.json'), JSON.stringify(original));
    const store = new Store(dir);
    assert.deepEqual(store.data.entries, original.entries);
    assert.deepEqual(store.data.prompts, original.prompts);
    assert.equal(store.settings.linuxPracticeCount, 4);
    store.practiceDue(date('09:00'), false);
    const first = store.nextPracticeCommand();
    const reloaded = new Store(dir);
    assert.deepEqual(reloaded.data.linuxPractice, store.data.linuxPractice);
    assert.notEqual(reloaded.nextPracticeCommand().command.id, first.command.id);
    const old = JSON.stringify(reloaded.data);
    assert.throws(() => reloaded.updateSettings({ linuxPracticeCount: 0, trackingStart: '2000-01-01' }));
    assert.equal(JSON.stringify(reloaded.data), old);
    reloaded.updateSettings({ linuxPracticeCount: 8 });
    assert.equal(new Store(dir).settings.linuxPracticeCount, 8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid settings are rejected', () => {
  for (const patch of [{ linuxPracticeCount: 0 }, { linuxPracticeCount: 25 }, { linuxPracticeCount: 1.5 }, { linuxPracticeStart: '25:00' }, { linuxPracticeEnd: '09:00' }, { linuxPracticeEnd: '10:00' }, { linuxPracticeEnd: '10:02' }, { linuxPracticeEnabled: 'yes' }]) {
    assert.throws(() => Linux.validateSettings({ ...settings, ...patch }));
  }
  Linux.validateSettings(settings);
});
