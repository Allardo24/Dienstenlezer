export type WageSettings = {
  hourlyRateCents: number;
  holidayAllowancePercent: number;
  vacationDaysAllowancePercent: number;
};

export type WageEstimate = {
  earnedCents: number;
  totalCents: number;
  elapsedPaidMinutes: number;
  totalPaidMinutes: number;
};

export const DEFAULT_WAGE_SETTINGS: WageSettings = {
  hourlyRateCents: 0,
  holidayAllowancePercent: 8,
  vacationDaysAllowancePercent: 10.92,
};
