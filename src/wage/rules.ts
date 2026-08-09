const SUNDAY = 0;
const SATURDAY = 6;

export function irregularHoursPercent(at: Date, dutyStartedOnSunday: boolean): number {
  const day = at.getDay();
  const minute = at.getHours() * 60 + at.getMinutes();

  if (day === SUNDAY) {
    return minute < 5 * 60 + 30 ? 55 : 45;
  }
  if (dutyStartedOnSunday && day >= 1 && day <= 5 && minute < 6 * 60) {
    return 45;
  }
  if (minute < 5 * 60 + 30) {
    return 40;
  }
  if (day === SATURDAY) {
    return 30;
  }
  if (minute < 6 * 60) {
    return 30;
  }
  if (minute < 7 * 60 + 30) {
    return 15;
  }
  if (minute >= 19 * 60) {
    return 30;
  }
  return 0;
}
