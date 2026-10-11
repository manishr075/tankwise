export const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export function apiRegion(url = API_BASE_URL) {
  const match = /execute-api\.([a-z0-9-]+)\.amazonaws\.com/.exec(url);
  return match ? match[1] : '';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = options.signal; // caller-supplied cancellation (e.g. a superseded calculation)
  const cancel = () => controller.abort();
  if (external?.aborted) controller.abort();
  external?.addEventListener('abort', cancel);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (external?.aborted) throw new Error('request cancelled');
    throw new Error(error.name === 'AbortError' ? 'request timed out' : 'network error (service unreachable)');
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', cancel);
  }
}

// Returns { ok, status, data, ms }. Throws only on network failure / timeout.
export async function apiRequest(path, { method = 'GET', body, timeoutMs = 12000, signal } = {}) {
  const started = performance.now();
  const response = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  }, timeoutMs);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { ok: response.ok, status: response.status, data, ms: Math.round(performance.now() - started) };
}

export const FORECAST_DAYS = 14;

// Open-Meteo returns 400 with a { error, reason } body for bad parameters;
// surface that reason instead of a bare status code.
async function openMeteoError(response) {
  try {
    const body = await response.json();
    if (body?.reason) return `Open-Meteo returned HTTP ${response.status}: ${body.reason}`;
  } catch { /* body is not JSON */ }
  return `Open-Meteo returned HTTP ${response.status}`;
}

export async function fetchRainForecast(latitude, longitude) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: 'precipitation_sum',
    forecast_days: String(FORECAST_DAYS),
    timezone: 'auto',
  }).toString();
  const response = await fetchWithTimeout(url, {}, 10000);
  if (!response.ok) throw new Error(await openMeteoError(response));
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Open-Meteo returned a response that could not be read');
  }
  const rainfall = body?.daily?.precipitation_sum;
  const dates = body?.daily?.time;
  if (!Array.isArray(rainfall) || !Array.isArray(dates) || rainfall.length === 0 || rainfall.length !== dates.length) {
    throw new Error('Open-Meteo did not return daily precipitation');
  }
  if (rainfall.length > FORECAST_DAYS) {
    throw new Error(`Open-Meteo returned ${rainfall.length} days; expected at most ${FORECAST_DAYS}`);
  }
  const missing = rainfall.filter((value) => value === null || value === undefined).length;
  return {
    rainfallMm: rainfall.map((value) => Math.max(0, Number(value) || 0)),
    dates,
    missingDays: missing,
    timezone: body.timezone || '',
  };
}
