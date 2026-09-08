'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createTrayClient } = require('./tray-client.cjs');

if (process.platform !== 'win32') {
  console.error('La bandeja solo está disponible en Windows.');
  process.exitCode = 1;
} else {
  const port = Number(process.env.PORT || 47831);
  const baseUrl = `http://127.0.0.1:${port}`;
  const probe = process.argv.includes('--probe');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const bundledPowerShell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const powerShell = fs.existsSync(bundledPowerShell) ? bundledPowerShell : 'powershell.exe';
  const mutexName = probe ? `Local\\CodexLimitsMonitorTrayProbe-${process.pid}` : 'Local\\CodexLimitsMonitorTray';
  const host = spawn(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File',
    path.join(__dirname, 'tray-host.ps1'), '-MonitorUrl', baseUrl, '-MutexName', mutexName], {
    cwd: __dirname, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let hostReady = false;
  let stateApplied = false;
  let connected = false;
  let shuttingDown = false;
  let stderr = '';
  if (probe) console.log(JSON.stringify({ event: 'probe-start', baseUrl, mutexName }));

  function send(message) {
    if (host.stdin.writable) host.stdin.write(JSON.stringify(message) + '\n');
  }
  const client = createTrayClient({ baseUrl, onPresentation(presentation) {
    connected = presentation.connected;
    if (probe) console.log(JSON.stringify({ event: 'probe-presentation', ...presentation }));
    send({ type: 'state', color: presentation.color, tooltip: presentation.tooltip });
  } });
  client.start();

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    client.stop();
    send({ type: 'exit' });
    const force = setTimeout(() => { if (host.exitCode === null) host.kill(); }, 2000);
    force.unref?.();
  }
  function finishProbe() {
    if (!probe || !hostReady || !stateApplied || !connected || shuttingDown) return;
    console.log(JSON.stringify({ event: 'tray-probe-pass', baseUrl, connected: true }));
    shutdown();
  }

  readline.createInterface({ input: host.stdout }).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (probe) console.log(JSON.stringify({ event: 'probe-host-event', hostEvent: event.event,
      color: event.color || null }));
    if (event.event === 'ready') {
      hostReady = true;
      finishProbe();
    } else if (event.event === 'state-applied') {
      stateApplied = true;
      finishProbe();
    } else if (event.event === 'refresh') {
      void client.refresh().catch(() => {});
    } else if (event.event === 'exit') {
      shutdown();
    } else if (event.event === 'duplicate') {
      if (probe) console.error('Ya existe un cliente de bandeja activo.');
    }
  });
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  host.on('error', error => { console.error(`No se pudo iniciar la bandeja: ${error.message}`); });
  host.on('exit', code => {
    client.stop();
    if (probe) console.log(JSON.stringify({ event: 'probe-host-exit', code, stderr: stderr.trim() }));
    if (!shuttingDown && code !== 0) {
      console.error(`La bandeja terminó con código ${code}.${stderr ? ' ' + stderr.trim() : ''}`);
      process.exitCode = 1;
    }
  });
  if (probe) {
    const timeout = setTimeout(() => {
      if (!shuttingDown) {
        console.error('La comprobación de bandeja no recibió estado válido a tiempo.');
        process.exitCode = 1;
        shutdown();
      }
    }, 30000);
    timeout.unref?.();
  }
  process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
