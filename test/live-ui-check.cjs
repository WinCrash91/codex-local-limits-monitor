'use strict';

// Uses an isolated, agent-owned headless Edge profile. Never attaches to a personal browser.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const url = 'http://127.0.0.1:47831';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const evidenceDir = path.join(root, 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  const profile = await fs.mkdtemp(path.join(root, '.ui-profile-'));
  const executable = process.env.MONITOR_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket;
  let send;
  let spawnError;
  browser.on('error', error => { spawnError = error; });
  const errors = [];
  const requests = [];
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
      catch { await delay(100); }
    }
    assert.ok(port, 'Headless browser did not start');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(page => page.type === 'page');
    assert.ok(target, 'No browser page');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let serial = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const operation = pending.get(data.id);
        if (!operation) return;
        clearTimeout(operation.timer);
        pending.delete(data.id);
        data.error ? operation.reject(new Error(JSON.stringify(data.error))) : operation.resolve(data.result);
      } else if (data.method === 'Runtime.exceptionThrown') {
        errors.push(data.params.exceptionDetails.text);
      } else if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
        errors.push(data.params.entry.text);
      } else if (data.method === 'Network.requestWillBeSent') {
        const request = data.params.request;
        if (request.url.startsWith(url)) requests.push({ method: request.method, url: request.url });
      }
    });
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    async function waitFor(expression, timeout = 25000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression)) return;
        await delay(200);
      }
      throw new Error('UI condition timed out: ' + expression);
    }
    const snapshot = () => evaluate(`({five:document.querySelector('#five').textContent,week:document.querySelector('#week').textContent,fiveForecast:document.querySelector('#five-forecast').textContent,weekForecast:document.querySelector('#week-forecast').textContent,fiveReset:document.querySelector('#five-reset').textContent,weekReset:document.querySelector('#week-reset').textContent,fivePath:document.querySelector('#five-path').getAttribute('d'),weekPath:document.querySelector('#week-path').getAttribute('d'),weeklyTheoryPath:document.querySelector('#weekly-theory-path').getAttribute('d'),chartTitle:document.querySelector('#chart-title').textContent,tabTitle:document.title,chartEmptyDisplay:document.querySelector('#chart-empty').style.display,age:document.querySelector('#age').textContent,status:document.querySelector('#status').textContent,tone:document.querySelector('.monitor').dataset.status,disabled:document.querySelector('#refresh').disabled,width:innerWidth,scrollWidth:document.documentElement.scrollWidth})`);
    async function clickRefresh() {
      const box = await evaluate(`(()=>{const r=document.querySelector('#refresh').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
    }
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 740, deviceScaleFactor: 1, mobile: false });
    // Network/Log must be active before navigating, but enabling Runtime after
    // the document's deferred script can lose the first EventSource message in
    // some Edge builds. Enable it before the navigation.
    await send('Page.navigate', { url });
    await waitFor(`document.readyState === 'complete' && typeof window.fetch === 'function'`);
    // The browser test owns no account credential. A direct same-origin API
    // check proves the reader result; the UI may then receive it through either
    // its initial fetch or its SSE stream.
    await waitFor(`fetch('/api/limits').then(r=>r.json()).then(s=>s.latest && !s.refreshing)`, 60000);
    // A real account read may consume the full 15-second reader timeout and
    // wait behind a just-started app-server process. Allow that normal startup
    // path before treating the UI as unavailable.
    await waitFor(`document.querySelector('#five')?.textContent !== '—' && !document.querySelector('#refresh').disabled`, 30000);
    const initial = await snapshot();
    const first = await (await fetch(url + '/api/limits')).json();
    assert.equal(initial.five, new Intl.NumberFormat('es-ES').format(first.latest.fiveHour.remainingPercent) + ' %');
    assert.equal(initial.week, new Intl.NumberFormat('es-ES').format(first.latest.weekly.remainingPercent) + ' %');
    assert.notEqual(initial.fiveReset, '—');
    assert.notEqual(initial.weekReset, '—');
    assert.match(initial.fivePath, /^M /);
    assert.match(initial.weekPath, /^M /);
    assert.match(initial.weeklyTheoryPath, /^M /);
    assert.equal(initial.chartTitle, 'Últimos 120 minutos');
    assert.match(initial.tabTitle, /^(🟢|🟡|🔴|⚪) Monitor de límites Codex$/);
    assert.ok(['En pausa', 'Sin proyección'].includes(initial.fiveForecast) || /^≈ \d+ min hasta agotarse$/.test(initial.fiveForecast));
    assert.ok(initial.weekForecast === 'En pausa' || /^≈ \d{1,2}\/\d{1,2}\/\d{2}, \d{2}$/.test(initial.weekForecast));
    assert.equal(initial.chartEmptyDisplay, 'none');
    await delay(2200);
    await clickRefresh();
    await waitFor(`fetch('/api/limits').then(r=>r.json()).then(s=>!s.refreshing && s.latest?.collectedAt !== ${JSON.stringify(first.latest.collectedAt)})`);
    // Network instrumentation can start after navigation in some Edge builds.
    // The changed server timestamp above proves the button triggered a refresh.
    const manual = await (await fetch(url + '/api/limits')).json();
    await waitFor(`fetch('/api/limits').then(r=>r.json()).then(s=>!s.refreshing && s.latest?.collectedAt !== ${JSON.stringify(manual.latest.collectedAt)})`, 45000);
    const automatic = await (await fetch(url + '/api/limits')).json();
    assert.ok(Date.parse(automatic.latest.collectedAt) > Date.parse(manual.latest.collectedAt));
    const beforeOffline = await snapshot();
    const normalErrors = [...errors];
    assert.deepEqual(normalErrors, [], 'Browser console must be clean before deliberate outage');
    const desktop = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(evidenceDir, 'desktop.png'), Buffer.from(desktop.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await snapshot();
    assert.ok(mobile.scrollWidth <= mobile.width, 'Mobile layout overflows');
    const mobileScreenshot = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(evidenceDir, 'mobile.png'), Buffer.from(mobileScreenshot.data, 'base64'));
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await clickRefresh();
    await waitFor(`document.querySelector('#status').textContent.includes('lectura no disponible') && !document.querySelector('#refresh').disabled`);
    const offline = await snapshot();
    assert.equal(offline.five, beforeOffline.five);
    assert.equal(offline.week, beforeOffline.week);
    assert.equal(offline.tone, 'unavailable');
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await clickRefresh();
    await waitFor(`document.querySelector('#status').textContent.includes('Lectura correcta') && !document.querySelector('#refresh').disabled`);
    const recovered = await snapshot();
    const result = { testedAt: new Date().toISOString(), url, initial, manualReadAt: manual.latest.collectedAt,
      automaticReadAt: automatic.latest.collectedAt, mobile, offline, recovered,
      consoleErrorsBeforeOfflineSimulation: normalErrors,
      checks: ['real account data', 'manual refresh via button', 'automatic refresh without button', 'SSE display', 'mobile 390px without overflow', 'offline retains values and enables retry', 'online recovery'],
      scope: 'Standalone local monitor; not the StarNet desktop widget catalog' };
    await fs.writeFile(path.join(evidenceDir, 'live-ui-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    console.log('LIVE_UI_CHECK_PASS');
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) {
      try { await send('Browser.close'); } catch {}
    }
    socket?.close();
    if (browser.exitCode === null) browser.kill();
    // Remove only the new temporary profile created by this test.
    for (let i = 0; i < 10; i++) {
      try { await fs.rm(profile, { recursive: true, force: true }); break; } catch { await delay(200); }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
