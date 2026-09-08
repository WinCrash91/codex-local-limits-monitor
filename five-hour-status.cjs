'use strict';

const TWO_MINUTES_MS = 2 * 60 * 1000;
const TOOLTIP_MAX_LENGTH = 63;

function fiveHourFallRatePerHour(history, latest) {
  if (!latest || !Array.isArray(history) || history.length < 2) return null;
  const end = Date.parse(latest.collectedAt);
  if (!Number.isFinite(end)) return null;
  const start = end - TWO_MINUTES_MS;
  const samples = history.filter(sample => {
    const timestamp = Date.parse(sample?.collectedAt);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end
      && Number.isFinite(sample?.fiveHourRemainingPercent);
  }).sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsedMinutes = (Date.parse(last.collectedAt) - Date.parse(first.collectedAt)) / 60000;
  const fallen = first.fiveHourRemainingPercent - last.fiveHourRemainingPercent;
  if (elapsedMinutes < 1 || fallen < 0) return null;
  return fallen / elapsedMinutes * 60;
}

function colorForRate(ratePerHour) {
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return 'gray';
  if (ratePerHour < 33) return 'green';
  if (ratePerHour <= 50) return 'yellow';
  return 'red';
}

function estimateFiveHourExhaustion(ratePerHour, remainingPercent) {
  if (ratePerHour === null || !Number.isFinite(remainingPercent)) return null;
  if (remainingPercent <= 0) return 0;
  if (ratePerHour === 0) return Infinity;
  if (!Number.isFinite(ratePerHour) || ratePerHour < 0) return null;
  return remainingPercent / (ratePerHour / 60);
}

function limitTooltip(text) {
  return text.length <= TOOLTIP_MAX_LENGTH ? text : text.slice(0, TOOLTIP_MAX_LENGTH);
}

function buildFiveHourStatus(history, latest, locale = 'es-ES') {
  const remainingPercent = latest?.fiveHour?.remainingPercent;
  if (!Number.isFinite(remainingPercent)) {
    return { color: 'gray', ratePerHour: null, projection: 'no-data', estimatedMinutes: null,
      tooltip: 'Codex 5H: sin datos' };
  }
  const ratePerHour = fiveHourFallRatePerHour(history, latest);
  const estimate = estimateFiveHourExhaustion(ratePerHour, remainingPercent);
  let projection;
  let estimatedMinutes = null;
  let projectionText;
  if (estimate === null) {
    projection = 'insufficient';
    projectionText = 'Sin proyección';
  } else if (estimate === Infinity) {
    projection = 'paused';
    projectionText = 'En pausa';
  } else {
    projection = 'minutes';
    estimatedMinutes = Math.max(0, Math.round(estimate));
    projectionText = `≈ ${estimatedMinutes} min`;
  }
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(remainingPercent);
  return {
    color: colorForRate(ratePerHour), ratePerHour, projection, estimatedMinutes,
    tooltip: limitTooltip(`Codex 5H: ${formatted} % restante · ${projectionText}`)
  };
}

module.exports = { TOOLTIP_MAX_LENGTH, fiveHourFallRatePerHour, colorForRate,
  estimateFiveHourExhaustion, buildFiveHourStatus };
