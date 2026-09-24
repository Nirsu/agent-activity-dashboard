import type { TrendsPeriod, TrendsQuery, TrendsReport } from './types.js';

export interface TrendsInterval {
  start: number;
  end: number;
  day: string;
}

export interface TrendsRange {
  period: TrendsReport['period'];
  days: TrendsInterval[];
  buckets: TrendsInterval[];
}

export class InvalidTrendsQuery extends Error {}

export function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(value: string | undefined): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidTrendsQuery(
      'Custom periods require start and end dates in YYYY-MM-DD format.',
    );
  }
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || localDate(date.getTime()) !== value) {
    throw new InvalidTrendsQuery('The selected date is invalid.');
  }
  return date;
}

function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

function calendarDayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

export function resolveTrendsRange(query: TrendsQuery, now = Date.now()): TrendsRange {
  const key = query.period ?? '14d';
  const supported: TrendsPeriod[] = ['today', '7d', '14d', 'month', '30d', '90d', 'custom'];
  if (!supported.includes(key as TrendsPeriod)) {
    throw new InvalidTrendsQuery('Choose today, 7d, 14d, month, 30d, 90d or custom.');
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let startDate = new Date(today);
  let endDate = new Date(today);
  if (key === 'custom') {
    startDate = parseDate(query.start);
    endDate = parseDate(query.end);
    if (endDate.getTime() > today.getTime()) {
      throw new InvalidTrendsQuery('The end date cannot be in the future.');
    }
  } else if (key === 'month') {
    startDate.setDate(1);
  } else if (key !== 'today') {
    startDate = shiftDays(today, 1 - Number.parseInt(key, 10));
  }
  const dayCount = calendarDayNumber(endDate) - calendarDayNumber(startDate) + 1;
  if (dayCount < 1 || dayCount > 90) {
    throw new InvalidTrendsQuery('Choose a period of 1 to 90 days with the start before the end.');
  }
  const start = startDate.getTime();
  const end = Math.min(now, shiftDays(endDate, 1).getTime());
  const previousStartDate = shiftDays(startDate, -dayCount);
  const previousStart = previousStartDate.getTime();
  // Preserve the local clock position, including around daylight-saving changes.
  // A completed selection ends exactly where the current selection begins.
  const previousEnd = Math.min(start, shiftDays(new Date(end), -dayCount).getTime());
  const granularity = dayCount === 1 ? 'hour' : dayCount > 45 ? 'week' : 'day';
  const days: TrendsInterval[] = [];
  for (let index = 0; index < dayCount; index += 1) {
    const day = shiftDays(startDate, index);
    days.push({
      start: day.getTime(),
      end: Math.min(end, shiftDays(day, 1).getTime()),
      day: localDate(day.getTime()),
    });
  }
  let buckets = days;
  if (granularity === 'hour') {
    buckets = [];
    for (let timestamp = start; timestamp < end; timestamp += 3_600_000) {
      buckets.push({
        start: timestamp,
        end: Math.min(end, timestamp + 3_600_000),
        day: localDate(timestamp),
      });
    }
    if (buckets.length === 0) {
      buckets.push({ start, end, day: localDate(start) });
    }
  } else if (granularity === 'week') {
    buckets = [];
    for (let index = 0; index < days.length; index += 7) {
      buckets.push({
        start: days[index].start,
        end: days[Math.min(index + 6, days.length - 1)].end,
        day: days[index].day,
      });
    }
  }
  return {
    period: {
      key: key as TrendsPeriod,
      start,
      end,
      startDate: localDate(start),
      endDate: localDate(endDate.getTime()),
      previousStart,
      previousEnd,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      granularity,
      dayCount,
    },
    days,
    buckets,
  };
}
