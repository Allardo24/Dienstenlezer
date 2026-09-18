import type {
  AdminSettings,
  DaySegment,
  StoredPdfCatalog,
  StoredPdfFile,
  StoredPdfFileSummary,
  StoredSchedule,
  OrganizationConfig,
} from "./types";
import { serverUrl } from "./serverUrl";
import { withAuth } from "./auth";
import { fetchWithRetry } from "./fetchRetry";
import {
  normalizeOrganization,
  scheduleSelectionKey,
} from "./organization";
import {
  normaliseBuslessActions,
} from "./buslessActions";
import { normaliseOrtRates } from "./wage/rules";

const CACHE_DB_NAME = "dienstenlezer-server-cache";
const CACHE_DB_VERSION = 2;
const CATALOG_STORE = "catalog";
const SCHEDULE_STORE = "schedules";
const STORAGE_SCHEMA_VERSION = 4;

async function serverRequest(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetchWithRetry(serverUrl(path), withAuth(init));
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(payload?.error ?? `Bestandenbackend gaf HTTP ${response.status}.`);
  }
  return response;
}

function openCacheDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CATALOG_STORE)) {
        db.createObjectStore(CATALOG_STORE);
      }
      if (
        db.objectStoreNames.contains(SCHEDULE_STORE)
        && request.transaction?.objectStore(SCHEDULE_STORE).keyPath !== "key"
      ) {
        db.deleteObjectStore(SCHEDULE_STORE);
      }
      if (!db.objectStoreNames.contains(SCHEDULE_STORE)) {
        db.createObjectStore(SCHEDULE_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createStoredFileId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export async function createPdfContentHash(file: File): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) {
    return undefined;
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function findExistingPdfHashes(contentHashes: string[]): Promise<Set<string>> {
  if (contentHashes.length === 0) {
    return new Set();
  }

  const response = await serverRequest("/api/files/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentHashes }),
  });
  const payload = await response.json() as { existing: string[] };
  return new Set(payload.existing);
}

export async function getStoredPdfCatalog(): Promise<StoredPdfCatalog> {
  try {
    const response = await serverRequest("/api/catalog", { cache: "no-cache" });
    const catalog = await response.json() as StoredPdfCatalog;
    await writeCacheValue(CATALOG_STORE, "current", catalog);
    return catalog;
  } catch (error) {
    const cached = await readCacheValue<StoredPdfCatalog>(CATALOG_STORE, "current");
    if (cached?.schemaVersion === STORAGE_SCHEMA_VERSION) {
      return cached;
    }
    throw error;
  }
}

export async function getCachedStoredData(
  segment: DaySegment,
  divisionIds: string[],
): Promise<{ catalog: StoredPdfCatalog; schedule: StoredSchedule } | undefined> {
  const key = scheduleSelectionKey(segment, divisionIds);
  const [catalog, schedule] = await Promise.all([
    readCacheValue<StoredPdfCatalog>(CATALOG_STORE, "current"),
    readCacheValue<StoredSchedule>(SCHEDULE_STORE, key),
  ]);
  if (
    catalog?.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    schedule?.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    schedule.catalogRevision !== catalog.revision
  ) {
    return undefined;
  }
  return { catalog, schedule };
}

export async function getStoredSchedule(
  segment: DaySegment,
  divisionIds: string[],
  catalogRevision: string,
): Promise<StoredSchedule> {
  const normalizedDivisionIds = [...new Set(divisionIds)].sort();
  const key = scheduleSelectionKey(segment, normalizedDivisionIds);
  const cached = await readCacheValue<StoredSchedule>(SCHEDULE_STORE, key);
  if (cached?.schemaVersion === STORAGE_SCHEMA_VERSION && cached.catalogRevision === catalogRevision) {
    return cached;
  }

  try {
    const params = new URLSearchParams({ divisions: normalizedDivisionIds.join(",") });
    const response = await serverRequest(`/api/schedules/${encodeURIComponent(segment)}?${params}`, { cache: "no-cache" });
    const schedule = await response.json() as StoredSchedule;
    await writeCacheValue(SCHEDULE_STORE, key, schedule);
    return schedule;
  } catch (error) {
    if (cached?.schemaVersion === STORAGE_SCHEMA_VERSION) {
      return cached;
    }
    throw error;
  }
}

export async function saveStoredPdfFile(file: StoredPdfFile): Promise<void> {
  if (!file.file) {
    throw new Error("Het te uploaden pdf-bestand ontbreekt.");
  }
  const metadata = {
    id: file.id,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    uploadedAt: file.uploadedAt,
    enabled: file.enabled,
    expiresOn: file.expiresOn,
    daySegment: file.daySegment,
    divisionId: file.divisionId,
    contentHash: file.contentHash,
    parseResult: file.parseResult,
  };
  const body = new FormData();
  body.append("metadata", JSON.stringify(metadata));
  body.append("pdf", file.file, file.name);
  await serverRequest("/api/files", { method: "POST", body });
}

export async function updateStoredPdfFileEnabled(id: string, enabled: boolean): Promise<void> {
  await updateServerFile(id, { enabled });
}

export async function updateStoredPdfFileDaySegment(id: string, daySegment: DaySegment): Promise<void> {
  await updateServerFile(id, { daySegment });
}

export async function updateStoredPdfFileDivision(id: string, divisionId: string): Promise<void> {
  await updateServerFile(id, { divisionId });
}

export async function updateStoredPdfFileExpiry(id: string, expiresOn: string): Promise<void> {
  await updateServerFile(id, { expiresOn });
}

export async function reparseStoredPdfFiles(
  files: StoredPdfFileSummary[],
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  const { parsePdfFiles } = await import("./pdfParser");
  const reparsed: Array<{ id: string; parseResult: StoredPdfFile["parseResult"] }> = [];

  for (const [index, summary] of files.entries()) {
    const response = await serverRequest(`/api/files/${encodeURIComponent(summary.id)}`, { cache: "no-cache" });
    const pdf = new File([await response.blob()], summary.name, {
      type: "application/pdf",
      lastModified: summary.lastModified,
    });
    const [parseResult] = await parsePdfFiles([pdf]);
    assertUsableReparseResult(summary.name, parseResult);
    reparsed.push({ id: summary.id, parseResult });
    onProgress?.(index + 1, files.length);
  }

  for (const file of reparsed) {
    await updateServerFile(file.id, { parseResult: file.parseResult });
  }
}

export function assertUsableReparseResult(
  fileName: string,
  parseResult: StoredPdfFile["parseResult"],
): void {
  if (parseResult.diensten.length > 0 && parseResult.movements.length > 0) {
    return;
  }

  const warning = parseResult.warnings.find((message) => message.trim().length > 0);
  const detail = warning ? ` ${warning}` : "";
  throw new Error(
    `\"${fileName}\" leverde geen bruikbare diensten op. De bestaande gegevens zijn niet vervangen.${detail}`,
  );
}

export async function saveOrganizationConfig(config: OrganizationConfig): Promise<OrganizationConfig> {
  const normalized = normalizeOrganization(config);
  const response = await serverRequest("/api/organization", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalized),
  });
  return normalizeOrganization(await response.json() as OrganizationConfig);
}

export async function saveAdminSettings(settings: AdminSettings): Promise<AdminSettings> {
  const normalized = {
    buslessActions: normaliseBuslessActions(settings.buslessActions),
    ortRates: normaliseOrtRates(settings.ortRates),
  };
  const response = await serverRequest("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalized),
  });
  const saved = await response.json() as AdminSettings;
  return {
    buslessActions: normaliseBuslessActions(saved.buslessActions),
    ortRates: normaliseOrtRates(saved.ortRates),
  };
}

export async function deleteStoredPdfFile(id: string): Promise<void> {
  await serverRequest(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function updateServerFile(
  id: string,
  patch: {
    enabled?: boolean;
    expiresOn?: string;
    daySegment?: DaySegment;
    divisionId?: string;
    parseResult?: StoredPdfFile["parseResult"];
  },
): Promise<void> {
  await serverRequest(`/api/files/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

async function readCacheValue<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openCacheDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function writeCacheValue(storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openCacheDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    if (storeName === CATALOG_STORE) {
      store.put(value, key);
    } else {
      store.put(value);
    }
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}
