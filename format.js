const intFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const oneFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });

export const fmt = (value) => intFormat.format(Math.round(Number(value) || 0));
export const fmtOne = (value) => oneFormat.format(Number(value) || 0);
export const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

function parseIso(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12);
}

// Date of day `offset` (0-based) counted from the first forecast date.
export function dateAt(dates, offset) {
  const base = parseIso(dates?.[0]);
  if (!base) return null;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12);
}

export function shortDate(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}

export function relativeDay(offset) {
  if (offset === 0) return 'today';
  if (offset === 1) return 'tomorrow';
  return `in ${days(offset)}`;
}

export function dayLabel(dates, offset) {
  return shortDate(dateAt(dates, offset)) || `Day ${offset + 1}`;
}
