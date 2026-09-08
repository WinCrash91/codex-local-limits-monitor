'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { readCodexLimits, SOURCE } = require('./reader.cjs');
const { buildFiveHourStatus } = require('./five-hour-status.cjs');

// Keep the graph and its persisted local history to the requested 120 minutes.
const HISTORY_WINDOW_MS = 120 * 60 * 1000;
const DEFAULT_HISTORY_FILE = path.join(__dirname, 'data', 'history.json');

function normaliseSample(sample) {
  const timestamp = Date.parse(sample?.collectedAt);
  const fiveHourRemainingPercent = sample?.fiveHourRemainingPercent;
  const weeklyRemainingPercent = sample?.weeklyRemainingPercent;
  if (!Number.isFinite(timestamp)
    || !Number.isFinite(fiveHourRemainingPercent)
    || !Number.isFinite(weeklyRemainingPercent)
    || fiveHourRemainingPercent < 0 || fiveHourRemainingPercent > 100
    || weeklyRemainingPercent < 0 || weeklyRemainingPercent > 100) return null;
  return { collectedAt: new Date(timestamp).toISOString(), fiveHourRemainingPercent, weeklyRemainingPercent };
}

function trimHistory(samples, now) {
  const cutoff = now - HISTORY_WINDOW_MS;
  return samples.map(normaliseSample).filter(Boolean)
    .filter(sample => Date.parse(sample.collectedAt) >= cutoff)
    .sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
}

function loadHistory(historyFile, now) {
  if (!historyFile) return [];
  try {
    const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    return trimHistory(Array.isArray(data?.samples) ? data.samples : [], now);
  } catch {
    // A first launch, deleted file, or invalid local cache starts cleanly.
    return [];
  }
}

function saveHistory(historyFile, history) {
  if (!historyFile) return;
  const directory = path.dirname(historyFile);
  const temporaryFile = path.join(directory, `.${path.basename(historyFile)}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 1, samples: history }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, historyFile);
  } catch {
    // The monitor must keep showing valid in-memory data when disk persistence fails.
    try { fs.unlinkSync(temporaryFile); } catch {}
  }
}

function createMonitor({ read = readCodexLimits, now = Date.now, pollMs = 30000, historyFile = null } = {}) {
  let latest = null;
  let history = loadHistory(historyFile, now());
  let lastAttemptAt = null;
  let error = null;
  let refreshing = false;
  let inFlight = null;
  let timer = null;
  const listeners = new Set();
  function state() {
    const age = latest ? now() - Date.parse(latest.collectedAt) : Infinity;
    return {
      source: SOURCE, latest, lastAttemptAt, refreshing, pollIntervalMs: pollMs,
      history,
      fiveHourStatus: buildFiveHourStatus(history, latest),
      status: error ? 'unavailable' : latest ? (age > pollMs * 2 ? 'stale' : 'ok') : 'waiting',
      message: error ? 'lectura no disponible' : latest ? null : 'Esperando la primera lectura'
    };
  }
  function emit() { for (const listener of listeners) listener(state()); }
  function refresh() {
    if (inFlight) return inFlight;
    // Button bursts reuse the recent read; polling is independent of the number of tabs.
    if (lastAttemptAt !== null && now() - Date.parse(lastAttemptAt) < 2000) return Promise.resolve(state());
    lastAttemptAt = new Date(now()).toISOString();
    refreshing = true;
    emit();
    inFlight = Promise.resolve().then(read).then(data => {
      latest = data;
      // Keep only chart values. Recent samples are also saved locally so a restart
      // does not discard the current graph window.
      history = trimHistory([...history, {
        collectedAt: data.collectedAt,
        fiveHourRemainingPercent: data.fiveHour.remainingPercent,
        weeklyRemainingPercent: data.weekly.remainingPercent
      }], now());
      saveHistory(historyFile, history);
      error = null;
    }).catch(() => {
      error = true; // Keep last known values and their original timestamp.
    }).finally(() => {
      refreshing = false;
      inFlight = null;
      emit();
    }).then(state);
    return inFlight;
  }
  function start() {
    if (timer) return;
    void refresh();
    timer = setInterval(() => { void refresh(); }, pollMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }
  return { state, refresh, start, stop, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}

function createServer(monitor) {
  const publicDir = path.join(__dirname, 'public');
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const expectedHost = `127.0.0.1:${address.port}`;
    if (req.headers.host !== expectedHost) { res.writeHead(403); return res.end('Host no permitido'); }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const pathname = new URL(req.url, `http://${expectedHost}`).pathname;
    function json(code, value) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
    if (req.method === 'GET' && pathname === '/api/limits') return json(200, monitor.state());
    if (req.method === 'POST' && pathname === '/api/refresh') {
      const origin = req.headers.origin;
      if (req.headers['x-monitor-request'] !== '1'
        || (origin && origin !== `http://${expectedHost}`)
        || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Origen no permitido' });
      await monitor.refresh();
      return json(200, monitor.state());
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const write = state => res.write(`data: ${JSON.stringify(state)}\n\n`);
      write(monitor.state());
      const unsubscribe = monitor.subscribe(write);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      req.on('close', () => { unsubscribe(); clearInterval(heartbeat); });
      return;
    }
    if (req.method === 'GET' && assets[pathname]) {
      const [file, type] = assets[pathname];
      try { const body = await fs.promises.readFile(path.join(publicDir, file)); res.writeHead(200, { 'Content-Type': type }); res.end(body); }
      catch { json(500, { error: 'No se pudo cargar la interfaz local.' }); }
      return;
    }
    return json(404, { error: 'No encontrado' });
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  const monitor = createMonitor({ historyFile: DEFAULT_HISTORY_FILE });
  const server = createServer(monitor);
  const port = Number(process.env.PORT || 47831);
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'El puerto ya está ocupado; el monitor no se ha iniciado.' : 'No se pudo iniciar el monitor local.'); process.exitCode = 1; monitor.stop(); });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Monitor Codex: http://127.0.0.1:${server.address().port}`);
    console.log('Lectura directa cada 30 segundos. Sin rutinas, inferencia ni publicación de widgets.');
    monitor.start();
  });
  function shutdown() { monitor.stop(); server.closeAllConnections(); server.close(() => process.exit(0)); }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
}

module.exports = { createMonitor, createServer, HISTORY_WINDOW_MS };
