'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { colorForRate, buildFiveHourStatus, TOOLTIP_MAX_LENGTH } = require('../five-hour-status.cjs');
const { OFFLINE_PRESENTATION, retryDelay, presentationFromState, createTrayClient } = require('../tray-client.cjs');

const end = Date.parse('2027-01-15T08:02:00.000Z');
function latest(remainingPercent = 91.2) {
  return { collectedAt: new Date(end).toISOString(), fiveHour: { remainingPercent } };
}
function history(first, last = 91.2) {
  return [
    { collectedAt: new Date(end - 120000).toISOString(), fiveHourRemainingPercent: first },
    { collectedAt: new Date(end).toISOString(), fiveHourRemainingPercent: last }
  ];
}

test('mapea la tasa 5H a gris, verde, amarillo y rojo con los límites inclusivos', () => {
  assert.equal(colorForRate(null), 'gray');
  assert.equal(colorForRate(0), 'gray');
  assert.equal(colorForRate(32.999), 'green');
  assert.equal(colorForRate(33), 'yellow');
  assert.equal(colorForRate(50), 'yellow');
  assert.equal(colorForRate(50.001), 'red');
});

test('construye tooltip con porcentaje y minutos usando formato español', () => {
  const status = buildFiveHourStatus(history(92.4), latest());
  assert.equal(status.color, 'yellow');
  assert.equal(status.projection, 'minutes');
  assert.equal(status.estimatedMinutes, 152);
  assert.equal(status.tooltip, 'Codex 5H: 91,2 % restante · ≈ 152 min');
  assert.ok(status.tooltip.length <= TOOLTIP_MAX_LENGTH);
});

test('distingue En pausa, Sin proyección y sin datos', () => {
  const paused = buildFiveHourStatus(history(91.2), latest());
  assert.equal(paused.color, 'gray');
  assert.equal(paused.projection, 'paused');
  assert.match(paused.tooltip, /En pausa$/);

  const insufficient = buildFiveHourStatus(history(92.2).slice(1), latest());
  assert.equal(insufficient.color, 'gray');
  assert.equal(insufficient.projection, 'insufficient');
  assert.match(insufficient.tooltip, /Sin proyección$/);

  const noData = buildFiveHourStatus([], null);
  assert.deepEqual(noData, { color: 'gray', ratePerHour: null, projection: 'no-data',
    estimatedMinutes: null, tooltip: 'Codex 5H: sin datos' });
});

test('el cliente reintenta con espera exponencial y vuelve al intervalo normal al recuperarse', async () => {
  const scheduled = [];
  const cancelled = [];
  const presentations = [];
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('offline');
    return { ok: true, json: async () => ({ fiveHourStatus: {
      color: 'green', tooltip: 'Codex 5H: 90 % restante · En pausa'
    } }) };
  };
  const client = createTrayClient({ baseUrl: 'http://127.0.0.1:47831', fetchImpl,
    onPresentation: value => presentations.push(value),
    schedule: (fn, ms) => { scheduled.push(ms); return scheduled.length; },
    cancel: id => cancelled.push(id), pollMs: 5000 });
  client.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(presentations.at(-1), OFFLINE_PRESENTATION);
  assert.equal(scheduled.at(-1), 1000);
  await assert.rejects(client.pollNow(), /offline/);
  assert.equal(scheduled.at(-1), 2000);
  await client.pollNow();
  assert.deepEqual(presentations.at(-1), {
    color: 'green', tooltip: 'Codex 5H: 90 % restante · En pausa', connected: true
  });
  assert.equal(scheduled.at(-1), 5000);
  assert.ok(cancelled.length >= 2);
  client.stop();
});

test('el sondeo solo lee /api/limits y Actualizar ahora usa el POST protegido existente', async () => {
  const requests = [];
  const state = { fiveHourStatus: { color: 'red', tooltip: 'Codex 5H: 20 % restante · ≈ 5 min' } };
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method || 'GET', headers: options.headers });
    return { ok: true, json: async () => state };
  };
  const client = createTrayClient({ baseUrl: 'http://127.0.0.1:47831', fetchImpl,
    schedule: () => 1, cancel: () => {} });
  await client.pollNow();
  await client.refresh();
  assert.deepEqual(requests.map(request => [request.method, request.url]), [
    ['GET', 'http://127.0.0.1:47831/api/limits'],
    ['POST', 'http://127.0.0.1:47831/api/refresh']
  ]);
  assert.equal(requests[1].headers['X-Monitor-Request'], '1');
  client.stop();
});

test('valida presentaciones recibidas y limita la espera de reconexión', () => {
  assert.deepEqual(presentationFromState({}), OFFLINE_PRESENTATION);
  assert.equal(retryDelay(1), 1000);
  assert.equal(retryDelay(6), 30000);
  assert.equal(retryDelay(100), 30000);
});
