import { DEFAULT_WAGE_SETTINGS, type WageSettings } from "./types";

const DB_NAME = "dienstenlezer-private-client";
const DB_VERSION = 1;
const STORE_NAME = "wage-settings";

export async function readWageSettings(accountId: string): Promise<WageSettings> {
  const value = await request<WageSettings | undefined>("readonly", (store) => store.get(accountId));
  return value ? normalizeWageSettings(value) : { ...DEFAULT_WAGE_SETTINGS };
}

export async function writeWageSettings(accountId: string, settings: WageSettings): Promise<void> {
  await request("readwrite", (store) => store.put(normalizeWageSettings(settings), accountId));
}

export async function deleteWageSettings(accountId: string): Promise<void> {
  await request("readwrite", (store) => store.delete(accountId));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME)) {
        open.result.createObjectStore(STORE_NAME);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function request<T>(mode: IDBTransactionMode, create: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const operation = create(transaction.objectStore(STORE_NAME));
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function normalizeWageSettings(value: WageSettings): WageSettings {
  return {
    hourlyRateCents: boundedNumber(value.hourlyRateCents, 0, 100_000),
    holidayAllowancePercent: boundedNumber(value.holidayAllowancePercent, 0, 100),
    vacationDaysAllowancePercent: boundedNumber(value.vacationDaysAllowancePercent, 0, 100),
  };
}

function boundedNumber(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}
