'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = 'Codex · account/rateLimits/read';

function normalizeLimits(result, now = Date.now()) {
  const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!snapshot || (snapshot.limitId && snapshot.limitId !== 'codex')) {
    throw new Error('No se recibió el límite de Codex.');
  }
  const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
  function windowFor(minutes) {
    const matches = windows.filter(w => w.windowDurationMins === minutes);
    if (matches.length !== 1) throw new Error(`Falta una ventana válida de ${minutes} minutos.`);
    const w = matches[0];
    if (!Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) {
      throw new Error('Porcentaje de consumo no válido.');
    }
    const reset = Number.isSafeInteger(w.resetsAt) && w.resetsAt > 0
      && w.resetsAt < 8640000000000 ? new Date(w.resetsAt * 1000).toISOString() : null;
    return {
      windowDurationMins: minutes,
      usedPercent: w.usedPercent,
      // Preserve the value received from Codex. Presentation rounding belongs to the frontend.
      remainingPercent: 100 - w.usedPercent,
      resetsAt: reset
    };
  }
  // Publish both windows atomically: a partial response cannot renew an old timestamp.
  return {
    source: SOURCE,
    collectedAt: new Date(now).toISOString(),
    fiveHour: windowFor(300),
    weekly: windowFor(10080)
  };
}

function findCodex() {
  if (process.env.CODEX_BIN) {
    if (!fs.existsSync(process.env.CODEX_BIN)) throw new Error('CODEX_BIN no apunta a un ejecutable existente.');
    return process.env.CODEX_BIN;
  }
  const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(root)) {
    const candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name, 'codex.exe'))
      .filter(file => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  // Installed command on non-Windows hosts, or an explicitly configured PATH.
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function findHomeDirectory(environment = process.env) {
  const candidates = [
    environment.HOME,
    environment.USERPROFILE,
    environment.HOMEDRIVE && environment.HOMEPATH
      ? path.join(environment.HOMEDRIVE, environment.HOMEPATH) : null,
    environment.LOCALAPPDATA ? path.dirname(path.dirname(environment.LOCALAPPDATA)) : null
  ];
  return candidates.find(candidate => typeof candidate === 'string' && fs.existsSync(candidate)) ?? null;
}

function codexEnvironment(environment = process.env) {
  const home = findHomeDirectory(environment);
  // Codex needs HOME even on Windows. Normal Node installations commonly
  // provide USERPROFILE but not HOME, so inherit the Windows profile instead.
  return home && environment.HOME !== home ? { ...environment, HOME: home } : environment;
}

function readCodexLimits({ executable = findCodex(), timeoutMs = 15000, spawnProcess = spawn, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let buffer = '';
    let settled = false;
    let initialized = false;
    function finish(error, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.exitCode === null) {
        child.stdin.end();
        child.kill();
      }
      error ? reject(error) : resolve(data);
    }
    function send(message) {
      if (!settled) child.stdin.write(JSON.stringify(message) + '\n');
    }
    try {
      child = spawnProcess(executable, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: codexEnvironment(environment)
      });
      child.on('error', () => finish(new Error('No se pudo iniciar Codex; comprueba su instalación.')));
      child.on('exit', () => finish(new Error('Codex terminó antes de responder.')));
      child.stdin.on('error', () => finish(new Error('Se interrumpió la conexión local con Codex.')));
      // Consume diagnostics without exposing account IDs, credentials or arbitrary provider text.
      child.stderr.on('data', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (settled) return;
        buffer += chunk;
        if (buffer.length > 1024 * 1024) return finish(new Error('Respuesta de Codex demasiado grande.'));
        let newline;
        while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1 && !initialized) {
            if (message.error || !message.result) return finish(new Error('Codex no pudo inicializar la lectura.'));
            initialized = true;
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else if (message.id === 2 && initialized) {
            if (message.error) return finish(new Error('Lectura no disponible; comprueba la sesión de Codex.'));
            try { finish(null, normalizeLimits(message.result)); }
            catch (error) { finish(error); }
          }
        }
      });
      timer = setTimeout(() => finish(new Error('Codex no respondió en el plazo de lectura.')), timeoutMs);
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'codex-local-monitor', version: '1.0.0' },
        capabilities: { experimentalApi: true }
      } });
    } catch {
      finish(new Error('No se pudo abrir el lector local de Codex.'));
    }
  });
}

module.exports = { SOURCE, normalizeLimits, findCodex, findHomeDirectory, codexEnvironment, readCodexLimits };
