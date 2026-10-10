export const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export function apiRegion(url = API_BASE_URL) {
  const match = /execute-api\.([a-z0-9-]+)\.amazonaws\.com/.exec(url);
  return match ? match[1] : '';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? 'request timed out' : 'network error (service unreachable)');
  } finally {
    clearTimeout(timer);
  }
}

// Returns { ok, status, data, ms }. Throws only on network failure / timeout.
export async function apiRequest(path, { method = 'GET', body, timeoutMs = 12000 } = {}) {
  const started = performance.now();
  const response = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, timeoutMs);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { ok: response.ok, status: response.status, data, ms: Math.round(performance.now() - started) };
}

export async function fetchRainForecast(latitude, longitude) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: 'precipitation_sum',
    forecast_days: '7',
    timezone: 'auto',
  }).toString();
  const response = await fetchWithTimeout(url, {}, 10000);
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);
  const body = await response.json();
  const rainfall = body?.daily?.precipitation_sum;
  const dates = body?.daily?.time;
  if (!Array.isArray(rainfall) || !Array.isArray(dates) || rainfall.length === 0 || rainfall.length !== dates.length) {
    throw new Error('Open-Meteo did not return daily precipitation');
  }
  const missing = rainfall.filter((value) => value === null || value === undefined).length;
  return {
    rainfallMm: rainfall.map((value) => Math.max(0, Number(value) || 0)),
    dates,
    missingDays: missing,
    timezone: body.timezone || '',
  };
}
