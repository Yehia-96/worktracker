// Reminder service: called every 5 minutes by pg_cron. Sends due iPhone notifications
// (10:00 check-in, 16:00 note, optional Linux cards) once per day each, skipping anything
// already answered on any device. Safe to call any number of times: push_log de-duplicates.
import postgres from 'npm:postgres@3.4.5';
import '../_shared/core.js';
import '../_shared/config.js';
import commands from '../_shared/linux-commands.json' with { type: 'json' };
import { sendWebPush } from '../_shared/webpush.js';

// deno-lint-ignore no-explicit-any
const { WT, WTConfig } = globalThis as any;
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1 });
const vapid = {
  publicKey: WTConfig.VAPID_PUBLIC_KEY,
  privateJwk: JSON.parse(Deno.env.get('VAPID_PRIVATE_JWK') ?? '{}'),
  subject: WTConfig.WEB_APP_URL,
};
const APP = WTConfig.WEB_APP_URL;
const DELAY = WTConfig.PHONE_DELAY_MIN;

function localNow(tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

// Deterministic per user and day, so every run agrees on the same random practice times.
function seeded(seedText: string) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function practiceSlots(userId: string, date: string, s: Record<string, unknown>) {
  const start = WT.parseTime(s.linuxPracticeStart), end = WT.parseTime(s.linuxPracticeEnd);
  const count = Math.max(0, Math.min(Number(s.linuxPracticeCount) || 0, end - start));
  const rand = seeded(`${userId}:${date}`);
  return Array.from({ length: count }, (_, i) => {
    const low = Math.floor((i * (end - start)) / count), high = Math.floor(((i + 1) * (end - start)) / count);
    return start + low + Math.floor(rand() * (high - low));
  });
}

type Due = { kind: string; payload: Record<string, string>; commandId?: string };

async function dueFor(userId: string, settings: Record<string, unknown>, tz: string): Promise<{ date: string; due: Due[] }> {
  const s = { ...WT.DEFAULT_SETTINGS, ...settings };
  const { date, minutes } = localNow(tz);
  if (!WT.isWorkingDay(date, s)) return { date, due: [] };

  const [entry] = await sql`select category, note from entries where user_id = ${userId} and date = ${date} and not deleted`;
  const sent = new Set((await sql`select kind from push_log where user_id = ${userId} and date = ${date}`).map((r) => r.kind));
  const category = entry?.category ?? null;
  const away = category === 'vacation' || category === 'sick';
  const checkin = WT.parseTime(s.checkinTime), note = WT.parseTime(s.noteTime);
  const due: Due[] = [];

  if (!category && !sent.has('checkin') && minutes >= checkin + DELAY && minutes < note + 120) {
    due.push({ kind: 'checkin', payload: { title: 'Where are you working today?', body: 'Office · Home office · Dienstreise · Urlaub · Krank — tap to choose', url: `${APP}?open=checkin`, tag: `checkin-${date}` } });
  }
  if (!entry?.note && !away && !sent.has('note') && minutes >= note + DELAY && minutes < 22 * 60) {
    due.push({ kind: 'note', payload: { title: 'Anything to note about today?', body: 'Tap to add a few words for your log.', url: `${APP}?open=note`, tag: `note-${date}` } });
  }
  if (s.phoneLinuxPractice && !away) {
    const slots = practiceSlots(userId, date, s);
    const i = slots.findIndex((slot, n) => minutes >= slot && minutes - slot < 30 && !sent.has(`linux-${n}`));
    if (i >= 0) {
      const recent = new Set((await sql`select command_id from push_log where user_id = ${userId} and kind like 'linux-%'
        order by sent_at desc limit ${commands.length - 1}`).map((r) => r.command_id));
      const pool = commands.filter((c: { id: string }) => !recent.has(c.id));
      const cmd = pool[Math.floor(Math.random() * pool.length)] ?? commands[0];
      due.push({ kind: `linux-${i}`, commandId: cmd.id, payload: { title: `Linux practice: ${cmd.name}`, body: cmd.description, url: `${APP}?practice=${encodeURIComponent(cmd.id)}`, tag: `linux-${date}-${i}` } });
    }
  }
  return { date, due };
}

Deno.serve(async () => {
  const subs = await sql`select s.id, s.user_id, s.endpoint, s.p256dh, s.auth, u.settings, coalesce(u.timezone, 'Europe/Berlin') as timezone
    from push_subscriptions s left join user_settings u on u.user_id = s.user_id`;
  const byUser = new Map<string, typeof subs>();
  for (const s of subs) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);

  let sent = 0, failed = 0;
  for (const [userId, devices] of byUser) {
    const { date, due } = await dueFor(userId, devices[0].settings ?? {}, devices[0].timezone);
    for (const d of due) {
      // Claim the reminder first so overlapping runs never send it twice.
      const claimed = await sql`insert into push_log (user_id, date, kind, command_id) values (${userId}, ${date}, ${d.kind}, ${d.commandId ?? null})
        on conflict do nothing returning kind`;
      if (!claimed.length) continue;
      for (const dev of devices) {
        try {
          const r = await sendWebPush(dev, d.payload, vapid);
          if (r.ok) sent++;
          else { failed++; console.error('push failed', r.status, r.detail); }
          if (r.gone) await sql`delete from push_subscriptions where id = ${dev.id}`;
        } catch (e) {
          failed++;
          console.error('push error', e);
        }
      }
    }
  }
  return Response.json({ users: byUser.size, sent, failed });
});
