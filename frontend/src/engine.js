// Deterministic water-balance and tanker-timing engine (browser copy).
// backend/water_balance.py must stay formula-for-formula identical; run
// `python scripts/check_parity.py` after any change to either file.

export const MAX_ORDER_WINDOW_DAYS = 14;
export const MAX_FORECAST_DAYS = 14;
export const MAX_RAIN_MM_PER_DAY = 500;
export const TARGET_DAYS_OF_DEMAND = 2;

export const DEFAULT_INPUTS = {
  buildingName: 'Sample hostel',
  currentStockLiters: 8000,
  tankCapacityLiters: 10000,
  dailyConsumptionLiters: 1800,
  roofAreaM2: 120,
  collectionEfficiency: 0.8,
  leadTimeDays: 2,
  safetyStockLiters: 1800,
  latitude: 12.9716,
  longitude: 77.5946,
  forecastMm: [0, 0, 20, 10, 0, 0, 0],
};

export function localIsoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function upcomingDates(count = 7, start = new Date()) {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12);
    return localIsoDate(date);
  });
}

const NUMERIC_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

function toNumber(value, label, { allowZero = false } = {}) {
  let parsed = Number.NaN;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && NUMERIC_TEXT.test(value)) parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`${label} must be a number.`);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
  if (allowZero && parsed < 0) throw new Error(`${label} must be zero or greater.`);
  if (!allowZero && parsed <= 0) throw new Error(`${label} must be greater than zero.`);
  return parsed;
}

export function validateInputs(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Request body must be a JSON object.');
  }
  const capacity = toNumber(input.tankCapacityLiters, 'Tank capacity');
  const stock = toNumber(input.currentStockLiters, 'Current stock', { allowZero: true });
  if (stock > capacity) throw new Error('Current stock cannot exceed tank capacity.');
  const consumption = toNumber(input.dailyConsumptionLiters, 'Daily consumption');
  const roof = toNumber(input.roofAreaM2, 'Roof area', { allowZero: true });
  const efficiency = toNumber(input.collectionEfficiency, 'Collection efficiency', { allowZero: true });
  if (efficiency > 1) throw new Error('Collection efficiency must be between 0 and 1.');
  const lead = toNumber(input.leadTimeDays, 'Delivery lead time', { allowZero: true });
  if (!Number.isInteger(lead) || lead > MAX_ORDER_WINDOW_DAYS) {
    throw new Error('Delivery lead time must be a whole number from 0 to 14 days.');
  }
  const safety = toNumber(input.safetyStockLiters, 'Safety stock', { allowZero: true });
  if (safety > capacity) throw new Error('Safety stock cannot exceed tank capacity.');
  const rawRainfall = input.forecastMm ?? [];
  if (!Array.isArray(rawRainfall)) throw new Error('forecastMm must be an array of daily rainfall amounts.');
  if (rawRainfall.length > MAX_FORECAST_DAYS) throw new Error('Use no more than 14 forecast days.');
  const rainfall = rawRainfall.map((value, index) => {
    const mm = toNumber(value, `Rainfall for day ${index + 1}`, { allowZero: true });
    if (mm > MAX_RAIN_MM_PER_DAY) throw new Error(`Rainfall for day ${index + 1} must be between 0 and 500 mm.`);
    return mm;
  });
  return { capacity, stock, consumption, roof, efficiency, lead, safety, rainfall };
}

// Half-up rounding to 2 dp; written so Python produces bit-identical results.
export function round2(value) {
  return Math.floor(value * 100 + 0.5) / 100;
}

function simulateScenario(parsed, rainfall, days) {
  const { capacity, stock, consumption, roof, efficiency } = parsed;
  let water = stock;
  const timeline = [];
  for (let index = 0; index < days; index += 1) {
    const rainfallMm = index < rainfall.length ? rainfall[index] : 0;
    const stockAtStart = water;
    const stockAfterDemand = Math.max(0, stockAtStart - consumption);
    const shortage = Math.max(0, consumption - stockAtStart);
    const harvest = rainfallMm * roof * efficiency;
    const beforeCapacity = stockAfterDemand + harvest;
    const overflow = Math.max(0, beforeCapacity - capacity);
    water = Math.min(capacity, beforeCapacity);
    timeline.push({
      day: index + 1,
      rainfallMm: round2(rainfallMm),
      stockAtStartLiters: round2(stockAtStart),
      demandLiters: round2(consumption),
      stockAfterDemandLiters: round2(stockAfterDemand),
      potentialHarvestLiters: round2(harvest),
      overflowLiters: round2(overflow),
      shortageLiters: round2(shortage),
      stockAfterLiters: round2(water),
    });
  }
  return timeline;
}

function isUnsafe(day, safety) {
  return day.shortageLiters > 0 || day.stockAfterLiters < safety;
}

// Latest number of days the order can be postponed. An order placed at the
// start of day (delay + 1) arrives at the start of day (delay + lead + 1),
// before that day's demand. Every day before arrival must end at or above
// the safety stock with no unmet demand. null = not safe even if ordered now.
function latestSafeOrderDelay(parsed, rainfall) {
  if (parsed.stock < parsed.safety) return null;
  const timeline = simulateScenario(parsed, rainfall, MAX_ORDER_WINDOW_DAYS + parsed.lead);
  let latest = null;
  for (let delay = 0; delay <= MAX_ORDER_WINDOW_DAYS; delay += 1) {
    if (timeline.slice(0, delay + parsed.lead).some((day) => isUnsafe(day, parsed.safety))) break;
    latest = delay;
  }
  return latest;
}

function stockAfterDays(parsed, rainfall, days) {
  if (days === 0) return parsed.stock;
  return simulateScenario(parsed, rainfall, days)[days - 1].stockAfterLiters;
}

function firstDay(timeline, predicate) {
  const found = timeline.find(predicate);
  return found ? found.day : null;
}

function plural(n) {
  return `${n} day${n === 1 ? '' : 's'}`;
}

function windowText(deadline) {
  if (deadline === null) return 'book now and arrange a backup supply';
  if (deadline === 0) return 'book today';
  if (deadline >= MAX_ORDER_WINDOW_DAYS) return `booking can wait at least ${plural(deadline)}`;
  return `booking can wait up to ${plural(deadline)}`;
}

export function simulateWaterBalance(input) {
  const parsed = validateInputs(input);
  const forecast = parsed.rainfall;
  const noRain = forecast.map(() => 0);
  const horizonDays = Math.max(7, forecast.length, parsed.lead + 1);
  const forecastTimeline = simulateScenario(parsed, forecast, horizonDays);
  const noRainTimeline = simulateScenario(parsed, noRain, horizonDays);
  const forecastDeadline = latestSafeOrderDelay(parsed, forecast);
  const noRainDeadline = latestSafeOrderDelay(parsed, noRain);
  const forecastArrivalDay = (forecastDeadline ?? 0) + parsed.lead;
  const noRainArrivalDay = (noRainDeadline ?? 0) + parsed.lead;
  const forecastStockAtArrival = stockAfterDays(parsed, forecast, forecastArrivalDay);
  const noRainStockAtArrival = stockAfterDays(parsed, noRain, noRainArrivalDay);
  const targetStock = Math.min(parsed.capacity, parsed.safety + parsed.consumption * TARGET_DAYS_OF_DEMAND);
  const belowSafetyNow = parsed.stock < parsed.safety;
  const hasSupplyRiskBeforeDelivery = belowSafetyNow
    || forecastTimeline.slice(0, parsed.lead).some((day) => isUnsafe(day, parsed.safety));
  const sum = (timeline, key) => round2(timeline.reduce((total, day) => total + day[key], 0));

  let urgency;
  if (forecastDeadline === null) urgency = 'critical';
  else if (forecastDeadline === 0) urgency = hasSupplyRiskBeforeDelivery ? 'critical' : 'high';
  else if (forecastDeadline <= 2 || noRainDeadline === null || noRainDeadline === 0) urgency = 'high';
  else urgency = 'planned';

  let recommendation;
  if (belowSafetyNow) {
    recommendation = 'Stock is already below the safety buffer. Book a tanker now and arrange a backup supply.';
  } else if (forecastDeadline === null) {
    recommendation = 'Book now and arrange a backup supply: even a tanker ordered today arrives after the safety buffer is breached.';
  } else {
    const text = `With the rain forecast, ${windowText(forecastDeadline)}. With no rain, ${windowText(noRainDeadline)}.`;
    recommendation = text;
  }

  return {
    unit: 'litres',
    horizonDays,
    forecastTimeline,
    noRainTimeline,
    maxOrderWindowDays: MAX_ORDER_WINDOW_DAYS,
    forecastDeadlineDays: forecastDeadline,
    noRainDeadlineDays: noRainDeadline,
    forecastArrivalDay,
    noRainArrivalDay,
    forecastStockAtArrivalLiters: round2(forecastStockAtArrival),
    noRainStockAtArrivalLiters: round2(noRainStockAtArrival),
    targetStockLiters: round2(targetStock),
    estimatedTopUpLiters: round2(Math.max(0, targetStock - forecastStockAtArrival)),
    noRainEstimatedTopUpLiters: round2(Math.max(0, targetStock - noRainStockAtArrival)),
    forecastFirstBelowSafetyDay: firstDay(forecastTimeline, (day) => isUnsafe(day, parsed.safety)),
    noRainFirstBelowSafetyDay: firstDay(noRainTimeline, (day) => isUnsafe(day, parsed.safety)),
    forecastFirstShortageDay: firstDay(forecastTimeline, (day) => day.shortageLiters > 0),
    noRainFirstShortageDay: firstDay(noRainTimeline, (day) => day.shortageLiters > 0),
    forecastPotentialCaptureLiters: sum(forecastTimeline, 'potentialHarvestLiters'),
    forecastOverflowLiters: sum(forecastTimeline, 'overflowLiters'),
    belowSafetyNow,
    hasSupplyRiskBeforeDelivery,
    urgency,
    recommendation,
    notes: NOTES,
  };
}

export const NOTES = [
  'Potential capture (L) = rainfall (mm) x roof area (m2) x collection efficiency.',
  'Each day, demand is subtracted before rain capture is added, then stock is capped at tank capacity.',
  'An order placed on a day arrives lead-time days later, before that day\'s use.',
  'Estimated top-up = target stock (safety stock + 2 days of demand, capped at capacity) minus projected stock on arrival if booked on the latest safe day. Not a supplier tanker size.',
  'The no-rain scenario is a stress test, not a prediction. Collected rain is not assumed to be potable.',
];
