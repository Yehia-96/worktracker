// Exercise the real main-process scheduler and IPC with a simulated Electron host.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const WT = require('../src/shared/core');
const Linux = require('../src/shared/linux-practice');

function harness() {
  let now = new Date('2026-10-13T09:00:00').getTime();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const handlers = {};
  const windows = [];
  let copied = null;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = { send() {} }; windows.push(this); }
    setAlwaysOnTop() {} loadFile() {} showInactive() {} setBounds(bounds) { this.bounds = bounds; }
    close() { this.emit('closed'); } destroy() { this.close(); }
  }
  class TestStore {
    constructor() {
      this.settings = { ...WT.DEFAULT_SETTINGS, openAtLogin: false };
      this.data = { settings: this.settings, trackingStart: '2026-10-13', entries: { '2026-10-13': { category: 'home' } }, prompts: {}, linuxPractice: {} };
    }
    getEntry(day) { return this.data.entries[day]; }
    practiceDue(date, busy) { return Linux.advance(this.data.linuxPractice, this.settings, date, { busy, category: this.getEntry(WT.toKey(date))?.category }).show; }
    nextPracticeCommand() { return Linux.nextCommand(this.data.linuxPractice); }
    updateSettings(patch) { Object.assign(this.settings, patch); return this.settings; }
  }
  const powerMonitor = new EventEmitter();
  const electron = {
    app: Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true, setAppUserModelId() {}, whenReady: () => ({ then() {} }), getPath: () => '', setLoginItemSettings() {}, getAppPath: () => '', getVersion: () => '1.1.0' }),
    BrowserWindow: Window,
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate: x => x },
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    nativeImage: { createFromPath() {} }, nativeTheme: new EventEmitter(), powerMonitor,
    clipboard: { writeText: text => { copied = text; } },
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './store' ? { Store: TestStore } : name === '../shared/core' ? WT : name === './report' ? {} : require(name),
    __dirname: path.resolve(__dirname, '../src/main'), process: { argv: ['--hidden'], execPath: '' },
    Date: Clock, setInterval() {}, setTimeout() {}, console,
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8'), context);
  context.start();
  const get = expression => vm.runInContext(expression, context);
  return {
    context, get, windows, powerMonitor,
    setTime: time => { now = new Date(`2026-10-13T${time}:00`).getTime(); },
    call: (channel, ...args) => handlers[channel]({}, ...args),
    get copied() { return copied; },
    dueAt(time) { get('store').data.linuxPractice.daily.slots = [new Date(`2026-10-13T${time}:00`).getTime()]; },
  };
}

test('scheduled practice, Next, Copy, Got it and restart state are wired through main IPC', async () => {
  const h = harness();
  h.dueAt('11:00'); h.setTime('11:00'); h.context.tick();
  const lesson = h.call('popup:get');
  assert.equal(lesson.mode, 'linux');
  assert.equal(await h.call('practice:copy', 0), true);
  assert.equal(h.copied, lesson.command.examples[0]);
  assert.equal(await h.call('practice:copy', -1), false);
  const next = h.call('practice:next');
  assert.notEqual(next.command.id, lesson.command.id);
  assert.equal(h.get('store').data.linuxPractice.daily.used, 1);
  assert.equal(h.get('store').data.linuxPractice.seen.length, 2);
  h.call('popup:close');
  assert.equal(h.call('popup:get'), null);
  h.context.tick();
  assert.equal(h.call('popup:get'), null);
});

test('check-in and note conflicts consume practice without consuming a command', () => {
  for (const mode of ['checkin', 'note']) {
    const h = harness();
    h.call('popup:test', mode);
    h.dueAt('11:00'); h.setTime('11:00'); h.context.tick();
    assert.equal(h.call('popup:get').mode, mode);
    assert.equal(h.get('store').data.linuxPractice.daily.used, 1);
    assert.equal(h.get('store').data.linuxPractice.seen, undefined);
    assert.equal(h.call('popup:test', 'linux'), false);
    h.call('popup:close'); h.context.tick();
    assert.equal(h.call('popup:get'), null);
  }
});

test('newly due work reminders preempt practice, and same-tick check-in wins', () => {
  const h = harness();
  h.call('popup:test', 'linux');
  h.setTime('16:00'); h.context.tick();
  assert.equal(h.call('popup:get').mode, 'note');
  const second = harness();
  delete second.get('store').data.entries['2026-10-13'];
  second.dueAt('10:00'); second.setTime('10:00'); second.context.tick();
  assert.equal(second.call('popup:get').mode, 'checkin');
  assert.equal(second.get('store').data.linuxPractice.daily.used, 1);
});

test('turning practice off closes its card without affecting work reminders', () => {
  const h = harness();
  h.call('popup:test', 'linux');
  h.call('settings:save', { linuxPracticeEnabled: false });
  assert.equal(h.call('popup:get'), null);
  h.call('popup:test', 'note');
  h.call('settings:save', { linuxPracticeEnabled: false });
  assert.equal(h.call('popup:get').mode, 'note');
});

test('locked sessions and resume skip practice slots without a catch-up popup', () => {
  const h = harness();
  h.dueAt('11:00'); h.setTime('11:00');
  h.powerMonitor.emit('lock-screen'); h.context.tick();
  assert.equal(h.call('popup:get'), null);
  h.powerMonitor.emit('unlock-screen'); h.context.tick();
  assert.equal(h.call('popup:get'), null);
  h.dueAt('12:00'); h.powerMonitor.emit('suspend'); h.setTime('12:00');
  h.powerMonitor.emit('resume'); h.context.tick();
  assert.equal(h.call('popup:get'), null);
});
