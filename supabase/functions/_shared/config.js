// Public cloud configuration (safe to publish: data access is protected by login + row-level security).
(function (root, config) {
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.WTConfig = config;
})(globalThis, {
  SUPABASE_URL: 'https://ljylvlolddaguzxenxdl.supabase.co',
  SUPABASE_KEY: 'sb_publishable__N8b3FB_NBswTHthdJDnug_C55CC1d7',
  WEB_APP_URL: 'https://yehia-96.github.io/worktracker/',
  VAPID_PUBLIC_KEY: 'BGrLeZiLz9sSc91JwUEjEyUQR96dzZFl8Ko392T7WXWOqWUaVDojAZVYjiWRcdmkknPvuWFM6qDQvqYdLsRuY_8',
  // Settings that follow you between PC and iPhone (device-only ones like autostart stay local).
  SYNCED_SETTINGS: [
    'state', 'checkinTime', 'noteTime', 'workdays', 'commuteKm', 'commuteRateFirst20', 'commuteRateAfter20',
    'homeOfficeRate', 'homeOfficeCap', 'linuxPracticeCount', 'linuxPracticeStart', 'linuxPracticeEnd', 'phoneLinuxPractice',
  ],
  // The iPhone is reminded a few minutes after the PC, so answering at the desk keeps the phone quiet.
  PHONE_DELAY_MIN: 5,
});
