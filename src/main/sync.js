// Two-way sync with Supabase. Entries: last write wins per day (server enforces it in
// upsert_entries). Settings: last write wins for the whole synced subset.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const WTConfig = require('../shared/config');

const PULL_OVERLAP_MS = 60 * 1000; // re-read a minute back so concurrent writes are never skipped
const BATCH = 500;

function fileStorage(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (obj) => fs.writeFileSync(file, JSON.stringify(obj));
  return {
    getItem: (k) => read()[k] ?? null,
    setItem: (k, v) => { const o = read(); o[k] = v; write(o); },
    removeItem: (k) => { const o = read(); delete o[k]; write(o); },
  };
}

class Sync {
  constructor(store, { onRemoteChange }) {
    this.store = store;
    this.onRemoteChange = onRemoteChange;
    this.running = null;
    this.lastError = null;
    this.client = createClient(WTConfig.SUPABASE_URL, WTConfig.SUPABASE_KEY, {
      auth: { storage: fileStorage(path.join(store.dir, 'auth-session.json')), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }

  get state() {
    if (!this.store.data.sync) this.store.data.sync = { cursor: null, pushedAt: null };
    return this.store.data.sync;
  }

  async status() {
    const { data } = await this.client.auth.getSession();
    return { signedIn: !!data.session, email: data.session?.user.email || null, lastSyncAt: this.state.lastSyncAt || null, error: this.lastError, webAppUrl: WTConfig.WEB_APP_URL };
  }

  async signIn(email, password) {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    // A new account on this PC: upload everything once.
    this.store.data.sync = { cursor: null, pushedAt: null };
    return this.run();
  }

  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password, options: { emailRedirectTo: WTConfig.WEB_APP_URL } });
    if (error) throw new Error(error.message);
    if (!data.session) return { needsConfirmation: true };
    this.store.data.sync = { cursor: null, pushedAt: null };
    await this.run();
    return { needsConfirmation: false };
  }

  async signOut() {
    await this.client.auth.signOut();
    this.store.data.sync = { cursor: null, pushedAt: null };
    this.store.save();
  }

  /** One full sync cycle. Concurrent callers share the running cycle. */
  run() {
    if (!this.running) this.running = this._run().finally(() => { this.running = null; });
    return this.running;
  }

  async _run() {
    const { data } = await this.client.auth.getSession();
    if (!data.session) return { changed: false };
    try {
      const changed = (await this._pull()) | (await this._syncSettings());
      await this._push();
      this.state.lastSyncAt = new Date().toISOString();
      this.lastError = null;
      this.store.save();
      if (changed) this.onRemoteChange();
      return { changed: !!changed };
    } catch (e) {
      this.lastError = e.message || String(e);
      throw e;
    }
  }

  async _pull() {
    const since = this.state.cursor ? new Date(Date.parse(this.state.cursor) - PULL_OVERLAP_MS).toISOString() : '1970-01-01T00:00:00Z';
    let changed = false;
    for (;;) {
      const { data: rows, error } = await this.client.from('entries')
        .select('date, category, note, deleted, updated_at, device_id, synced_at')
        .gt('synced_at', since).order('synced_at').range(0, 999);
      if (error) throw new Error(error.message);
      changed = this.store.mergeRemote(rows) || changed;
      if (rows.length) this.state.cursor = rows[rows.length - 1].synced_at;
      if (rows.length < 1000) break;
      if (rows[rows.length - 1].synced_at === since) break;
    }
    return changed;
  }

  async _push() {
    const since = this.state.pushedAt ? Date.parse(this.state.pushedAt) : 0;
    const local = Object.values(this.store.data.entries).filter((e) => Date.parse(e.updatedAt) > since);
    if (!local.length) return;
    for (let i = 0; i < local.length; i += BATCH) {
      const rows = local.slice(i, i + BATCH).map((e) => ({
        date: e.date, category: e.deleted ? null : e.category, note: e.deleted ? '' : e.note || '',
        deleted: !!e.deleted, updated_at: e.updatedAt, device_id: e.deviceId,
      }));
      const { error } = await this.client.rpc('upsert_entries', { rows });
      if (error) throw new Error(error.message);
    }
    this.state.pushedAt = local.reduce((m, e) => (e.updatedAt > m ? e.updatedAt : m), this.state.pushedAt || '');
  }

  async _syncSettings() {
    const { data: remote, error } = await this.client.from('user_settings').select('settings, updated_at').maybeSingle();
    if (error) throw new Error(error.message);
    const localAt = this.store.data.settingsUpdatedAt || '1970-01-01T00:00:00Z';
    if (remote && Date.parse(remote.updated_at) > Date.parse(localAt)) {
      return this.store.applyRemoteSettings(remote.settings, remote.updated_at);
    }
    if (!remote || Date.parse(localAt) > Date.parse(remote.updated_at)) {
      const subset = Object.fromEntries(WTConfig.SYNCED_SETTINGS.map((k) => [k, this.store.settings[k]]));
      subset.trackingStart = this.store.data.trackingStart;
      const { error: upErr } = await this.client.from('user_settings').upsert({
        settings: subset,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
        updated_at: remote ? localAt : new Date().toISOString(),
      });
      if (upErr) throw new Error(upErr.message);
    }
    return false;
  }
}

module.exports = { Sync };
