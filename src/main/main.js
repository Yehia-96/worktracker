const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, nativeTheme, powerMonitor, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const WT = require('../shared/core');
const { Store } = require('./store');
const { Sync } = require('./sync');
const { buildCsv, buildReportHtml } = require('./report');

const APP_ID = 'com.yehia.worktracker';
const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, 'preload.js');
const SNOOZE_MS = 30 * 60 * 1000;
const CATCHUP_DAYS = 60; // older gaps are left to the calendar view instead of nagging
const TICK_MS = 20 * 1000;
const SYNC_EVERY_MS = 2 * 60 * 1000;
const SYNC_FRESH_MS = 90 * 1000; // pull before showing a reminder if older than this

let store, sync, tray, mainWin, popupWin;
let signedIn = false;
let syncTimer = null;
let popupPayload = null;
let popupHandled = false;
let sessionLocked = false;
let sessionSuspended = false;
const snoozeUntil = { checkin: 0, note: 0 };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.setAppUserModelId(APP_ID);
  app.whenReady().then(start);
}

function start() {
  store = new Store(app.getPath('userData'));
  sync = new Sync(store, { onRemoteChange: () => { dataChanged(true); closeAnsweredPopup(); } });
  sync.status().then((st) => { signedIn = st.signedIn; runSync(); });
  setInterval(runSync, SYNC_EVERY_MS);
  Menu.setApplicationMenu(null);
  registerIpc();
  createTray();
  applyLoginItem(store.settings.openAtLogin);
  if (!process.argv.includes('--hidden')) showMain();

  tick();
  setInterval(tick, TICK_MS);
  const resume = () => {
    // Consume slots crossed while away, even when resuming within their minute.
    store.practiceDue(new Date(), true);
    runSync();
    setTimeout(tick, 5000);
  };
  powerMonitor.on('suspend', () => { sessionSuspended = true; });
  powerMonitor.on('lock-screen', () => { sessionLocked = true; });
  powerMonitor.on('resume', () => { sessionSuspended = false; resume(); });
  powerMonitor.on('unlock-screen', () => { sessionLocked = false; resume(); });
}

// Stay alive in the tray when windows close.
app.on('window-all-closed', () => {});

// ---------- Scheduling ----------

function pendingCheckins(now = new Date()) {
  const s = store.settings;
  const today = WT.toKey(now);
  const includeToday = WT.minutesOfDay(now) >= WT.parseTime(s.checkinTime);
  const earliest = WT.toKey(WT.addDays(now, -CATCHUP_DAYS));
  const startKey = store.data.trackingStart > earliest ? store.data.trackingStart : earliest;
  const out = [];
  for (let d = WT.fromKey(startKey); ; d = WT.addDays(d, 1)) {
    const key = WT.toKey(d);
    if (key > today || (key === today && !includeToday)) break;
    if (WT.isWorkingDay(key, s) && !store.getEntry(key)?.category) out.push(key);
  }
  return out;
}

function noteDue(now = new Date()) {
  const s = store.settings;
  const today = WT.toKey(now);
  if (!WT.isWorkingDay(today, s)) return false;
  if (WT.minutesOfDay(now) < WT.parseTime(s.noteTime)) return false;
  if (store.data.prompts[today]?.note) return false;
  const e = store.getEntry(today);
  if (e?.note) return false;
  return !['vacation', 'sick'].includes(e?.category);
}

function tick() {
  if (!store) return;
  const date = new Date();
  const now = date.getTime();
  const pending = pendingCheckins(date);
  const checkin = pending.length && now >= snoozeUntil.checkin;
  const note = noteDue(date) && now >= snoozeUntil.note;
  const sessionUnavailable = sessionLocked || sessionSuspended;
  const practice = store.practiceDue(date, !!popupWin || !!checkin || !!note || sessionUnavailable);
  if (sessionUnavailable) return;
  // A work reminder takes precedence even if a practice card is already open.
  if (popupPayload?.mode === 'linux' && (checkin || note)) closePopup();
  if (popupWin) return;
  // Answered on the iPhone? Pull first so we don't ask again.
  const stale = !store.data.sync?.lastSyncAt || now - Date.parse(store.data.sync.lastSyncAt) > SYNC_FRESH_MS;
  if ((checkin || note) && signedIn && stale && !sync.lastError) return void runSync();
  if (checkin) return openCheckinPopup(pending);
  if (note) return openNotePopup();
  if (practice) openPracticePopup();
}

function openPracticePopup() {
  if (popupWin) return false;
  openPopup({ mode: 'linux', ...store.nextPracticeCommand() });
  return true;
}

function openCheckinPopup(dates) {
  const today = WT.todayKey();
  openPopup({ mode: 'checkin', queue: dates.map((date) => ({ date, isToday: date === today, current: store.getEntry(date)?.category || null })) });
}

function openNotePopup(date = WT.todayKey()) {
  openPopup({ mode: 'note', date, entry: store.getEntry(date) });
}

// ---------- Popup ("notification") window ----------

const POPUP_W = 420;

function openPopup(payload) {
  if (popupWin) popupWin.destroy();
  popupPayload = payload;
  popupHandled = false;
  const { workArea } = screen.getPrimaryDisplay();
  const h = 320;
  popupWin = new BrowserWindow({
    width: POPUP_W, height: h,
    x: workArea.x + workArea.width - POPUP_W, y: workArea.y + workArea.height - h,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  popupWin.setAlwaysOnTop(true, 'pop-up-menu');
  popupWin.loadFile(path.join(ROOT, 'renderer', 'popup.html'));
  popupWin.once('ready-to-show', () => popupWin?.showInactive());
  popupWin.on('closed', () => {
    // Closed without an answer (e.g. Alt+F4) → treat as "later".
    if (!popupHandled && popupPayload && popupPayload.mode !== 'linux') snoozeUntil[popupPayload.mode] = Date.now() + SNOOZE_MS;
    popupWin = null;
    popupPayload = null;
  });
}

function closePopup() {
  popupHandled = true;
  popupWin?.close();
}

function resizePopup(contentHeight) {
  if (!popupWin) return;
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.min(Math.ceil(contentHeight), workArea.height);
  popupWin.setBounds({ x: workArea.x + workArea.width - POPUP_W, y: workArea.y + workArea.height - h, width: POPUP_W, height: h });
}

// ---------- Main window ----------

function overlayColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#0E1117', symbolColor: '#E8ECF3', height: 44 }
    : { color: '#F6F7FB', symbolColor: '#141824', height: 44 };
}

function showMain(view) {
  if (!mainWin) {
    mainWin = new BrowserWindow({
      width: 1120, height: 780, minWidth: 880, minHeight: 620,
      show: false,
      backgroundColor: overlayColors().color,
      titleBarStyle: 'hidden',
      titleBarOverlay: overlayColors(),
      icon: path.join(ROOT, 'assets', 'icon.png'),
      webPreferences: { preload: PRELOAD, contextIsolation: true },
    });
    mainWin.loadFile(path.join(ROOT, 'renderer', 'index.html'));
    mainWin.once('ready-to-show', () => {
      mainWin.show();
      if (view) mainWin.webContents.send('navigate', view);
    });
    mainWin.on('close', (e) => {
      if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
    });
    mainWin.on('closed', () => { mainWin = null; });
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  if (view) mainWin.webContents.send('navigate', view);
}

nativeTheme.on('updated', () => {
  if (mainWin) mainWin.setTitleBarOverlay(overlayColors());
});

function dataChanged(fromRemote = false) {
  mainWin?.webContents.send('data:changed');
  updateTray();
  if (!fromRemote && signedIn) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, 1500);
  }
}

function runSync() {
  if (!signedIn) return Promise.resolve();
  return sync.run().catch((e) => console.error('sync failed:', e.message)).finally(() => mainWin?.webContents.send('sync:changed'));
}

// Close a reminder that was meanwhile answered on another device.
function closeAnsweredPopup() {
  if (popupPayload?.mode === 'checkin' && popupPayload.queue.every((q) => store.getEntry(q.date)?.category)) closePopup();
  if (popupPayload?.mode === 'note' && store.getEntry(popupPayload.date)?.note) closePopup();
}

// ---------- Tray ----------

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png')));
  tray.on('click', () => showMain());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const today = store.getEntry(WT.todayKey());
  const label = today?.category ? WT.CATEGORY_MAP[today.category].label : 'not recorded';
  tray.setToolTip(`Work Tracker — today: ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Today: ${label}`, enabled: false },
    { type: 'separator' },
    { label: 'Check in now…', click: () => openCheckinPopup(pendingCheckins().length ? pendingCheckins() : [WT.todayKey()]) },
    { label: "Write today's note…", click: () => openNotePopup() },
    { type: 'separator' },
    { label: 'Open Work Tracker', click: () => showMain('today') },
    { label: 'Calendar', click: () => showMain('calendar') },
    { label: 'Year summary', click: () => showMain('summary') },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function applyLoginItem(enabled) {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
  else app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [app.getAppPath(), '--hidden'] });
}

// ---------- Exports ----------

async function askSavePath(defaultName, filters) {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters,
  });
  return canceled ? null : filePath;
}

async function exportCsv(year) {
  const file = await askSavePath(`WorkTracker-${year}.csv`, [{ name: 'CSV', extensions: ['csv'] }]);
  if (!file) return null;
  fs.writeFileSync(file, buildCsv(year, store.entriesForYear(year), store.settings), 'utf8');
  shell.showItemInFolder(file);
  return file;
}

async function exportPdf(year) {
  const file = await askSavePath(`WorkTracker-${year}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }]);
  if (!file) return null;
  const tmp = path.join(app.getPath('temp'), `worktracker-report-${year}.html`);
  fs.writeFileSync(tmp, buildReportHtml(year, store.entriesForYear(year), store.settings), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4', printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    fs.writeFileSync(file, pdf);
  } finally {
    win.destroy();
    fs.rmSync(tmp, { force: true });
  }
  shell.showItemInFolder(file);
  return file;
}

// ---------- IPC ----------

function registerIpc() {
  const on = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

  on('app:bootstrap', () => ({ version: app.getVersion(), settings: store.settings, trackingStart: store.data.trackingStart }));
  on('year:get', (year) => ({ entries: store.entriesForYear(year), settings: store.settings, trackingStart: store.data.trackingStart }));

  on('entry:set', (date, patch) => { const e = store.setEntry(date, patch); dataChanged(); return e; });
  on('entry:clear', (date) => { store.clearEntry(date); dataChanged(); });
  on('range:set', (from, to, category, overwrite) => { const n = store.setRange(from, to, category, overwrite); dataChanged(); return n; });

  on('settings:save', (patch) => {
    const before = store.settings.openAtLogin;
    const s = store.updateSettings(patch);
    if (s.openAtLogin !== before) applyLoginItem(s.openAtLogin);
    if (!s.linuxPracticeEnabled && popupPayload?.mode === 'linux') closePopup();
    tick();
    dataChanged();
    return { settings: s, trackingStart: store.data.trackingStart };
  });

  const afterAuth = async (fn) => {
    const result = await fn();
    signedIn = (await sync.status()).signedIn;
    dataChanged(true);
    return result;
  };
  on('sync:status', () => sync.status());
  on('sync:signIn', (email, password) => afterAuth(() => sync.signIn(email, password)));
  on('sync:signUp', (email, password) => afterAuth(() => sync.signUp(email, password)));
  on('sync:signOut', () => afterAuth(() => sync.signOut()));
  on('sync:now', () => runSync().then(() => sync.status()));

  on('export:csv', exportCsv);
  on('export:pdf', exportPdf);
  on('data:openFolder', () => shell.openPath(store.dir));
  on('main:open', (view) => showMain(view));

  on('popup:test', (mode) => {
    if (mode === 'linux') return openPracticePopup();
    mode === 'note' ? openNotePopup() : openCheckinPopup([WT.todayKey()]);
    return true;
  });
  on('practice:next', () => {
    if (popupPayload?.mode !== 'linux') return null;
    popupPayload = { mode: 'linux', ...store.nextPracticeCommand() };
    return popupPayload;
  });
  on('practice:copy', async (index = 0) => {
    if (popupPayload?.mode !== 'linux' || !Number.isInteger(index)) return false;
    const example = popupPayload.command.examples[index];
    if (!example) return false;
    try { await clipboard.writeText(example); return true; }
    catch { return false; }
  });
  on('popup:get', () => popupPayload);
  on('popup:choose', (date, category) => { store.setEntry(date, { category }); dataChanged(); });
  on('popup:note', (date, note, category) => {
    store.setEntry(date, category ? { note, category } : { note });
    store.markPrompt(date, 'note', 'done');
    dataChanged();
  });
  on('popup:skipNote', (date) => { store.markPrompt(date, 'note', 'skipped'); closePopup(); });
  on('popup:snooze', () => { if (popupPayload && popupPayload.mode !== 'linux') snoozeUntil[popupPayload.mode] = Date.now() + SNOOZE_MS; closePopup(); });
  on('popup:close', () => closePopup());
  on('popup:resize', (h) => resizePopup(h));
}
