// Lightweight 5-field cron parser. No npm dependencies.

export interface CronFields {
  minute: number[] | null; // null = wildcard
  hour: number[] | null;
  dayOfMonth: number[] | null;
  month: number[] | null;
  dayOfWeek: number[] | null; // 0=Sunday, 1=Monday, ... 6=Saturday
}

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

function parseField(field: string, [min, max]: [number, number]): number[] | null {
  if (field === '*') return null;

  // Step: */N or M-N/S
  if (field.includes('/')) {
    const [rangePart, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${field}`);
    const start = rangePart === '*' ? min : parseInt(rangePart, 10);
    const values: number[] = [];
    for (let i = start; i <= max; i += step) values.push(i);
    return values;
  }

  // Comma-separated: 1,3,5
  if (field.includes(',')) {
    return field.split(',').map((v) => {
      const n = parseInt(v.trim(), 10);
      if (isNaN(n) || n < min || n > max) throw new Error(`Value ${v} out of range [${min},${max}]`);
      return n;
    });
  }

  // Range: 9-17
  if (field.includes('-')) {
    const [startStr, endStr] = field.split('-');
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid range: ${field}`);
    }
    const values: number[] = [];
    for (let i = start; i <= end; i++) values.push(i);
    return values;
  }

  // Single value
  const n = parseInt(field, 10);
  if (isNaN(n) || n < min || n > max) throw new Error(`Value ${field} out of range [${min},${max}]`);
  return [n];
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expression}"`);

  return {
    minute: parseField(parts[0], FIELD_RANGES[0]),
    hour: parseField(parts[1], FIELD_RANGES[1]),
    dayOfMonth: parseField(parts[2], FIELD_RANGES[2]),
    month: parseField(parts[3], FIELD_RANGES[3]),
    dayOfWeek: parseField(parts[4], FIELD_RANGES[4]),
  };
}

/** Calculate the next run time after `afterUnix` (UTC unix seconds). Returns UTC unix seconds. */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Find the next unix time (seconds) matching a cron expression after `afterUnix`.
 *
 * `timeZone` is an IANA zone (e.g. 'America/New_York'); the cron fields are matched
 * against the wall-clock time in that zone, so a "daily 9am" cron fires at the
 * user's local 9am and stays correct across DST transitions. The default 'UTC'
 * preserves the original UTC behavior for every non-timezone-aware caller.
 */
export function nextCronRun(expression: string, afterUnix: number, timeZone: string = 'UTC'): number {
  const fields = parseCron(expression);
  // Start from the next minute after `afterUnix`
  const start = new Date((afterUnix + 60) * 1000);
  start.setUTCSeconds(0, 0);

  // Brute-force search forward, minute by minute, capped at 366 days
  const maxIterations = 366 * 24 * 60;
  const cursor = new Date(start);

  // For a non-UTC zone, extract wall-clock parts via a single reused Intl formatter
  // (formatToParts maps the UTC instant -> local time, which is inherently DST-aware).
  const fmt = timeZone !== 'UTC'
    ? new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      })
    : null;

  for (let i = 0; i < maxIterations; i++) {
    let minute: number;
    let hour: number;
    let dayOfMonth: number;
    let month: number;
    let dayOfWeek: number;

    if (fmt) {
      const parts = fmt.formatToParts(cursor);
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((p) => p.type === type)?.value ?? '';
      minute = Number(part('minute'));
      hour = Number(part('hour')) % 24; // h23 yields 00-23; guard a stray 24 -> 0
      dayOfMonth = Number(part('day'));
      month = Number(part('month'));
      dayOfWeek = WEEKDAY_INDEX[part('weekday')] ?? cursor.getUTCDay();
    } else {
      minute = cursor.getUTCMinutes();
      hour = cursor.getUTCHours();
      dayOfMonth = cursor.getUTCDate();
      month = cursor.getUTCMonth() + 1; // JS months are 0-based
      dayOfWeek = cursor.getUTCDay();
    }

    const matchMinute = fields.minute === null || fields.minute.includes(minute);
    const matchHour = fields.hour === null || fields.hour.includes(hour);
    const matchMonth = fields.month === null || fields.month.includes(month);
    const matchDom = fields.dayOfMonth === null || fields.dayOfMonth.includes(dayOfMonth);
    const matchDow = fields.dayOfWeek === null || fields.dayOfWeek.includes(dayOfWeek);

    // Standard cron day-field semantics: when BOTH day-of-month and day-of-week
    // are restricted (neither is '*'), the day matches if EITHER field matches (OR).
    // When only one is restricted, the '*' field means "any" and normal AND applies.
    const matchDay =
      fields.dayOfMonth !== null && fields.dayOfWeek !== null
        ? fields.dayOfMonth.includes(dayOfMonth) || fields.dayOfWeek.includes(dayOfWeek)
        : matchDom && matchDow;

    if (matchMinute && matchHour && matchDay && matchMonth) {
      return Math.floor(cursor.getTime() / 1000);
    }

    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  throw new Error(`No matching cron time found within 366 days for: ${expression}`);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Convert a cron expression to a human-readable string. Best-effort for common patterns.
 * NOTE: A client-side copy lives in console/src/components/line-detail/scheduled-utils.ts
 * because the console cannot import Node modules. Keep both in sync.
 */
export function cronToHuman(expression: string): string {
  const fields = parseCron(expression);
  const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;

  // Every N minutes: */N * * * *
  if (minute !== null && hour === null && dayOfMonth === null && month === null && dayOfWeek === null) {
    if (minute.length > 1 && minute[0] === 0) {
      const step = minute[1] - minute[0];
      const isStep = minute.every((v, i) => v === i * step);
      if (isStep) return step === 1 ? 'Every minute' : `Every ${step} minutes`;
    }
  }

  // Format time part
  const timeStr = (h: number[], m: number[]) => {
    if (h.length === 1 && m.length === 1) {
      return `${String(h[0]).padStart(2, '0')}:${String(m[0]).padStart(2, '0')}`;
    }
    return null;
  };

  if (hour !== null && minute !== null) {
    const time = timeStr(hour, minute);
    if (time) {
      // Daily: 0 9 * * *
      if (dayOfMonth === null && month === null && dayOfWeek === null) {
        return `Daily at ${time}`;
      }
      // Weekly: 0 9 * * 1
      if (dayOfMonth === null && month === null && dayOfWeek !== null && dayOfWeek.length === 1) {
        return `Weekly on ${DAY_NAMES[dayOfWeek[0]]} at ${time}`;
      }
      // Monthly: 0 9 1 * *
      if (dayOfMonth !== null && dayOfMonth.length === 1 && month === null && dayOfWeek === null) {
        return `Monthly on day ${dayOfMonth[0]} at ${time}`;
      }
    }
  }

  // Fallback: show raw
  return `Cron: ${expression}`;
}
