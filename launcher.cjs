'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');

const children = new Set();
let shuttingDown = false;

function launch(file) {
  const child = fork(path.join(__dirname, file), [], {
    cwd: __dirname,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

if (process.platform === 'win32') launch('tray.cjs');
launch('server.cjs');

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill();
  }
  const force = setTimeout(() => {
    for (const child of children) { if (child.exitCode === null) child.kill(); }
  }, 2500);
  force.unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
