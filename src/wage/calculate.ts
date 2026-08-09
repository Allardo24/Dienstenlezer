import type { Dienst, Movement } from "../types";
import { irregularHoursPercent } from "./rules";
import type { WageEstimate, WageSettings } from "./types";

type MinuteRange = { start: number; end: number };

export function calculateDutyWage(
  service: Dienst,
  movements: Movement[],
  serviceDate: string,
  currentTime: Date,
  settings: WageSettings,
): WageEstimate | undefined {
  if (settings.hourlyRateCents <= 0) {
    return undefined;
  }

  const dutyRange = dutyMinuteRange(service, movements);
  const dateStart = localDateStart(serviceDate);
  if (!dutyRange || !dateStart) {
    return undefined;
  }

  const unpaid = mergeRanges(
    movements
      .filter(isUnpaidRest)
      .map(movementMinuteRange)
      .filter((range): range is MinuteRange => Boolean(range))
      .map((range) => ({
        start: Math.max(range.start, dutyRange.start),
        end: Math.min(range.end, dutyRange.end),
      }))
      .filter((range) => range.end > range.start),
  );
  const currentMinute = Math.floor((currentTime.getTime() - dateStart.getTime()) / 60_000);
  const elapsedEnd = Math.min(dutyRange.end, Math.max(dutyRange.start, currentMinute));
  const dutyStartedAt = new Date(dateStart.getTime() + dutyRange.start * 60_000);
  const dutyStartedOnSunday = dutyStartedAt.getDay() === 0;

  let earnedUnits = 0;
  let totalUnits = 0;
  let elapsedPaidMinutes = 0;
  let totalPaidMinutes = 0;

  for (let minute = dutyRange.start; minute < dutyRange.end; minute += 1) {
    if (isMinuteInRanges(minute, unpaid)) {
      continue;
    }
    const at = new Date(dateStart.getTime() + minute * 60_000);
    const minuteUnits = settings.hourlyRateCents * (100 + irregularHoursPercent(at, dutyStartedOnSunday));
    totalUnits += minuteUnits;
    totalPaidMinutes += 1;
    if (minute < elapsedEnd) {
      earnedUnits += minuteUnits;
      elapsedPaidMinutes += 1;
    }
  }

  return {
    earnedCents: roundHalfUp(earnedUnits, 6_000),
    totalCents: roundHalfUp(totalUnits, 6_000),
    elapsedPaidMinutes,
    totalPaidMinutes,
  };
}

export function dutyMinuteRange(service: Dienst, movements: Movement[]): MinuteRange | undefined {
  const movementRanges = movements
    .map(movementMinuteRange)
    .filter((range): range is MinuteRange => Boolean(range));
  const movementStart = movementRanges.length > 0 ? Math.min(...movementRanges.map((range) => range.start)) : undefined;
  const movementEnd = movementRanges.length > 0 ? Math.max(...movementRanges.map((range) => range.end)) : undefined;
  const serviceStart = operationalMinute(service.start);
  const rawServiceEnd = operationalMinute(service.end);
  const start = serviceStart ?? movementStart;
  let end = rawServiceEnd ?? movementEnd;
  if (start === undefined || end === undefined) {
    return undefined;
  }
  while (end < start) {
    end += 24 * 60;
  }
  return end > start ? { start, end } : undefined;
}

function movementMinuteRange(movement: Movement): MinuteRange | undefined {
  const start = operationalMinute(movement.vertrek);
  let end = operationalMinute(movement.aankomst);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  while (end < start) {
    end += 24 * 60;
  }
  return end > start ? { start, end } : undefined;
}

function operationalMinute(value?: string): number | undefined {
  const match = value?.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return undefined;
  }
  const raw = Number(match[1]) * 60 + Number(match[2]);
  return raw < 4 * 60 ? raw + 24 * 60 : raw;
}

function isUnpaidRest(movement: Movement): boolean {
  return `${movement.van} ${movement.naar} ${movement.raw}`.toLowerCase().includes("onbetaalde rust");
}

function mergeRanges(ranges: MinuteRange[]): MinuteRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MinuteRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function isMinuteInRanges(minute: number, ranges: MinuteRange[]): boolean {
  return ranges.some((range) => minute >= range.start && minute < range.end);
}

function localDateStart(value: string): Date | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return undefined;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator / 2) / denominator);
}
