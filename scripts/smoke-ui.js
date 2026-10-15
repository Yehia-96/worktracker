// Run with Electron: electron scripts/smoke-ui.js. Uses isolated test data only.
const { app, BrowserWindow, clipboard, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const WT = require('../src/shared/core');
const output = path.resolve(__dirname, '../test-output');
fs.mkdirSync(output, { recursive: true });
const testDir = fs.mkdtempSync(path.join(output, 'profile-'));
app.setPath('userData', testDir);
app.setLoginItemSettings = () => {};
nativeTheme.themeSource = 'light';
const today = WT.todayKey();
fs.writeFileSync(path.join(testDir, 'worktracker-data.json'), JSON.stringify({
  trackingStart: today, settings: { ...WT.DEFAULT_SETTINGS, openAtLogin: false },
  entries: { [today]: { category: 'home', note: 'UI test' } }, prompts: { [today]: { note: 'done' } },
}));
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  contents.on('render-process-gone', (_event, details) => errors.push(`Renderer gone: ${details.reason}`));
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(50); }
  throw new Error('Timed out waiting for UI');
}
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
require('../src/main/main');
app.whenReady().then(async () => {
  const originalClipboard = await clipboard.readText();
  try {
    await waitFor(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().endsWith('index.html')));
    const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html'));
    await waitFor(() => evaluate(main, "!!document.querySelector('[data-view=\"settings\"]')"));
    await evaluate(main, "document.querySelector('[data-view=\"settings\"]').click()");
    await waitFor(() => evaluate(main, "!!document.querySelector('[name=\"linuxPracticeCount\"]')"));
    assert.equal(await evaluate(main, "document.querySelector('[name=\"linuxPracticeCount\"]').value"), '4');
    await evaluate(main, "document.querySelector('[data-test=\"linux\"]').scrollIntoView({block:'center'})");
    await evaluate(main, 'Promise.all(document.getAnimations().map(animation => animation.finished))');
    fs.writeFileSync(path.join(output, 'settings.png'), (await main.webContents.capturePage()).toPNG());
    await evaluate(main, "document.querySelector('[data-test=\"linux\"]').click()");
    await waitFor(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().endsWith('popup.html')));
    const popup = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('popup.html'));
    await waitFor(() => evaluate(popup, "!!document.querySelector('[data-next]')"));
    await evaluate(popup, 'Promise.all(document.getAnimations().map(animation => animation.finished))');
    const shown = new Set();
    let tallest = 0;
    for (let i = 0; i < 40; i++) {
      const payload = await evaluate(popup, 'window.api.popupGet()');
      assert.ok(!shown.has(payload.command.id), `Repeated ${payload.command.id}`);
      shown.add(payload.command.id);
      await evaluate(popup, "document.querySelector('[data-copy=\"0\"]').click()");
      await waitFor(() => evaluate(popup, "document.querySelector('[data-copy=\"0\"]').textContent === 'Copied!'"));
      assert.equal(await clipboard.readText(), payload.command.examples[0]);
      const layout = await evaluate(popup, `({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        height: document.querySelector('#card').offsetHeight,
        text: document.querySelector('#content').textContent,
        buttons: [...document.querySelectorAll('button')].every(b => b.getBoundingClientRect().right <= innerWidth)
      })`);
      assert.ok(layout.scrollWidth <= layout.width, `Horizontal overflow: ${payload.command.id}`);
      assert.ok(layout.buttons, `Clipped button: ${payload.command.id}`);
      assert.ok(layout.text.includes(payload.command.exercise));
      if (layout.height > tallest) {
        tallest = layout.height;
        await pause(400);
        fs.writeFileSync(path.join(output, 'practice-longest.png'), (await popup.webContents.capturePage()).toPNG());
      }
      if (i < 39) {
        await evaluate(popup, "document.querySelector('[data-next]').click()");
        await waitFor(async () => (await evaluate(popup, 'window.api.popupGet()')).command.id !== payload.command.id);
        await waitFor(() => evaluate(popup, "!document.querySelector('[data-next]').disabled"));
      }
    }
    nativeTheme.themeSource = 'dark';
    await pause(400);
    fs.writeFileSync(path.join(output, 'practice-dark.png'), (await popup.webContents.capturePage()).toPNG());
    await evaluate(popup, "document.querySelector('[data-got-it]').click()");
    await waitFor(() => popup.isDestroyed());
    assert.equal((await evaluate(main, 'window.api.bootstrap()')).settings.linuxPracticeCount, 4);
    // Exercise the actual Settings change listener and persisted values.
    await evaluate(main, `(() => { const el = document.querySelector('[name="linuxPracticeCount"]'); el.value = '6'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await waitFor(async () => (await evaluate(main, 'window.api.bootstrap()')).settings.linuxPracticeCount === 6);
    const data = JSON.parse(fs.readFileSync(path.join(testDir, 'worktracker-data.json'), 'utf8'));
    assert.equal(data.linuxPractice.seen.length, 40);
    assert.equal(data.entries[today].note, 'UI test');
    assert.deepEqual(errors, []);
    const result = { passed: true, commandsVerified: shown.size, settingsSaved: true, clipboardVerified: true, errors };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    await clipboard.writeText(originalClipboard);
    app.isQuitting = true;
    app.quit();
  } catch (error) {
    for (const win of BrowserWindow.getAllWindows()) {
      fs.writeFileSync(path.join(output, `failure-${win.id}.png`), (await win.webContents.capturePage()).toPNG());
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack, errors }, null, 2));
    console.error(error);
    await clipboard.writeText(originalClipboard);
    app.exit(1);
  }
});
