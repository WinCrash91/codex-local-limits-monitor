'use strict';

const { fork, execFile } = require('node:child_process');
const path = require('node:path');

function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    // Kill descendants before their parent can exit and leave them orphaned.
    return new Promise((resolve, reject) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && child.exitCode === null && child.signalCode === null) reject(error);
        else resolve();
      });
    });
  }
  return new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
}

function createLauncher({ forkProcess = fork, stopProcess = stopTree, platform = process.platform } = {}) {
  const children = new Set();
  let shuttingDown = false;
  let restarting = false;
  let server;
  const stopping = new Map();

  function stop(child) {
    if (!stopping.has(child)) stopping.set(child, stopProcess(child).finally(() => stopping.delete(child)));
    return stopping.get(child);
  }

  function launch(file) {
    const child = forkProcess(path.join(__dirname, file), [], {
      cwd: __dirname, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    children.add(child);
    child.on('exit', () => children.delete(child));
    return child;
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // Keep the tray available if stopping the server fails.
      await stop(server);
      for (const child of children) {
        if (child !== server) await stop(child);
      }
    } catch (error) {
      shuttingDown = false;
      console.error(`No se pudo cerrar el monitor: ${error.message}`);
    }
  }

  async function restart() {
    if (shuttingDown || restarting) return;
    restarting = true;
    try {
      await stop(server);
      if (!shuttingDown) server = launch('server.cjs');
    } catch (error) {
      console.error(`No se pudo reiniciar el servidor: ${error.message}`);
    } finally {
      restarting = false;
    }
  }

  server = launch('server.cjs');
  if (platform === 'win32') {
    launch('tray.cjs').on('message', message => {
      if (message?.type === 'shutdown') void shutdown();
      else if (message?.type === 'restart') void restart();
    });
  }
  return { shutdown, restart };
}

if (require.main === module) {
  const launcher = createLauncher();
  process.on('SIGINT', launcher.shutdown);
  process.on('SIGTERM', launcher.shutdown);
}

module.exports = { createLauncher, stopTree };
