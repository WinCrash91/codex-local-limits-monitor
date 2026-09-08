'use strict';

(() => {
  const panel = document.querySelector('.monitor');
  const five = document.getElementById('five');
  const week = document.getElementById('week');
  const fiveForecast = document.getElementById('five-forecast');
  const weekForecast = document.getElementById('week-forecast');
  const fiveReset = document.getElementById('five-reset');
  const weekReset = document.getElementById('week-reset');
  const fivePath = document.getElementById('five-path');
  const weekPath = document.getElementById('week-path');
  const weeklyTheoryPath = document.getElementById('weekly-theory-path');
  const chartEmpty = document.getElementById('chart-empty');
  const age = document.getElementById('age');
  const status = document.getElementById('status');
  const button = document.getElementById('refresh');
  let state = null;
  let disconnected = false;
  let manualPending = false;
  // Backend data retains Codex precision. This formatter is the only rounding boundary.
  const pct = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  // Intl does not permit dateStyle together with individual hour fields.
  // Specify the parts so the weekly forecast intentionally omits minutes.
  const hourDate = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', hourCycle: 'h23'
  });
  const WEEKLY_DURATION_MS = 10080 * 60 * 1000;

  function resetText(resetsAt) {
    return resetsAt ? date.format(new Date(resetsAt)) : 'No disponible';
  }

  function updateTabSemaphore(fiveHourStatus) {
    const signals = { gray: '⚪', green: '🟢', yellow: '🟡', red: '🔴' };
    const signal = signals[fiveHourStatus?.color] || signals.gray;
    document.title = `${signal} Monitor de límites Codex`;
  }

  // The weekly window starts at 100% remaining. Its observed consumption rate
  // is therefore (100 - current remaining) divided by elapsed time since start.
  // This deliberately does not use the short chart history.
  function estimateWeeklyExhaustion(latest, timestamp = Date.now()) {
    const reset = Date.parse(latest?.weekly?.resetsAt);
    const remaining = latest?.weekly?.remainingPercent;
    if (!Number.isFinite(reset) || !Number.isFinite(remaining)) return null;
    if (remaining <= 0) return timestamp;
    const periodStart = reset - WEEKLY_DURATION_MS;
    const elapsedMinutes = (timestamp - periodStart) / 60000;
    const consumed = 100 - remaining;
    if (elapsedMinutes <= 0 || consumed <= 0) return Infinity;
    return timestamp + (remaining / (consumed / elapsedMinutes)) * 60000;
  }

  const CHART_WINDOW_MS = 120 * 60 * 1000;
  const CHART_LEFT = 48;
  const CHART_WIDTH = 652;

  function chartPoint(timestamp, value, start, end) {
    const x = CHART_LEFT + Math.max(0, Math.min(1, (timestamp - start) / (end - start))) * CHART_WIDTH;
    const y = 200 - Math.max(0, Math.min(100, value)) / 100 * 180;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }

  function drawPath(history, field, start, end) {
    const points = history.filter(sample => Number.isFinite(sample[field]) && Number.isFinite(Date.parse(sample.collectedAt)))
      .map(sample => chartPoint(Date.parse(sample.collectedAt), sample[field], start, end));
    return points.length ? `M ${points.join(' L ')}` : '';
  }

  // This is not a usage forecast. It reconstructs the remaining percentage
  // that a perfectly linear weekly consumption would have at each instant:
  // 100% at the weekly reset start and 0% at its next reset.
  function drawWeeklyTheory(latest, start, end) {
    const reset = Date.parse(latest?.weekly?.resetsAt);
    if (!Number.isFinite(reset)) return '';
    const linearRemaining = timestamp => 100 * (reset - timestamp) / WEEKLY_DURATION_MS;
    return `M ${chartPoint(start, linearRemaining(start), start, end)} L ${chartPoint(end, linearRemaining(end), start, end)}`;
  }

  function drawChart() {
    const history = state?.history || [];
    const end = Date.now();
    const start = end - CHART_WINDOW_MS;
    fivePath.setAttribute('d', drawPath(history, 'fiveHourRemainingPercent', start, end));
    weekPath.setAttribute('d', drawPath(history, 'weeklyRemainingPercent', start, end));
    weeklyTheoryPath.setAttribute('d', drawWeeklyTheory(state?.latest, start, end));
    // `hidden` is unreliable on SVG text in some Chromium builds. Set the
    // SVG presentation property directly so the placeholder cannot overlap a
    // chart that already has enough samples.
    chartEmpty.style.display = history.length >= 2 ? 'none' : '';
  }

  function paint() {
    const latest = state?.latest;
    const ageMs = latest ? Math.max(0, Date.now() - Date.parse(latest.collectedAt)) : null;
    const expired = ageMs !== null && ageMs > state.pollIntervalMs * 2;
    const unavailable = disconnected || state?.status === 'unavailable';
    panel.dataset.status = unavailable ? 'unavailable' : expired ? 'stale' : state?.status || 'waiting';
    five.textContent = latest ? pct.format(latest.fiveHour.remainingPercent) + ' %' : '—';
    week.textContent = latest ? pct.format(latest.weekly.remainingPercent) + ' %' : '—';
    fiveReset.textContent = latest ? resetText(latest.fiveHour.resetsAt) : '—';
    weekReset.textContent = latest ? resetText(latest.weekly.resetsAt) : '—';
    const fiveStatus = state?.fiveHourStatus;
    if (fiveStatus?.projection === 'paused') fiveForecast.textContent = 'En pausa';
    else if (fiveStatus?.projection === 'minutes') fiveForecast.textContent = `≈ ${fiveStatus.estimatedMinutes} min hasta agotarse`;
    else fiveForecast.textContent = 'Sin proyección';
    const weeklyExhaustion = estimateWeeklyExhaustion(latest);
    if (weeklyExhaustion === null) weekForecast.textContent = 'Sin datos para estimar';
    else if (weeklyExhaustion === Infinity) weekForecast.textContent = 'En pausa';
    else weekForecast.textContent = `≈ ${hourDate.format(new Date(Math.round(weeklyExhaustion / 3600000) * 3600000))}`;
    age.textContent = ageMs === null ? 'Sin lectura' : Math.floor(ageMs / 60000) + ' min';
    age.title = latest ? 'Última lectura correcta: ' + date.format(new Date(latest.collectedAt)) : 'Todavía no hay datos';
    for (const [el, value] of [[five, latest?.fiveHour], [week, latest?.weekly]]) {
      el.title = value ? `${pct.format(value.usedPercent)} % usado${value.resetsAt ? ' · Reinicio: ' + date.format(new Date(value.resetsAt)) : ''}` : '';
    }
    // A broken connection must not leave the recovery button permanently disabled.
    button.disabled = manualPending || (!disconnected && !!state?.refreshing);
    if (unavailable) status.textContent = latest ? 'lectura no disponible · se conservan los últimos datos' : 'lectura no disponible · sin datos anteriores';
    else if (expired) status.textContent = 'Datos pendientes de actualización';
    else if (state?.refreshing) status.textContent = 'Actualizando…';
    else if (latest) status.textContent = 'Lectura correcta · refresco automático cada 30 s';
    else status.textContent = 'Esperando la primera lectura…';
    updateTabSemaphore(fiveStatus);
    drawChart();
  }

  async function request(url, options) {
    const response = await fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Lectura no disponible');
    state = await response.json();
    disconnected = false;
    paint();
  }
  button.addEventListener('click', async () => {
    manualPending = true;
    paint();
    try { await request('/api/refresh', { method: 'POST', headers: { 'X-Monitor-Request': '1' } }); }
    catch { disconnected = true; }
    finally { manualPending = false; paint(); }
  });
  const events = new EventSource('/api/events');
  events.onmessage = event => {
    try { state = JSON.parse(event.data); disconnected = false; paint(); }
    catch { disconnected = true; paint(); }
  };
  events.onerror = () => { disconnected = true; paint(); };
  void request('/api/limits').catch(() => { disconnected = true; paint(); });
  setInterval(paint, 1000);
})();
