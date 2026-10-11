import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRainForecast, FORECAST_DAYS } from './api.js';

// Replace global fetch for one test; restores the original afterwards.
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const dates = (n) => Array.from({ length: n }, (_, i) => `2026-10-${String(11 + i).padStart(2, '0')}`);
const okJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('requests a 14-day daily precipitation forecast', async () => {
  let requested;
  await withFetch(async (url) => {
    requested = new URL(String(url));
    return okJson({ daily: { time: dates(14), precipitation_sum: Array(14).fill(0) }, timezone: 'Asia/Kolkata' });
  }, async () => {
    const result = await fetchRainForecast(12.97, 77.59);
    assert.equal(result.rainfallMm.length, 14);
    assert.equal(result.timezone, 'Asia/Kolkata');
  });
  assert.equal(FORECAST_DAYS, 14);
  assert.equal(requested.searchParams.get('forecast_days'), '14');
  assert.equal(requested.searchParams.get('daily'), 'precipitation_sum');
  assert.equal(requested.searchParams.get('timezone'), 'auto');
  assert.equal(requested.hostname, 'api.open-meteo.com');
});

test('null and negative precipitation values become 0 mm and missing days are counted', async () => {
  const rain = [null, -0.4, 3.2, ...Array(11).fill(0)];
  await withFetch(async () => okJson({ daily: { time: dates(14), precipitation_sum: rain } }), async () => {
    const result = await fetchRainForecast(1, 1);
    assert.equal(result.rainfallMm[0], 0);
    assert.equal(result.rainfallMm[1], 0);
    assert.equal(result.rainfallMm[2], 3.2);
    assert.equal(result.missingDays, 1);
  });
});

test('Open-Meteo error responses surface the provider reason', async () => {
  await withFetch(async () => okJson({ error: true, reason: 'Parameter latitude is out of range' }, 400), async () => {
    await assert.rejects(fetchRainForecast(999, 1), /HTTP 400: Parameter latitude is out of range/);
  });
});

test('a non-JSON error page still gives a clear HTTP status message', async () => {
  await withFetch(async () => new Response('<html>Bad gateway</html>', { status: 502 }), async () => {
    await assert.rejects(fetchRainForecast(1, 1), /Open-Meteo returned HTTP 502$/);
  });
});

test('a malformed success body is rejected with a clear message', async () => {
  await withFetch(async () => new Response('not json', { status: 200 }), async () => {
    await assert.rejects(fetchRainForecast(1, 1), /could not be read/);
  });
  await withFetch(async () => okJson({ daily: { time: dates(7) } }), async () => {
    await assert.rejects(fetchRainForecast(1, 1), /did not return daily precipitation/);
  });
});

test('more than 14 days is rejected instead of silently truncated', async () => {
  await withFetch(async () => okJson({ daily: { time: dates(15), precipitation_sum: Array(15).fill(0) } }), async () => {
    await assert.rejects(fetchRainForecast(1, 1), /expected at most 14/);
  });
});

test('a network failure is reported without throwing an unhandled error', async () => {
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(fetchRainForecast(1, 1), /network error/);
  });
});
