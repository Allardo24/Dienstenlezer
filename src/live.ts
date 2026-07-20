import type { LiveMovementRequest, LiveStatusResponse, LiveSyncState } from "./types";

const webLiveEtags = new Map<string, string>();
const webLiveResponses = new Map<string, LiveStatusResponse>();

export function isDesktopLiveAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getQbuzzLiveStatuses(date: string, movements: LiveMovementRequest[]): Promise<LiveStatusResponse> {
  if (isDesktopLiveAvailable()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<LiveStatusResponse>("get_qbuzz_live_statuses", { date, movements });
  }

  const headers = new Headers();
  const knownEtag = webLiveEtags.get(date);
  if (knownEtag) {
    headers.set("If-None-Match", knownEtag);
  }
  const response = await fetch(`/api/qbuzz/live?date=${encodeURIComponent(date)}`, {
    method: "GET",
    headers,
    cache: "no-cache",
  });
  if (response.status === 304) {
    const cached = webLiveResponses.get(date);
    if (cached) {
      return cached;
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(payload?.error ?? `Live-backend gaf HTTP ${response.status}.`);
  }
  const result = await response.json() as LiveStatusResponse;
  const etag = response.headers.get("ETag");
  if (etag) {
    webLiveEtags.set(date, etag);
    webLiveResponses.set(date, result);
  }
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
