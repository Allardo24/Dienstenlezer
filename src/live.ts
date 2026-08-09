import type { LiveMovementRequest, LiveStatusResponse } from "./types";
import { serverUrl } from "./serverUrl";

const webLiveEtags = new Map<string, string>();
const webLiveResponses = new Map<string, LiveStatusResponse>();
const LIVE_CACHE_PREFIX = "dienstenlezer-live-v1:";
const LIVE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StoredLiveResponse = {
  savedAt: number;
  response: LiveStatusResponse;
};

export type CachedLiveResponse = StoredLiveResponse;

export function getCachedQbuzzLiveStatuses(
  date: string,
  divisionIdsOrNow: string[] | number = [],
  requestedNow = Date.now(),
): CachedLiveResponse | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const divisionIds = Array.isArray(divisionIdsOrNow) ? divisionIdsOrNow : [];
  const now = typeof divisionIdsOrNow === "number" ? divisionIdsOrNow : requestedNow;
  try {
    const key = liveScopeKey(date, divisionIds);
    const raw = window.localStorage.getItem(`${LIVE_CACHE_PREFIX}${key}`);
    if (!raw) {
      return undefined;
    }
    const cached = JSON.parse(raw) as StoredLiveResponse;
    if (!cached.savedAt || !cached.response?.statuses || now - cached.savedAt > LIVE_CACHE_MAX_AGE_MS) {
      window.localStorage.removeItem(`${LIVE_CACHE_PREFIX}${key}`);
      return undefined;
    }
    return cached;
  } catch {
    return undefined;
  }
}

function storeCachedQbuzzLiveStatuses(date: string, divisionIds: string[], response: LiveStatusResponse) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const cached: StoredLiveResponse = { savedAt: Date.now(), response };
    window.localStorage.setItem(`${LIVE_CACHE_PREFIX}${liveScopeKey(date, divisionIds)}`, JSON.stringify(cached));
  } catch {
    // Live blijft werken als de browseropslag vol of uitgeschakeld is.
  }
}

function retainKnownVehicleIds(date: string, divisionIds: string[], response: LiveStatusResponse): LiveStatusResponse {
  const cached = getCachedQbuzzLiveStatuses(date, divisionIds);
  if (!cached) {
    return response;
  }

  const knownVehicles = new Map(
    cached.response.statuses
      .filter((status) => status.vehicleId)
      .map((status) => [status.movementId, status.vehicleId]),
  );
  return {
    ...response,
    statuses: response.statuses.map((status) => status.vehicleId
      ? status
      : { ...status, vehicleId: knownVehicles.get(status.movementId) }),
  };
}

export async function getQbuzzLiveStatuses(
  date: string,
  _movements: LiveMovementRequest[],
  divisionIds: string[] = [],
): Promise<LiveStatusResponse> {
  const scopeKey = liveScopeKey(date, divisionIds);
  const headers = new Headers();
  const knownEtag = webLiveEtags.get(scopeKey);
  if (knownEtag) {
    headers.set("If-None-Match", knownEtag);
  }
  const params = new URLSearchParams({ date });
  params.set("divisions", [...new Set(divisionIds)].sort().join(","));
  const response = await fetch(serverUrl(`/api/qbuzz/live?${params}`), {
    method: "GET",
    headers,
    cache: "no-cache",
  });
  if (response.status === 304) {
    const cached = webLiveResponses.get(scopeKey);
    if (cached) {
      const fetchedAtHeader = response.headers.get("X-DienstenLezer-Live-Fetched-At");
      const fetchedAt = fetchedAtHeader ? Number(fetchedAtHeader) : cached.sync.fetchedAt;
      const refreshed = {
        ...cached,
        sync: {
          ...cached.sync,
          state: "ready" as const,
          fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : cached.sync.fetchedAt,
        },
      };
      webLiveResponses.set(scopeKey, refreshed);
      storeCachedQbuzzLiveStatuses(date, divisionIds, refreshed);
      return refreshed;
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(payload?.error ?? `Live-backend gaf HTTP ${response.status}.`);
  }
  const result = retainKnownVehicleIds(date, divisionIds, await response.json() as LiveStatusResponse);
  const etag = response.headers.get("ETag");
  if (etag) {
    webLiveEtags.set(scopeKey, etag);
    webLiveResponses.set(scopeKey, result);
  }
  storeCachedQbuzzLiveStatuses(date, divisionIds, result);
  return result;
}

function liveScopeKey(date: string, divisionIds: string[]): string {
  return `${date}:${[...new Set(divisionIds)].sort().join(",")}`;
}

export function plannedMarkerMinute(currentMinute: number, delaySeconds: number, startMinute: number, endMinute: number): number | undefined {
  if (Math.abs(delaySeconds) <= 60) {
    return undefined;
  }

  const markerMinute = currentMinute - delaySeconds / 60;
  return markerMinute >= startMinute && markerMinute <= endMinute ? markerMinute : undefined;
}
