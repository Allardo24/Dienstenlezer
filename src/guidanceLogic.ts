export type DutyVehicleInterval = {
  loop: string;
  serviceNumber: string;
  start: number;
  end: number;
};

export function hasInterveningDriver(
  previous: DutyVehicleInterval,
  current: DutyVehicleInterval,
  candidates: DutyVehicleInterval[],
): boolean {
  if (previous.loop !== current.loop || current.start <= previous.end) {
    return false;
  }

  const currentService = current.serviceNumber.trim().toLowerCase();
  return candidates.some((candidate) => (
    candidate.loop === current.loop
    && candidate.serviceNumber.trim().toLowerCase() !== currentService
    && candidate.start < current.start
    && candidate.end > previous.end
  ));
}
