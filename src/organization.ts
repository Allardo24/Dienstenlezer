import type { OrganizationConfig } from "./types";

export const DEFAULT_DIVISION_ID = "";
export const LEGACY_DEFAULT_ID = "standaard";

export const DEFAULT_ORGANIZATION: OrganizationConfig = {
  concessions: [],
  divisions: [],
};

export function normalizeOrganization(config?: OrganizationConfig): OrganizationConfig {
  if (!config) {
    return structuredClone(DEFAULT_ORGANIZATION);
  }

  const concessions = uniqueById(config.concessions ?? [])
    .map((concession) => ({ id: concession.id.trim(), name: concession.name.trim() }))
    .filter((concession) => concession.id && concession.name);
  const concessionIds = new Set(concessions.map((concession) => concession.id));
  const divisions = uniqueById(config.divisions ?? [])
    .map((division) => ({
      id: division.id.trim(),
      name: division.name.trim(),
      concessionId: division.concessionId.trim(),
    }))
    .filter((division) => division.id && division.name && concessionIds.has(division.concessionId));

  const isLegacyDefault = concessions.length === 1
    && divisions.length === 1
    && concessions[0].id === LEGACY_DEFAULT_ID
    && divisions[0].id === LEGACY_DEFAULT_ID;
  return isLegacyDefault ? structuredClone(DEFAULT_ORGANIZATION) : { concessions, divisions };
}

export function organizationItemId(name: string, existingIds: string[]): string {
  const base = name
    .trim()
    .toLocaleLowerCase("nl")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "groep";
  const existing = new Set(existingIds);
  if (!existing.has(base)) {
    return base;
  }
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function scheduleSelectionKey(segment: string, divisionIds: string[]): string {
  return `${segment}:${[...new Set(divisionIds)].sort().join(",")}`;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = item.id.trim();
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}
