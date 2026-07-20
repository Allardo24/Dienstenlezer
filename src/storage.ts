import type {
  DaySegment,
  StoredPdfCatalog,
  StoredPdfFile,
  StoredPdfFileSummary,
  StoredSchedule,
} from "./types";
import { serverUrl } from "./serverUrl";

const DB_NAME = "dienstenlezer";
const DB_VERSION = 1;
const FILE_STORE = "pdfFiles";
const CACHE_DB_NAME = "dienstenlezer-server-cache";
const CACHE_DB_VERSION = 1;
const CATALOG_STORE = "catalog";
const SCHEDULE_STORE = "schedules";
const STORAGE_SCHEMA_VERSION = 2;

function usesServerStorage(): boolean {
  return typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
}

async function serverRequest(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(serverUrl(path), init);
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(payload?.error ?? `Bestandenbackend gaf HTTP ${response.status}.`);
  }
  return response;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openCacheDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CATALOG_STORE)) {
        db.createObjectStore(CATALOG_STORE);
      }
      if (!db.objectStoreNames.contains(SCHEDULE_STORE)) {
        db.createObjectStore(SCHEDULE_STORE, { keyPath: "segment" });
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

  if (usesServerStorage()) {
    const response = await serverRequest("/api/files/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentHashes }),
    });
    const payload = await response.json() as { existing: string[] };
    return new Set(payload.existing);
  }

  const files = await getLocalStoredPdfFiles();
  return new Set(files.map((file) => file.contentHash).filter((value): value is string => Boolean(value)));
}

export async function getStoredPdfCatalog(): Promise<StoredPdfCatalog> {
  if (usesServerStorage()) {
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

  const files = await getLocalStoredPdfFiles();
  return localCatalog(files);
}

export async function getCachedStoredData(
  segment: DaySegment,
): Promise<{ catalog: StoredPdfCatalog; schedule: StoredSchedule } | undefined> {
  if (!usesServerStorage()) {
    return undefined;
  }

  const [catalog, schedule] = await Promise.all([
    readCacheValue<StoredPdfCatalog>(CATALOG_STORE, "current"),
    readCacheValue<StoredSchedule>(SCHEDULE_STORE, segment),
  ]);
  if (
    catalog?.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    schedule?.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    schedule.revision !== catalog.segmentRevisions[segment]
  ) {
    return undefined;
  }
  return { catalog, schedule };
}

export async function getStoredSchedule(segment: DaySegment, expectedRevision: string): Promise<StoredSchedule> {
  if (usesServerStorage()) {
    const cached = await readCacheValue<StoredSchedule>(SCHEDULE_STORE, segment);
    if (cached?.schemaVersion === STORAGE_SCHEMA_VERSION && cached.revision === expectedRevision) {
      return cached;
    }

    try {
      const response = await serverRequest(`/api/schedules/${encodeURIComponent(segment)}`, { cache: "no-cache" });
      const schedule = await response.json() as StoredSchedule;
      await writeCacheValue(SCHEDULE_STORE, segment, schedule);
      return schedule;
    } catch (error) {
      if (cached?.schemaVersion === STORAGE_SCHEMA_VERSION) {
        return cached;
      }
      throw error;
    }
  }

  const files = await getLocalStoredPdfFiles();
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    segment,
    revision: localSegmentRevision(files, segment),
    results: files.filter((file) => file.enabled && file.daySegment === segment).map((file) => file.parseResult),
  };
}

export async function saveStoredPdfFile(file: StoredPdfFile): Promise<void> {
  if (usesServerStorage()) {
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
      daySegment: file.daySegment,
      contentHash: file.contentHash,
      parseResult: file.parseResult,
    };
    const body = new FormData();
    body.append("metadata", JSON.stringify(metadata));
    body.append("pdf", file.file, file.name);
    await serverRequest("/api/files", { method: "POST", body });
    return;
  }

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readwrite");
    transaction.objectStore(FILE_STORE).put(file);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function updateStoredPdfFileEnabled(id: string, enabled: boolean): Promise<void> {
  if (usesServerStorage()) {
    await updateServerFile(id, { enabled });
    return;
  }
  await updateLocalFile(id, (file) => ({ ...file, enabled }));
}

export async function updateStoredPdfFileDaySegment(id: string, daySegment: DaySegment): Promise<void> {
  if (usesServerStorage()) {
    await updateServerFile(id, { daySegment });
    return;
  }
  await updateLocalFile(id, (file) => ({ ...file, daySegment }));
}

export async function deleteStoredPdfFile(id: string): Promise<void> {
  if (usesServerStorage()) {
    await serverRequest(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
    return;
  }

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readwrite");
    transaction.objectStore(FILE_STORE).delete(id);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getLocalStoredPdfFiles(): Promise<StoredPdfFile[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readonly");
    const request = transaction.objectStore(FILE_STORE).getAll();

    request.onsuccess = () => {
      resolve(
        (request.result as StoredPdfFile[])
          .map((file) => ({ ...file, daySegment: file.daySegment ?? "unassigned" }))
          .sort((first, second) => second.uploadedAt - first.uploadedAt || first.name.localeCompare(second.name, "nl", { numeric: true })),
      );
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

function localCatalog(files: StoredPdfFile[]): StoredPdfCatalog {
  const summaries = files.map(toSummary);
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    revision: `local-${files.map((file) => `${file.id}:${file.enabled}:${file.daySegment}`).join("|")}`,
    segmentRevisions: {
      weekday: localSegmentRevision(files, "weekday"),
      saturday: localSegmentRevision(files, "saturday"),
      sunday: localSegmentRevision(files, "sunday"),
      unassigned: localSegmentRevision(files, "unassigned"),
    },
    files: summaries,
  };
}

function localSegmentRevision(files: StoredPdfFile[], segment: DaySegment): string {
  return `local-${segment}-${files
    .filter((file) => file.enabled && file.daySegment === segment)
    .map((file) => `${file.id}:${file.lastModified}`)
    .join("|")}`;
}

function toSummary(file: StoredPdfFile): StoredPdfFileSummary {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    uploadedAt: file.uploadedAt,
    enabled: file.enabled,
    daySegment: file.daySegment,
    contentHash: file.contentHash,
    serviceCount: file.parseResult.diensten.length,
    movementCount: file.parseResult.movements.length,
  };
}

async function updateLocalFile(id: string, update: (file: StoredPdfFile) => StoredPdfFile): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readwrite");
    const store = transaction.objectStore(FILE_STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const file = request.result as StoredPdfFile | undefined;
      if (file) {
        store.put(update(file));
      }
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function updateServerFile(id: string, patch: { enabled?: boolean; daySegment?: DaySegment }): Promise<void> {
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
