import type { LiveMovementRequest, LiveStatusResponse, LiveSyncState } from "./types";
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

export function getCachedQbuzzLiveStatuses(date: string, now = Date.now()): CachedLiveResponse | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(`${LIVE_CACHE_PREFIX}${date}`);
    if (!raw) {
      return undefined;
    }
    const cached = JSON.parse(raw) as StoredLiveResponse;
    if (!cached.savedAt || !cached.response?.statuses || now - cached.savedAt > LIVE_CACHE_MAX_AGE_MS) {
      window.localStorage.removeItem(`${LIVE_CACHE_PREFIX}${date}`);
      return undefined;
    }
    return cached;
  } catch {
    return undefined;
  }
}

function storeCachedQbuzzLiveStatuses(date: string, response: LiveStatusResponse) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const cached: StoredLiveResponse = { savedAt: Date.now(), response };
    window.localStorage.setItem(`${LIVE_CACHE_PREFIX}${date}`, JSON.stringify(cached));
  } catch {
    // Live blijft werken als de browseropslag vol of uitgeschakeld is.
  }
}

function retainKnownVehicleIds(date: string, response: LiveStatusResponse): LiveStatusResponse {
  const cached = getCachedQbuzzLiveStatuses(date);
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

export function isDesktopLiveAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getQbuzzLiveStatuses(date: string, movements: LiveMovementRequest[]): Promise<LiveStatusResponse> {
  if (isDesktopLiveAvailable()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = retainKnownVehicleIds(
      date,
      await invoke<LiveStatusResponse>("get_qbuzz_live_statuses", { date, movements }),
    );
    storeCachedQbuzzLiveStatuses(date, result);
    return result;
  }

  const headers = new Headers();
  const knownEtag = webLiveEtags.get(date);
  if (knownEtag) {
    headers.set("If-None-Match", knownEtag);
  }
  const response = await fetch(serverUrl(`/api/qbuzz/live?date=${encodeURIComponent(date)}`), {
    method: "GET",
    headers,
    cache: "no-cache",
  });
  if (response.status === 304) {
    const cached = webLiveResponses.get(date);
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
      webLiveResponses.set(date, refreshed);
      storeCachedQbuzzLiveStatuses(date, refreshed);
      return refreshed;
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(payload?.error ?? `Live-backend gaf HTTP ${response.status}.`);
  }
  const result = retainKnownVehicleIds(date, await response.json() as LiveStatusResponse);
  const etag = response.headers.get("ETag");
  if (etag) {
    webLiveEtags.set(date, etag);
    webLiveResponses.set(date, result);
  }
  storeCachedQbuzzLiveStatuses(date, result);
  return result;
}

export async function listenToQbuzzSyncProgress(onProgress: (progress: LiveSyncState) => void): Promise<() => void> {
  if (!isDesktopLiveAvailable()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<LiveSyncState>("qbuzz-sync-progress", (event) => onProgress(event.payload));
}

export function plannedMarkerMinute(currentMinute: number, delaySeconds: number, startMinute: number, endMinute: number): number | undefined {
  if (Math.abs(delaySeconds) <= 60) {
    return undefined;
  }

  const markerMinute = currentMinute - delaySeconds / 60;
  return markerMinute >= startMinute && markerMinute <= endMinute ? markerMinute : undefined;
}
