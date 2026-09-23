import type { Dienst, Movement } from "./types";

export function belongsToLockedDuty(movement: Movement, service?: Dienst, personalMovements?: Movement[]): boolean {
  if (!service) return false;
  if (!personalMovements) {
    return movement.dienstnummer.toLowerCase() === service.serviceNumber.toLowerCase()
      && movement.sourceFileId === service.sourceFileId
      && movement.divisionId === service.divisionId;
  }
  // Personal duties have their own source IDs; match the actual trip, not its original duty number.
  return personalMovements.some((own) => own.type === "rit" && movement.type === "rit"
    && Boolean(own.ritnummer) && Boolean(own.omloopnummer)
    && own.divisionId === movement.divisionId
    && own.lijnnummer === movement.lijnnummer && own.ritnummer === movement.ritnummer
    && own.omloopnummer === movement.omloopnummer
    && own.vertrek === movement.vertrek && own.aankomst === movement.aankomst);
}
