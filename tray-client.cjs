'use strict';

const OFFLINE_PRESENTATION = Object.freeze({
  color: 'gray',
  tooltip: 'Codex 5H: sin datos',
  connected: false
});

function retryDelay(failureCount, maximumMs = 30000) {
  return Math.min(maximumMs, 1000 * (2 ** Math.max(0, failureCount - 1)));
}

function presentationFromState(state) {
  const status = state?.fiveHourStatus;
  if (!status || !['gray', 'green', 'yellow', 'red'].includes(status.color)
    || typeof status.tooltip !== 'string') return OFFLINE_PRESENTATION;
  return { color: status.color, tooltip: status.tooltip, connected: true };
}

function createTrayClient({ baseUrl, fetchImpl = globalThis.fetch, onPresentation = () => {},
  schedule = setTimeout, cancel = clearTimeout, pollMs = 5000, timeoutMs = 5000 } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl || '')) throw new Error('URL local no válida.');
  if (typeof fetchImpl !== 'function') throw new Error('Este cliente requiere fetch.');
  let stopped = true;
  let timer = null;
  let failures = 0;

  function schedulePoll(delay) {
    if (stopped) return;
    if (timer !== null) cancel(timer);
    timer = schedule(() => { timer = null; void pollNow(); }, delay);
    timer?.unref?.();
  }

  async function request(pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(baseUrl + pathname, {
        ...options,
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json', ...options.headers }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function pollNow() {
    try {
      const state = await request('/api/limits');
      failures = 0;
      onPresentation(presentationFromState(state));
      schedulePoll(pollMs);
      return state;
    } catch (error) {
      failures += 1;
      onPresentation(OFFLINE_PRESENTATION);
      schedulePoll(retryDelay(failures));
      throw error;
    }
  }

  async function refresh() {
    try {
      const state = await request('/api/refresh', {
        method: 'POST', headers: { 'X-Monitor-Request': '1' }
      });
      failures = 0;
      onPresentation(presentationFromState(state));
      schedulePoll(pollMs);
      return state;
    } catch (error) {
      failures += 1;
      onPresentation(OFFLINE_PRESENTATION);
      schedulePoll(retryDelay(failures));
      throw error;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void pollNow().catch(() => {});
  }

  function stop() {
    stopped = true;
    if (timer !== null) cancel(timer);
    timer = null;
  }

  return { start, stop, pollNow, refresh };
}

module.exports = { OFFLINE_PRESENTATION, retryDelay, presentationFromState, createTrayClient };
