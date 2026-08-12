export type TakeoverPhase = "no-data" | "expected" | "arrived" | "departed";
export type TakeoverTone = "neutral" | "on-time" | "early" | "late" | "roomy";

export type TakeoverStatus = {
  phase: TakeoverPhase;
  tone: TakeoverTone;
  statusLabel: string;
  minutesToDeparture: number;
  minutesUntilDeparture: number;
  shouldShowTopAlert: boolean;
};

export function resolveTakeoverDeparted({
  currentMinute,
  plannedDepartureMinute,
  expectedArrivalMinute,
  expectedDepartureMinute,
  reportedDeparted,
}: {
  currentMinute: number;
  plannedDepartureMinute: number;
  expectedArrivalMinute: number;
  expectedDepartureMinute?: number;
  reportedDeparted: boolean;
}): boolean {
  // VehiclePositions can briefly carry a stop sequence from an earlier trip.
  // Never let that stale sequence finish a takeover before this bus can arrive.
  if (currentMinute < expectedArrivalMinute) {
    return false;
  }

  if (reportedDeparted) {
    return true;
  }

  if (expectedDepartureMinute === undefined) {
    return false;
  }

  return currentMinute > Math.max(
    plannedDepartureMinute,
    expectedArrivalMinute,
    expectedDepartureMinute,
  );
}

export function resolveTakeoverArrivalMinute({
  plannedArrivalMinute,
  delaySeconds,
  predictedArrivalMinute,
  toleranceMinutes = 15,
}: {
  plannedArrivalMinute: number;
  delaySeconds: number;
  predictedArrivalMinute?: number;
  toleranceMinutes?: number;
}): number {
  const delayedPlannedMinute = plannedArrivalMinute + delaySeconds / 60;
  if (predictedArrivalMinute === undefined) {
    return delayedPlannedMinute;
  }

  let alignedPrediction = predictedArrivalMinute;
  while (alignedPrediction > delayedPlannedMinute + 12 * 60) {
    alignedPrediction -= 24 * 60;
  }
  while (alignedPrediction < delayedPlannedMinute - 12 * 60) {
    alignedPrediction += 24 * 60;
  }

  return Math.abs(alignedPrediction - delayedPlannedMinute) <= toleranceMinutes
    ? alignedPrediction
    : delayedPlannedMinute;
}

export function resolveTakeoverPlannedMinute({
  suppliedPlannedMinute,
  expectedArrivalMinute,
  delaySeconds,
  toleranceMinutes = 1.5,
}: {
  suppliedPlannedMinute: number;
  expectedArrivalMinute: number;
  delaySeconds: number;
  toleranceMinutes?: number;
}): number {
  const impliedPlannedMinute = expectedArrivalMinute - delaySeconds / 60;
  return Math.abs(suppliedPlannedMinute - impliedPlannedMinute) <= toleranceMinutes
    ? suppliedPlannedMinute
    : impliedPlannedMinute;
}

export function calculateTakeoverStatus({
  currentMinute,
  plannedDepartureMinute,
  expectedArrivalMinute,
  delaySeconds,
  hasLiveData,
  arrived,
  departed,
}: {
  currentMinute: number;
  plannedDepartureMinute: number;
  expectedArrivalMinute: number;
  delaySeconds: number;
  hasLiveData: boolean;
  arrived: boolean;
  departed: boolean;
}): TakeoverStatus {
  const minutesToDeparture = Math.ceil(plannedDepartureMinute - expectedArrivalMinute);
  const minutesUntilDeparture = Math.ceil(plannedDepartureMinute - currentMinute);
  const delayed = delaySeconds > 60;
  const early = delaySeconds < -60;
  const roomy = delayed && minutesToDeparture > 7;
  const risky = delayed && minutesToDeparture <= 7;
  const phase: TakeoverPhase = departed
    ? "departed"
    : arrived
      ? "arrived"
      : hasLiveData
        ? "expected"
        : "no-data";
  const tone: TakeoverTone = phase === "no-data" || phase === "departed"
    ? "neutral"
    : risky
      ? "late"
      : early
        ? "early"
        : roomy
          ? "roomy"
          : "on-time";
  const statusLabel = phase === "departed"
    ? "Overname afgerond"
    : phase === "arrived"
      ? "Aangekomen"
      : tone === "late"
        ? "Te laat"
        : tone === "early"
          ? "Te vroeg"
          : tone === "roomy"
            ? "Vertraagd, voldoende tijd"
            : tone === "on-time"
              ? "Op tijd"
              : "";

  return {
    phase,
    tone,
    statusLabel,
    minutesToDeparture,
    minutesUntilDeparture,
    shouldShowTopAlert: hasLiveData
      && phase !== "departed"
      && minutesUntilDeparture <= 10
      && !roomy,
  };
}
