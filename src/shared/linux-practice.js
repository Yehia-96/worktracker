'use strict';

const WT = require('./core');
const commands = require('./linux-commands.json');
const MINUTE = 60000;

function validateSettings(settings) {
  if (typeof settings.linuxPracticeEnabled !== 'boolean') throw new Error('Choose whether Linux practice is on or off.');
  const count = settings.linuxPracticeCount;
  if (!Number.isInteger(count) || count < 1 || count > 24) throw new Error('Choose 1–24 Linux popups per day.');
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(settings.linuxPracticeStart) || !time.test(settings.linuxPracticeEnd)) throw new Error('Enter valid Linux practice times.');
  const length = WT.parseTime(settings.linuxPracticeEnd) - WT.parseTime(settings.linuxPracticeStart);
  if (length <= 0) throw new Error('Linux practice end time must be after its start time.');
  if (length < count) throw new Error('Allow at least one minute per Linux popup in the time window.');
}

// One random minute in each section of the window spreads practice through the day.
function makeSlots(start, end, count, random = Math.random) {
  const minutes = Math.floor((end - start) / MINUTE);
  count = Math.min(count, minutes);
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const low = Math.floor(i * minutes / count);
    const high = Math.floor((i + 1) * minutes / count);
    return start + (low + Math.floor(random() * (high - low))) * MINUTE;
  });
}

// Mutates only practice state. Missed or conflicting slots are consumed, never queued.
function advance(practice, settings, now, { busy = false, category = null } = {}, random = Math.random) {
  const before = JSON.stringify(practice.daily);
  const date = WT.toKey(now);
  const at = now.getTime();
  if (practice.daily?.date !== date) practice.daily = { date, used: 0, slots: [], signature: null };
  const daily = practice.daily;
  const eligible = settings.linuxPracticeEnabled && WT.isWorkingDay(date, settings) && !['vacation', 'sick'].includes(category);
  const signature = JSON.stringify([eligible, settings.linuxPracticeCount, settings.linuxPracticeStart, settings.linuxPracticeEnd, now.getTimezoneOffset()]);
  const midnight = WT.fromKey(date);
  const localTime = (value) => {
    const result = new Date(midnight);
    const [hours, minutes] = value.split(':').map(Number);
    result.setHours(hours, minutes, 0, 0);
    return result.getTime();
  };
  const start = localTime(settings.linuxPracticeStart);
  const end = localTime(settings.linuxPracticeEnd);
  if (daily.signature !== signature) {
    // Changing settings does not restore slots already used today.
    daily.signature = signature;
    daily.slots = eligible ? makeSlots(Math.max(start, Math.floor(at / MINUTE) * MINUTE + MINUTE), end,
      Math.max(0, settings.linuxPracticeCount - daily.used), random) : [];
  }
  let show = false;
  while (daily.slots.length && daily.slots[0] <= at) {
    const slot = daily.slots.shift();
    daily.used++;
    if (eligible && !busy && at >= start && at < end && at - slot < MINUTE) show = true;
  }
  return { show, changed: before !== JSON.stringify(daily) };
}

function nextCommand(practice, random = Math.random) {
  const ids = new Set(commands.map((command) => command.id));
  let seen = new Set((practice.seen || []).filter((id) => ids.has(id)));
  if (seen.size === commands.length) seen = new Set();
  let available = commands.filter((command) => !seen.has(command.id));
  // Also avoid an immediate duplicate at the boundary between two complete cycles.
  if (!seen.size && available.length > 1) available = available.filter((command) => command.id !== practice.lastId);
  const command = available[Math.floor(random() * available.length)];
  seen.add(command.id);
  practice.seen = [...seen];
  practice.lastId = command.id;
  return { command, progress: seen.size, total: commands.length };
}

module.exports = { commands, validateSettings, makeSlots, advance, nextCommand };
