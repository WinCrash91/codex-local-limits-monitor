'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeLimits, codexEnvironment, readCodexLimits } = require('../reader.cjs');
const { createMonitor, createServer, HISTORY_WINDOW_MS } = require('../server.cjs');

function fixture() {
  return { accountId: 'private-account', rateLimitResetCredits: { availableCount: 1 },
    rateLimits: { limitId: 'codex', primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1800000000 },
      secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1800600000 } } };
}

test('300 y 10080 minutos identifican las ventanas, incluso invertidas', () => {
  const response = fixture();
  [response.rateLimits.primary, response.rateLimits.secondary] = [response.rateLimits.secondary, response.rateLimits.primary];
  const result = normalizeLimits(response, 1800000000000);
  assert.equal(result.fiveHour.remainingPercent, 78);
  assert.equal(result.weekly.remainingPercent, 97);
  assert.equal(result.collectedAt, '2027-01-15T08:00:00.000Z');
  assert.equal(result.fiveHour.resetsAt, '2027-01-15T08:00:00.000Z');
  assert.ok(!JSON.stringify(result).includes('private-account'));
  assert.ok(!JSON.stringify(result).includes('rateLimitResetCredits'));
});

test('usa el bucket codex, nunca mezcla cuotas de otros modelos', () => {
  const response = fixture();
  response.rateLimitsByLimitId = { codex: response.rateLimits };
  response.rateLimits = { limitId: 'other' };
  assert.equal(normalizeLimits(response).weekly.remainingPercent, 97);
  delete response.rateLimitsByLimitId;
  assert.throws(() => normalizeLimits(response), /Codex/);
});

test('el backend conserva toda la precisión recibida; el frontend decide cómo presentarla', () => {
  const response = fixture();
  response.rateLimits.primary.usedPercent = 22.34567;
  response.rateLimits.secondary.usedPercent = 3.00009;
  const result = normalizeLimits(response);
  assert.equal(result.fiveHour.usedPercent, 22.34567);
  assert.equal(result.fiveHour.remainingPercent, 77.65433);
  assert.equal(result.weekly.remainingPercent, 96.99991);
});

test('una ventana ausente o duplicada no se sustituye por 100%', () => {
  const response = fixture();
  response.rateLimits.secondary = null;
  assert.equal(normalizeLimits(response).weekly, null);
  response.rateLimits.secondary = response.rateLimits.primary;
  assert.throws(() => normalizeLimits(response), /300/);
});

test('solo semanal: actualiza y persiste los datos sin inventar la ventana de 5H', async () => {
  const response = fixture();
  response.rateLimits.primary = response.rateLimits.secondary;
  response.rateLimits.secondary = null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-weekly-'));
  const historyFile = path.join(directory, 'history.json');
  try {
    const monitor = createMonitor({ historyFile, read: async () => normalizeLimits(response) });
    await monitor.refresh();
    const state = monitor.state();
    assert.equal(state.status, 'ok');
    assert.equal(state.latest.fiveHour, null);
    assert.equal(state.latest.weekly.remainingPercent, 97);
    assert.equal(state.history[0].fiveHourRemainingPercent, null);
    assert.equal(state.fiveHourStatus.color, 'gray');
    assert.deepEqual(createMonitor({ historyFile }).state().history, state.history);
    response.rateLimits.primary = null;
    assert.throws(() => normalizeLimits(response), /ventana/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rechaza porcentajes imposibles y conserva cero como valor válido', () => {
  const response = fixture();
  for (const invalid of [-1, 101, NaN, Infinity, null, '10']) {
    response.rateLimits.primary.usedPercent = invalid;
    assert.throws(() => normalizeLimits(response), /Porcentaje/);
  }
  response.rateLimits.primary.usedPercent = 100;
  response.rateLimits.secondary.usedPercent = 0;
  const result = normalizeLimits(response);
  assert.equal(result.fiveHour.remainingPercent, 0);
  assert.equal(result.weekly.remainingPercent, 100);
});

test('reinicio desconocido no se convierte en fecha inventada', () => {
  const response = fixture();
  response.rateLimits.primary.resetsAt = null;
  assert.equal(normalizeLimits(response).fiveHour.resetsAt, null);
});

test('el lector proporciona HOME a Codex cuando Node solo expone USERPROFILE', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-home-'));
  try {
    const environment = { USERPROFILE: home };
    const result = codexEnvironment(environment);
    assert.equal(result.HOME, home);
    assert.equal(result.USERPROFILE, home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function fakeProcess(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
  const sent = [];
  child.stdin.on('data', data => {
    const message = JSON.parse(data.toString());
    sent.push(message);
    queueMicrotask(() => handler(message, child));
  });
  return { child, sent, spawnProcess: () => child };
}

test('protocolo real de solo lectura, fragmentación JSON y cierre del proceso', async () => {
  const mock = fakeProcess((message, child) => {
    if (message.id === 1) child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    if (message.id === 2) {
      child.stdout.write('not-json\n' + JSON.stringify({ method: 'notification', params: {} }) + '\n');
      const response = JSON.stringify({ id: 2, result: fixture() }) + '\n';
      child.stdout.write(response.slice(0, 20));
      child.stdout.write(response.slice(20));
    }
  });
  const result = await readCodexLimits({ executable: 'fake', spawnProcess: mock.spawnProcess, timeoutMs: 1000 });
  assert.equal(result.fiveHour.remainingPercent, 78);
  assert.deepEqual(mock.sent.map(m => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(mock.child.killed, true);
});

test('timeout mata al hijo y no informa lectura correcta', async () => {
  const mock = fakeProcess(() => {});
  await assert.rejects(readCodexLimits({ executable: 'fake', spawnProcess: mock.spawnProcess, timeoutMs: 15 }), /plazo/);
  assert.equal(mock.child.killed, true);
});

test('errores del proveedor no filtran sus mensajes privados', async () => {
  const mock = fakeProcess((message, child) => {
    if (message.id === 1) child.stdout.write(JSON.stringify({ id: 1, error: { message: 'private-secret' } }) + '\n');
  });
  await assert.rejects(readCodexLimits({ executable: 'fake', spawnProcess: mock.spawnProcess }), error => {
    assert.ok(!error.message.includes('private-secret'));
    return true;
  });
  assert.equal(mock.child.killed, true);
});

test('fallo conserva ambos valores y la fecha; lectura posterior recupera estado', async () => {
  let clock = 1800000000000;
  let fail = false;
  const monitor = createMonitor({ now: () => clock, read: async () => {
    if (fail) throw new Error('auth failure with private-data');
    return normalizeLimits(fixture(), clock);
  } });
  await monitor.refresh();
  const before = monitor.state().latest;
  clock += 30000;
  fail = true;
  await monitor.refresh();
  assert.equal(monitor.state().status, 'unavailable');
  assert.deepEqual(monitor.state().latest, before);
  assert.equal(monitor.state().message, 'lectura no disponible');
  assert.ok(!JSON.stringify(monitor.state()).includes('private-data'));
  clock += 30000;
  fail = false;
  await monitor.refresh();
  assert.equal(monitor.state().status, 'ok');
  assert.notEqual(monitor.state().latest.collectedAt, before.collectedAt);
});

test('un fallo inicial muestra ausencia de datos y nunca un porcentaje simulado', async () => {
  const monitor = createMonitor({ read: async () => { throw new Error('offline'); } });
  await monitor.refresh();
  assert.equal(monitor.state().status, 'unavailable');
  assert.equal(monitor.state().latest, null);
});

test('lecturas concurrentes y doble clic comparten una única llamada', async () => {
  let finish;
  let count = 0;
  const monitor = createMonitor({ read: () => { count++; return new Promise(resolve => { finish = resolve; }); } });
  const first = monitor.refresh();
  const second = monitor.refresh();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(count, 1);
  finish(normalizeLimits(fixture()));
  await first;
  await monitor.refresh();
  assert.equal(count, 1);
});

test('los datos envejecidos se distinguen de una lectura actual', async () => {
  let clock = 1800000000000;
  const monitor = createMonitor({ now: () => clock, read: async () => normalizeLimits(fixture(), clock) });
  await monitor.refresh();
  clock += 60001;
  assert.equal(monitor.state().status, 'stale');
});

test('el sondeo automático avanza sin botones ni rutinas', async () => {
  let clock = 1800000000000;
  let count = 0;
  const monitor = createMonitor({ pollMs: 15, now: () => clock, read: async () => {
    count++; const result = normalizeLimits(fixture(), clock); clock += 3000; return result;
  } });
  monitor.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 65));
    assert.ok(count >= 2);
  } finally { monitor.stop(); }
});

test('el histórico publica ambas variables durante una ventana móvil de 120 minutos', async () => {
  let clock = 1800000000000;
  let usage = 20;
  const monitor = createMonitor({ now: () => clock, read: async () => {
    const response = fixture();
    response.rateLimits.primary.usedPercent = usage++;
    return normalizeLimits(response, clock);
  } });
  await monitor.refresh();
  clock += 119 * 60 * 1000;
  await monitor.refresh();
  clock += 2 * 60 * 1000;
  await monitor.refresh();
  const history = monitor.state().history;
  assert.equal(history.length, 2);
  assert.deepEqual(Object.keys(history[0]).sort(), ['collectedAt', 'fiveHourRemainingPercent', 'weeklyRemainingPercent']);
  assert.equal(history[0].fiveHourRemainingPercent, 79);
  assert.equal(history[1].fiveHourRemainingPercent, 78);
});

test('la ventana de gráfico e histórico cubre exactamente 120 minutos', () => {
  assert.equal(HISTORY_WINDOW_MS, 120 * 60 * 1000);
});

test('la primera lectura válida crea la primera muestra del histórico', async () => {
  let clock = 1800000000000;
  const monitor = createMonitor({ now: () => clock, read: async () => normalizeLimits(fixture(), clock) });
  await monitor.refresh();
  assert.equal(monitor.state().history.length, 1);
  clock += 30000;
  await monitor.refresh();
  assert.equal(monitor.state().history.length, 2);
});

test('el histórico reciente se guarda localmente y se recupera tras reiniciar el monitor', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-history-'));
  const historyFile = path.join(directory, 'history.json');
  let clock = 1800000000000;
  try {
    const first = createMonitor({ historyFile, now: () => clock, read: async () => normalizeLimits(fixture(), clock) });
    await first.refresh();
    clock += 30000;
    await first.refresh();
    const stored = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.samples.length, 2);
    assert.deepEqual(Object.keys(stored.samples[0]).sort(), ['collectedAt', 'fiveHourRemainingPercent', 'weeklyRemainingPercent']);

    const restarted = createMonitor({ historyFile, now: () => clock, read: async () => normalizeLimits(fixture(), clock) });
    assert.equal(restarted.state().history.length, 2);

    clock += HISTORY_WINDOW_MS + 1;
    const expired = createMonitor({ historyFile, now: () => clock });
    assert.equal(expired.state().history.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('API local: origen/host, refresco, SSE y recursos de interfaz', async () => {
  let clock = 1800000000000;
  const monitor = createMonitor({ now: () => clock, read: async () => normalizeLimits(fixture(), clock) });
  const server = createServer(monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const empty = await (await fetch(url + '/api/limits')).json();
    assert.equal(empty.latest, null);
    assert.equal((await fetch(url + '/api/refresh', { method: 'POST' })).status, 403);
    assert.equal((await fetch(url + '/api/refresh', { method: 'POST', headers: {
      'X-Monitor-Request': '1', Origin: 'https://untrusted.example'
    } })).status, 403);
    const result = await (await fetch(url + '/api/refresh', { method: 'POST', headers: {
      'X-Monitor-Request': '1', Origin: url
    } })).json();
    assert.equal(result.latest.weekly.remainingPercent, 97);
    assert.equal(result.history.length, 1);
    const html = await fetch(url);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await html.text(), /id="refresh"/);
    assert.equal((await fetch(url + '/style.css')).status, 200);
    assert.equal((await fetch(url + '/app.js')).status, 200);
    assert.equal((await fetch(url + '/reader.cjs')).status, 404);
    const forbiddenHost = await new Promise((resolve, reject) => {
      const request = http.get(url + '/api/limits', { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); });
      request.on('error', reject);
    });
    assert.equal(forbiddenHost, 403);
    const controller = new AbortController();
    const stream = await fetch(url + '/api/events', { signal: controller.signal });
    assert.match(stream.headers.get('content-type'), /event-stream/);
    const reader = stream.body.getReader();
    const event = await reader.read();
    assert.match(new TextDecoder().decode(event.value), /remainingPercent/);
    controller.abort();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
