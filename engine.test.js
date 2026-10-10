import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INPUTS, round2, simulateWaterBalance, validateInputs } from './engine.js';

const BASE = { ...DEFAULT_INPUTS };
const run = (overrides) => simulateWaterBalance({ ...BASE, ...overrides });

test('1 mm rain on 1 m² at 100% efficiency gives 1 litre', () => {
  const r = run({ currentStockLiters: 100, tankCapacityLiters: 1000, dailyConsumptionLiters: 50, roofAreaM2: 1, collectionEfficiency: 1, safetyStockLiters: 0, leadTimeDays: 0, forecastMm: [1] });
  assert.equal(r.forecastTimeline[0].potentialHarvestLiters, 1);
  assert.equal(r.forecastTimeline[0].stockAfterLiters, 51);
});

test('demand is subtracted before rain is added; shortage tracked separately', () => {
  const day = run({ currentStockLiters: 50, tankCapacityLiters: 1000, dailyConsumptionLiters: 100, roofAreaM2: 100, collectionEfficiency: 1, safetyStockLiters: 0, leadTimeDays: 0, forecastMm: [1] }).forecastTimeline[0];
  assert.equal(day.shortageLiters, 50);
  assert.equal(day.stockAfterLiters, 100);
});

test('heavy rain is capped by tank capacity and overflow is explicit', () => {
  const day = run({ currentStockLiters: 900, tankCapacityLiters: 1000, dailyConsumptionLiters: 100, roofAreaM2: 100, collectionEfficiency: 1, safetyStockLiters: 0, leadTimeDays: 0, forecastMm: [10] }).forecastTimeline[0];
  assert.equal(day.stockAfterLiters, 1000);
  assert.equal(day.overflowLiters, 800);
});

test('known answer: sample hostel', () => {
  const r = run({});
  assert.equal(r.forecastDeadlineDays, 3);
  assert.equal(r.noRainDeadlineDays, 1);
  assert.equal(r.forecastArrivalDay, 5);
  assert.equal(r.forecastStockAtArrivalLiters, 1880);
  assert.equal(r.targetStockLiters, 5400);
  assert.equal(r.estimatedTopUpLiters, 3520);
  assert.equal(r.noRainEstimatedTopUpLiters, 2800);
  assert.equal(r.forecastFirstBelowSafetyDay, 6);
  assert.equal(r.noRainFirstBelowSafetyDay, 4);
  assert.equal(r.forecastPotentialCaptureLiters, 2880);
});

test('lead time zero: order can wait until the day stock would breach the buffer', () => {
  const r = run({ leadTimeDays: 0, forecastMm: [0, 0, 0, 0, 0, 0, 0] });
  // 8000 → 6200 → 4400 → 2600 → 800: day 4 breaches 1800, so booking can wait 3 days.
  assert.equal(r.forecastDeadlineDays, 3);
  assert.equal(r.forecastArrivalDay, 3);
  assert.equal(r.forecastStockAtArrivalLiters, 2600);
});

test('water already below reserve is critical even with zero lead time and rain', () => {
  const r = run({ currentStockLiters: 1000, leadTimeDays: 0, forecastMm: [50, 0, 0] });
  assert.equal(r.forecastDeadlineDays, null);
  assert.equal(r.belowSafetyNow, true);
  assert.equal(r.urgency, 'critical');
});

test('safety buffer above current stock is critical', () => {
  const r = run({ currentStockLiters: 3000, safetyStockLiters: 4000 });
  assert.equal(r.forecastDeadlineDays, null);
  assert.equal(r.noRainDeadlineDays, null);
  assert.match(r.recommendation, /already below the safety buffer/);
});

test('empty forecast is treated as no rain and equals the no-rain scenario', () => {
  const r = run({ forecastMm: [] });
  assert.deepEqual(r.forecastTimeline, r.noRainTimeline);
  assert.equal(r.forecastDeadlineDays, r.noRainDeadlineDays);
});

test('rain extends the order window while the no-rain stress test stays visible', () => {
  const r = run({});
  assert.ok(r.forecastDeadlineDays > r.noRainDeadlineDays);
  assert.ok(r.noRainTimeline.every((d) => d.potentialHarvestLiters === 0));
});

test('extreme rain caps stock at capacity and hits the 14-day window cap', () => {
  const r = run({ forecastMm: Array(14).fill(500) });
  assert.ok(r.forecastTimeline.every((d) => d.stockAfterLiters <= BASE.tankCapacityLiters));
  assert.ok(r.forecastOverflowLiters > 0);
  assert.equal(r.forecastDeadlineDays, 14);
  assert.match(r.recommendation, /at least 14 days/);
});

test('demand exceeding stock creates unmet demand, never negative stock', () => {
  const r = run({ currentStockLiters: 900, safetyStockLiters: 0, forecastMm: [] });
  assert.equal(r.forecastTimeline[0].shortageLiters, 900);
  assert.ok(r.forecastTimeline.every((d) => d.stockAfterLiters >= 0));
  assert.equal(r.forecastFirstShortageDay, 1);
  assert.equal(r.forecastDeadlineDays, null);
});

test('rounding is half-up to 2 dp', () => {
  assert.equal(round2(0.125), 0.13);
  assert.equal(round2(1.004), 1);
  assert.equal(round2(1800), 1800);
});

for (const [name, overrides, pattern] of [
  ['stock above capacity', { currentStockLiters: 11000 }, /cannot exceed tank capacity/],
  ['negative rain', { forecastMm: [0, -1] }, /Rainfall for day 2 must be zero or greater/],
  ['efficiency above 1', { collectionEfficiency: 1.4 }, /between 0 and 1/],
  ['negative efficiency', { collectionEfficiency: -0.1 }, /zero or greater/],
  ['fractional lead time', { leadTimeDays: 1.5 }, /whole number from 0 to 14/],
  ['lead time above 14', { leadTimeDays: 15 }, /whole number from 0 to 14/],
  ['safety above capacity', { safetyStockLiters: 20000 }, /Safety stock cannot exceed/],
  ['blank daily usage', { dailyConsumptionLiters: '' }, /Daily consumption must be a number/],
  ['zero daily usage', { dailyConsumptionLiters: 0 }, /greater than zero/],
  ['too many forecast days', { forecastMm: Array(15).fill(0) }, /no more than 14/],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateInputs({ ...BASE, ...overrides }), pattern);
  });
}
