# Work Tracker

Small Windows tray app that records, per working day, whether you worked in the **Office**, **Home office**, on **Dienstreise**, or were on **Urlaub** / **Krank** — and turns it into a yearly summary for the Steuererklärung.

## What it does
- **10:00 Mon–Fri** – a notification-style popup asks where you're working (keys `1`–`5` also work). Missed days (PC off, asleep) are asked on the next start.
- **16:00 Mon–Fri** – a second popup asks for an optional note about the day.
- NRW public holidays are skipped automatically (other Bundesländer selectable).
- **Calendar** – the whole year color-coded; click a day to edit, or pick a category and "paint" days.
- **Plan time off** – fill a date range (e.g. Urlaub) in one go; weekends/holidays are skipped.
- **Summary** – counts per category, monthly breakdown, Homeoffice-Pauschale and Entfernungspauschale estimates, **PDF / CSV export**.
- Lives in the system tray and starts with Windows (can be turned off in Settings).
- **Linux practice** – on by default: 4 randomly timed command cards per working day, between 10:00 and 16:00 local time. Settings lets you turn it off, choose 1–24 popups per day, or change the window.
- 117 Linux commands across files, text processing, processes, permissions, networking, archives, Git, shell/system tools, and containers & GPU (nvidia-smi, tmux, docker, conda). Each card includes syntax, examples with **Copy example**, an exercise, **Next command**, and **Got it**. Try them on the DGX (`ssh dgx`) or in WSL; Work Tracker never executes commands.
- Practice follows your working-day/holiday settings and skips Urlaub/Krank days. Check-in and note popups take priority; conflicting or missed slots are skipped, with no catch-up queue after sleep. Times are saved across restarts; starting late schedules only within the remaining window. Changing settings preserves slots already used that day.
- Command history persists across restarts, with no repeats until all commands have been seen. **Practice now** in Settings and **Next command** use the same history without using an automatic reminder slot.

## Install / run
- Installer: `dist\Work Tracker Setup 1.2.0.exe` (per-user, no admin needed).
- From source: `npm install` then `npm start`.
- Rebuild installer: `npm run dist` · Tests: `npm test`.

## Data
Stored locally in `%APPDATA%\Work Tracker\worktracker-data.json`, with daily backups (last 14 days) in `backups\`. Settings → *Open data folder*.

## Future: mobile + sync
The data model is already sync-ready: one record per day with `updatedAt` and `deviceId`, and deletions are kept as tombstones. A sync backend (e.g. Supabase/Firebase with an account) can merge devices with *last write wins per day*. The UI is plain HTML/CSS/JS, so it can be reused for a mobile app (e.g. Capacitor), and `src/shared/core.js` (holidays, summary, tax estimates) is shared as-is.

## Layout
```
src/shared/core.js   categories, dates, holidays, yearly summary (main + renderer)
src/main/            Electron main: scheduler, tray, popups, store, PDF/CSV export
renderer/            main window (index.html) and the notification popup (popup.html)
scripts/             icon generator, core tests
```
