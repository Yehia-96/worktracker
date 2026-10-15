// Local-first JSON store.
// Sync-ready by design: every entry carries updatedAt + deviceId, and deletions are kept as
// tombstones, so a future account/cloud sync can merge devices with "last write wins" per day.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WT = require('../shared/core');
const Linux = require('../shared/linux-practice');
const WTConfig = require('../shared/config');

const SCHEMA_VERSION = 1;
const BACKUPS_KEPT = 14;

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'worktracker-data.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
    this._dailyBackup();
    this.save();
  }

  _load() {
    let raw = null;
    if (fs.existsSync(this.file)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        // Never silently overwrite a file we couldn't read — keep it aside for recovery.
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      deviceId: raw?.deviceId || crypto.randomUUID(),
      trackingStart: raw?.trackingStart || WT.todayKey(),
      settings: { ...WT.DEFAULT_SETTINGS, ...(raw?.settings || {}) },
      entries: raw?.entries || {},
      prompts: raw?.prompts || {}, // { "YYYY-MM-DD": { note: "done" | "skipped" } }
      linuxPractice: raw?.linuxPractice || { seen: [], lastId: null, daily: null },
      settingsUpdatedAt: raw?.settingsUpdatedAt || null,
      sync: raw?.sync || { cursor: null, pushedAt: null },
    };
  }

  _dailyBackup() {
    if (!fs.existsSync(this.file)) return;
    const backupDir = path.join(this.dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const target = path.join(backupDir, `worktracker-data-${WT.todayKey()}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
    const old = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort().slice(0, -BACKUPS_KEPT);
    for (const f of old) fs.unlinkSync(path.join(backupDir, f));
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    // Windows scanners can briefly hold the destination open between quick saves.
    // Retry the atomic replacement; never remove the last good data file.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, this.file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** attempt);
      }
    }
  }

  get settings() {
    return this.data.settings;
  }

  getEntry(date) {
    const e = this.data.entries[date];
    return e && !e.deleted ? e : null;
  }

  _put(date, patch) {
    const prev = this.getEntry(date) || {};
    const next = { category: prev.category ?? null, note: prev.note ?? '', ...patch };
    this.data.entries[date] = next.category || next.note
      ? { date, category: next.category, note: next.note, deleted: false, updatedAt: new Date().toISOString(), deviceId: this.data.deviceId }
      : { date, deleted: true, updatedAt: new Date().toISOString(), deviceId: this.data.deviceId };
    return this.getEntry(date);
  }

  setEntry(date, patch) {
    const e = this._put(date, patch);
    this.save();
    return e;
  }

  clearEntry(date) {
    this._put(date, { category: null, note: '' });
    this.save();
  }

  /** Apply a category to every working day in [from, to]. Returns the number of days changed. */
  setRange(from, to, category, overwrite) {
    let changed = 0;
    for (let d = WT.fromKey(from); WT.toKey(d) <= to; d = WT.addDays(d, 1)) {
      const key = WT.toKey(d);
      if (!WT.isWorkingDay(key, this.settings)) continue;
      if (!overwrite && this.getEntry(key)?.category) continue;
      this._put(key, { category });
      changed++;
    }
    this.save();
    return changed;
  }

  entriesForYear(year) {
    const out = {};
    const prefix = `${year}-`;
    for (const [key, e] of Object.entries(this.data.entries)) {
      if (key.startsWith(prefix) && !e.deleted) out[key] = { category: e.category, note: e.note };
    }
    return out;
  }

  markPrompt(date, kind, value) {
    this.data.prompts[date] = { ...(this.data.prompts[date] || {}), [kind]: value };
    this.save();
  }

  updateSettings(patch) {
    const { trackingStart, ...rest } = patch;
    const settings = { ...this.data.settings, ...rest };
    Linux.validateSettings(settings);
    if (trackingStart) this.data.trackingStart = trackingStart;
    this.data.settings = settings;
    this.data.settingsUpdatedAt = new Date().toISOString();
    this.save();
    return this.data.settings;
  }

  /** Merge entries pulled from the cloud; newer wins. Returns true if anything changed. */
  mergeRemote(rows) {
    let changed = false;
    for (const r of rows) {
      const updatedAt = new Date(r.updated_at).toISOString();
      const local = this.data.entries[r.date];
      if (local && Date.parse(local.updatedAt) >= Date.parse(updatedAt)) continue;
      this.data.entries[r.date] = r.deleted
        ? { date: r.date, deleted: true, updatedAt, deviceId: r.device_id }
        : { date: r.date, category: r.category, note: r.note || '', deleted: false, updatedAt, deviceId: r.device_id };
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  /** Apply settings edited on another device (only the synced subset). */
  applyRemoteSettings(remote, updatedAt) {
    const { trackingStart, ...rest } = remote || {};
    const allowed = Object.fromEntries(Object.entries(rest).filter(([k]) => WTConfig.SYNCED_SETTINGS.includes(k)));
    const next = { ...this.data.settings, ...allowed };
    try { Linux.validateSettings(next); } catch { return false; }
    this.data.settings = next;
    if (trackingStart) this.data.trackingStart = trackingStart;
    this.data.settingsUpdatedAt = new Date(updatedAt).toISOString();
    this.save();
    return true;
  }

  practiceDue(now, busy) {
    const result = Linux.advance(this.data.linuxPractice, this.settings, now, {
      busy, category: this.getEntry(WT.toKey(now))?.category,
    });
    if (result.changed) this.save();
    return result.show;
  }

  nextPracticeCommand() {
    const lesson = Linux.nextCommand(this.data.linuxPractice);
    this.save();
    return lesson;
  }
}

module.exports = { Store };
