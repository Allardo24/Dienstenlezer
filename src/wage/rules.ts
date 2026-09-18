import type { OrtRates } from "../types";

const SUNDAY = 0;
const SATURDAY = 6;

export const DEFAULT_ORT_RATES: OrtRates = {
  weekdayEarlyPercent: 15,
  weekdayEveningPercent: 30,
  saturdayPercent: 30,
  nightPercent: 40,
  sundayPercent: 45,
  sundayNightPercent: 55,
};

export function normaliseOrtRates(rates?: Partial<OrtRates>): OrtRates {
  return Object.fromEntries(
    Object.entries(DEFAULT_ORT_RATES).map(([key, fallback]) => {
      const value = Number(rates?.[key as keyof OrtRates]);
      return [key, Number.isFinite(value) && value >= 0 && value <= 500 ? Math.round(value) : fallback];
    }),
  ) as OrtRates;
}

export function irregularHoursPercent(
  at: Date,
  dutyStartedOnSunday: boolean,
  rates: OrtRates = DEFAULT_ORT_RATES,
): number {
  const day = at.getDay();
  const minute = at.getHours() * 60 + at.getMinutes();

  if (day === SUNDAY) {
    return minute < 5 * 60 + 30 ? rates.sundayNightPercent : rates.sundayPercent;
  }
  if (dutyStartedOnSunday && day >= 1 && day <= 5 && minute < 6 * 60) {
    return rates.sundayPercent;
  }
  if (minute < 5 * 60 + 30) {
    return rates.nightPercent;
  }
  if (day === SATURDAY) {
    return rates.saturdayPercent;
  }
  if (minute < 6 * 60) {
    return rates.weekdayEveningPercent;
  }
  if (minute < 7 * 60 + 30) {
    return rates.weekdayEarlyPercent;
  }
  if (minute >= 19 * 60) {
    return rates.weekdayEveningPercent;
  }
  return 0;
}
