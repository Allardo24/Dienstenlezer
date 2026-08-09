import type { Movement, MovementType } from "./types";

export function extractMaterialType(raw: string): string | undefined {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (/^bus\s+(?:parkeren|naar\s+lader|van(?:\s+lader)?|aan\s+lader|staat\s+voor\s+pantograaf)\b/i.test(normalized)) {
    return undefined;
  }
  if (!/(?:\bbus\b|\biveco\b|\bvolvo\b|\byutong\b|\bebusco\b|\bvdl\b|\bwaterstof\b|\belektrische\b)/i.test(normalized)) {
    return undefined;
  }
  const cleaned = normalized
    .replace(/^meenemen\s+/i, "")
    .replace(/\s+(?:van|voor)\s+dienst\s+\S+.*$/i, "")
    .replace(/\s+op\s+perron\s+\S+$/i, "")
    .trim();
  return cleaned || undefined;
}

export function propagateMaterialByLoop(movements: Movement[]): Movement[] {
  const grouped = new Map<string, Movement[]>();
  for (const movement of movements) {
    const loop = movement.omloopnummer?.trim();
    if (!loop || !isVehicleMovement(movement.type)) continue;
    const key = `${movement.sourceFile}\u0000${movement.datum ?? ""}\u0000${loop}`;
    grouped.set(key, [...(grouped.get(key) ?? []), movement]);
  }

  for (const loopMovements of grouped.values()) {
    let currentMaterialType: string | undefined;
    for (const movement of [...loopMovements].sort((left, right) => {
      return operationalMinute(left.vertrek) - operationalMinute(right.vertrek) || left.id.localeCompare(right.id);
    })) {
      currentMaterialType = movement.materieelsoort ?? currentMaterialType;
      if (!movement.materieelsoort && currentMaterialType) movement.materieelsoort = currentMaterialType;
      if (isBusReturnedToGarage(movement.raw, movement.van, movement.naar)) currentMaterialType = undefined;
    }
  }
  return movements;
}

export function isVehicleMovement(type: MovementType): boolean {
  return type === "rit" || type === "materiaal";
}

function operationalMinute(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  const value = hours * 60 + minutes;
  return value < 4 * 60 ? value + 24 * 60 : value;
}

function isBusReturnedToGarage(raw: string, van: string, naar: string): boolean {
  return `${raw} ${van} ${naar}`.toLowerCase().includes("bus aan lader");
}
