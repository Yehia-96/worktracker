// Two devices syncing through an in-memory stand-in for Supabase (same last-write-wins rules
// as public.upsert_entries), using the real Store and Sync code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/store');
const { Sync } = require('../src/main/sync');

function fakeServer() {
  const rows = new Map();
  let settings = null;
  let tick = Date.parse('2026-10-15T10:00:00Z');
  const stamp = () => new Date(tick += 1000).toISOString();
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { email: 'me@example.com' } } } }) },
    rpc: async (name, { rows: incoming }) => {
      for (const r of incoming) {
        const cur = rows.get(r.date);
        if (!cur || Date.parse(cur.updated_at) < Date.parse(r.updated_at)) rows.set(r.date, { ...r, synced_at: stamp() });
      }
      return { error: null };
    },
    from(table) {
      if (table === 'user_settings') {
        return {
          select: () => ({ maybeSingle: async () => ({ data: settings, error: null }) }),
          upsert: async (row) => { settings = { settings: row.settings, updated_at: row.updated_at }; return { error: null }; },
        };
      }
      const q = { since: '' };
      const builder = {
        select: () => builder,
        gt: (_col, v) => { q.since = v; return builder; },
        order: () => builder,
        range: async (from, to) => ({
          error: null,
          data: [...rows.values()].filter((r) => r.synced_at > q.since).sort((a, b) => a.synced_at.localeCompare(b.synced_at)).slice(from, to + 1),
        }),
      };
      return builder;
    },
  };
  return { client, rows, get settings() { return settings; } };
}

const device = (server) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sync-'));
  const store = new Store(dir);
  return { store, sync: new Sync(store, { client: server.client, onRemoteChange() {} }) };
};

test('entries and notes reach the other device; newer edits win; deletes propagate', async () => {
  const server = fakeServer();
  const pc = device(server), phone = device(server);

  pc.store.setEntry('2026-10-13', { category: 'home', note: 'Finalized the Pointcept model' });
  pc.store.setEntry('2026-10-14', { category: 'office' });
  await pc.sync.run();
  await phone.sync.run();
  assert.equal(phone.store.getEntry('2026-10-13').note, 'Finalized the Pointcept model');
  assert.equal(phone.store.getEntry('2026-10-14').category, 'office');

  await new Promise((r) => setTimeout(r, 5));
  phone.store.setEntry('2026-10-14', { category: 'trip', note: 'Munich' });
  await phone.sync.run();
  await pc.sync.run();
  assert.deepEqual([pc.store.getEntry('2026-10-14').category, pc.store.getEntry('2026-10-14').note], ['trip', 'Munich']);

  // An older offline edit must not overwrite the newer one.
  pc.store.data.entries['2026-10-14'] = { ...pc.store.data.entries['2026-10-14'], category: 'home', updatedAt: '2026-10-01T00:00:00.000Z' };
  pc.store.data.sync.pushedAt = '2026-09-01T00:00:00.000Z';
  await pc.sync.run();
  assert.equal(server.rows.get('2026-10-14').category, 'trip');

  await new Promise((r) => setTimeout(r, 5));
  pc.store.clearEntry('2026-10-13');
  await pc.sync.run();
  await phone.sync.run();
  assert.equal(phone.store.getEntry('2026-10-13'), null);
});

test('settings changed on one device apply on the other, device-only ones stay local', async () => {
  const server = fakeServer();
  const pc = device(server), phone = device(server);
  pc.store.updateSettings({ noteTime: '16:30', openAtLogin: false });
  await pc.sync.run();
  assert.equal(server.settings.settings.noteTime, '16:30');
  assert.equal(server.settings.settings.openAtLogin, undefined);
  await phone.sync.run();
  assert.equal(phone.store.settings.noteTime, '16:30');
  assert.equal(phone.store.settings.openAtLogin, true);
});
