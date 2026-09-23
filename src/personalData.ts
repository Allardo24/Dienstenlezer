import { accountRequest } from "./auth";

export type DutyRecord = {
  depot?: string | null;
  id: string;
  operationalDate: string;
  sourceFileId: string;
  divisionId: string;
  serviceNumber: string;
  startMinute: number;
  endMinute: number;
  origin: "guidance" | "manual" | "admin";
  confirmedAt: number;
};

export type DutyExportRow = {
  depot?: string | null;
  operationalDate: string;
  divisionId: string;
  serviceNumber: string;
  dutyStartMinute: number;
  dutyEndMinute: number;
  origin: string;
  confirmedAt: number;
  segmentSequence?: number;
  movementType?: string;
  lineNumber?: string;
  tripNumber?: string;
  materialType?: string;
  segmentStartMinute?: number;
  segmentEndMinute?: number;
  durationMinutes?: number;
  unpaid?: boolean;
  sourceMovementId?: string;
  sourceFileId: string;
};

export type LineMinutes = { divisionId: string; lineNumber: string; minutes: number };
export type MaterialTypeMinutes = { materialType: string; minutes: number };

export type PersonalStatistics = {
  dutyCount: number;
  totalLineMinutes: number;
  pauseMinutes: number;
  materialMinutes: number;
  uniqueLines: number;
  longestDutyMinutes: number;
  earliestStartMinute?: number;
  latestEndMinute?: number;
  lineMinutes: LineMinutes[];
  materialTypeMinutes: MaterialTypeMinutes[];
};

export type AchievementCondition =
  | { kind: "group"; operator: "all" | "any"; conditions: AchievementCondition[] }
  | {
      kind: "metric";
      metric: "totalMinutes" | "pauseMinutes" | "materialMinutes" | "dutyCount" | "uniqueLines" | "lineMinutes" | "fullDutyMaterial" | "fullDutyLines";
      lines: string[];
      materialTypes?: string[];
      divisionId?: string;
      depot?: string;
      withinSingleDuty?: boolean;
      consecutive?: boolean;
      comparison: "gt" | "gte" | "lt" | "lte" | "eq" | "between";
      value: number;
      maxValue?: number;
    };

export type AchievementDefinition = {
  id: string;
  title: string;
  description: string;
  badge: string;
  enabled: boolean;
  version: number;
  condition: AchievementCondition;
};

export type EarnedAchievement = Omit<AchievementDefinition, "enabled" | "condition"> & { earnedAt: number };

export type AchievementProgress = {
  id: string;
  title: string;
  description: string;
  badge: string;
  current: number;
  target: number;
  unit: "min" | "diensten" | "lijnen" | "voorwaarden";
};

export async function listDuties(): Promise<DutyRecord[]> {
  return jsonRequest("/api/me/duties");
}

export async function exportDuties(): Promise<DutyExportRow[]> {
  return jsonRequest("/api/me/duties/export");
}

export async function confirmDuty(input: {
  operationalDate: string;
  sourceFileId: string;
  serviceNumber: string;
  origin?: "guidance" | "manual";
}): Promise<DutyRecord> {
  return jsonRequest("/api/me/duties", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteDuty(id: string): Promise<void> {
  await accountRequest(`/api/me/duties/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getPersonalStatistics(): Promise<PersonalStatistics> {
  return jsonRequest("/api/me/statistics");
}

export async function getEarnedAchievements(): Promise<EarnedAchievement[]> {
  return jsonRequest("/api/me/achievements");
}

export async function getAchievementProgress(): Promise<AchievementProgress[]> {
  return jsonRequest("/api/me/achievements/progress");
}

export async function getAccountAchievements(accountId: string): Promise<EarnedAchievement[]> {
  return jsonRequest(`/api/admin/accounts/${encodeURIComponent(accountId)}/achievements`);
}

export async function revokeAccountAchievement(accountId: string, achievementId: string): Promise<void> {
  await accountRequest(
    `/api/admin/accounts/${encodeURIComponent(accountId)}/achievements/${encodeURIComponent(achievementId)}`,
    { method: "DELETE" },
  );
}

export async function listAchievementDefinitions(): Promise<AchievementDefinition[]> {
  return jsonRequest("/api/admin/achievements");
}

export async function saveAchievement(input: Omit<AchievementDefinition, "version">): Promise<AchievementDefinition> {
  return jsonRequest("/api/admin/achievements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteAchievementDefinition(achievementId: string): Promise<void> {
  await accountRequest(`/api/admin/achievements/${encodeURIComponent(achievementId)}`, {
    method: "DELETE",
  });
}

export async function revokeAchievementForAll(achievementId: string): Promise<void> {
  await accountRequest(`/api/admin/achievements/${encodeURIComponent(achievementId)}/awards`, {
    method: "DELETE",
  });
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await accountRequest(path, init);
  return response.json() as Promise<T>;
}
